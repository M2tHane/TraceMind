"""Disk-resumable MinerU task API parsing, adapted from Supie's RAG evaluator.

The original evaluator's content-list/middle-json extraction preserves table and
image captions and discarded page footnotes. No alternative text parser is used.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import tempfile
import time
from collections import defaultdict
from collections.abc import Awaitable, Callable
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit
from weakref import WeakValueDictionary

import httpx
from loguru import logger

from app.services.providers import ProviderError

_POLL_INTERVAL = 2.0
_TASK_TIMEOUT = 3600.0
_HTTP_TIMEOUT = 120.0
_LOCKS: WeakValueDictionary[str, asyncio.Lock] = WeakValueDictionary()


def _error(message: str) -> ProviderError:
    error = ProviderError(message)
    logger.opt(exception=(ProviderError, error, None)).error(
        "MinerU parsing failed: {}", message, exc_info=True
    )
    return error


class _ReadableHTML(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.hidden = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style"}:
            self.hidden += 1
        elif tag in {"br", "p", "tr", "div", "li"} and not self.hidden:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style"}:
            self.hidden = max(0, self.hidden - 1)
        elif not self.hidden:
            if tag in {"td", "th"}:
                self.parts.append(" | ")
            elif tag in {"p", "tr", "table", "div", "li"}:
                self.parts.append("\n")

    def handle_data(self, text: str) -> None:
        if not self.hidden:
            self.parts.append(text)


def strip_html(text: str) -> str:
    """Extract readable text while retaining table cells and paragraph breaks."""
    parser = _ReadableHTML()
    parser.feed(text)
    parser.close()
    return "".join(parser.parts).strip()


def _strings(value: object) -> list[str]:
    if isinstance(value, str):
        return [strip_html(value)] if value.strip() else []
    if isinstance(value, list):
        return [strip_html(item) for item in value if isinstance(item, str) and item.strip()]
    return []


def _block_text(block: dict[str, Any]) -> str:
    kind = block.get("type")
    if kind in {"text", "equation", "page_footnote", "footnote", "title"}:
        text = "\n".join(_strings(block.get("text", "")))
        return "# " + text if text and block.get("text_level") else text
    if kind == "table":
        return "\n".join([*_strings(block.get("table_caption")), *_strings(block.get("table_body")),
                          *_strings(block.get("table_footnote"))])
    if kind == "image":
        return "\n".join([*_strings(block.get("image_caption")), *_strings(block.get("image_footnote"))])
    if kind == "list":
        return "\n".join(_strings(block.get("list_items")))
    # Headers/page numbers are intentionally excluded, not treated as evidence.
    return ""


def _unpack(value: object, expected: type) -> Any:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            raise _error("MinerU returned malformed structured content") from None
    if not isinstance(value, expected):
        raise _error("MinerU returned an unsupported structured content format")
    return value


def _page_index(value: object) -> int:
    if type(value) is not int or value < 0:
        raise _error("MinerU returned an invalid page anchor")
    return value + 1


def _extract(response: dict[str, Any], filename: str) -> dict[str, Any]:
    results = response.get("results")
    if not isinstance(results, dict) or not results:
        raise _error("MinerU returned no document results")
    payload = results.get(Path(filename).stem, results.get(filename))
    if payload is None and len(results) == 1:
        payload = next(iter(results.values()))
    if not isinstance(payload, dict):
        raise _error("MinerU result did not identify the submitted document")
    blocks = _unpack(payload.get("content_list"), list)
    pages: dict[int, list[str]] = defaultdict(list)
    anchors: set[int] = set()
    for block in blocks:
        if not isinstance(block, dict):
            raise _error("MinerU returned an invalid content block")
        page = _page_index(block.get("page_idx"))
        anchors.add(page)
        text = _block_text(block).strip()
        if text:
            pages[page].append(text)
    middle = payload.get("middle_json")
    if middle is not None:
        middle = _unpack(middle, dict)
        page_infos = middle.get("pdf_info", [])
        if not isinstance(page_infos, list):
            raise _error("MinerU returned invalid page metadata")
        for page_info in page_infos:
            if not isinstance(page_info, dict):
                raise _error("MinerU returned invalid page metadata")
            page = _page_index(page_info.get("page_idx"))
            anchors.add(page)
            for block in page_info.get("discarded_blocks", []):
                if block.get("type") != "page_footnote":
                    continue
                text = strip_html(" ".join(
                    str(span.get("content", "")) for line in block.get("lines", [])
                    for span in line.get("spans", [])
                ))
                if text.strip() and text not in pages[page]:
                    pages[page].append(text)
    page_rows = [{"page": page, "text": "\n\n".join(texts)} for page, texts in sorted(pages.items())
                 if any(text.strip() for text in texts)]
    if not page_rows:
        raise _error("MinerU completed but extracted no readable page text")
    # Build Markdown from the same full text as the indexed pages, including footnotes.
    return {"markdown": "\n\n".join(row["text"] for row in page_rows), "pages": page_rows,
            "page_count": max(anchors)}


def _save(path: Path, payload: dict[str, Any]) -> None:
    temp_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=".cache-", suffix=".tmp", delete=False) as handle:
            temp_name = handle.name
            json.dump(payload, handle, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    except (OSError, ValueError, TypeError):
        if temp_name is not None:
            Path(temp_name).unlink(missing_ok=True)
        raise _error("Cannot persist MinerU recovery cache; check local storage") from None


def _load(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise _error("MinerU recovery cache is unreadable; inspect it before retrying") from None
    if not isinstance(payload, dict):
        raise _error("MinerU recovery cache is invalid; inspect it before retrying")
    return payload


def _validated_parsed(payload: dict[str, Any]) -> dict[str, Any]:
    rows = payload.get("pages")
    count = payload.get("page_count")
    if (not isinstance(payload.get("markdown"), str) or not payload["markdown"].strip()
            or not isinstance(rows, list) or not rows or type(count) is not int or count < 1):
        raise _error("Cached MinerU parsed text is invalid")
    for row in rows:
        if (not isinstance(row, dict) or type(row.get("page")) is not int
                or not 1 <= row["page"] <= count or not isinstance(row.get("text"), str)
                or not row["text"].strip()):
            raise _error("Cached MinerU parsed pages are invalid")
    return payload


async def _get(client: httpx.AsyncClient, path: str) -> dict[str, Any]:
    for attempt in range(3):
        try:
            response = await client.get(path)
        except httpx.TransportError:
            if attempt < 2:
                logger.warning("MinerU polling connection interrupted; read-only retry {}", attempt + 1)
                await asyncio.sleep(0.5)
                continue
            raise _error("MinerU polling connection failed; saved task can be resumed") from None
        if response.status_code in {429, 502, 503, 504} and attempt < 2:
            await asyncio.sleep(0.5)
            continue
        if not response.is_success:
            raise _error(f"MinerU read failed (HTTP {response.status_code}); saved task was not resubmitted")
        try:
            payload = response.json()
        except ValueError:
            raise _error("MinerU returned invalid JSON; saved task was not resubmitted") from None
        if not isinstance(payload, dict):
            raise _error("MinerU returned an invalid response object")
        return payload
    raise _error("MinerU read attempts exhausted")


async def _parse_locked(
    pdf_path: Path, folder: Path, base_url: str, pdf_hash: str,
) -> dict[str, Any]:
    parsed_path, result_path, task_path = folder / "parsed.json", folder / "response.json", folder / "task.json"
    if parsed_path.exists():
        return _validated_parsed(_load(parsed_path))
    if result_path.exists():
        parsed = _extract(_load(result_path), pdf_path.name)
        _save(parsed_path, parsed)
        return parsed
    base = base_url.rstrip("/")
    url = urlsplit(base)
    if (url.scheme not in {"http", "https"} or not url.netloc or url.username or url.password
            or url.query or url.fragment):
        raise _error("MinerU URL is not configured correctly")
    endpoint_hash = hashlib.sha256(base.encode()).hexdigest()
    deadline = time.monotonic() + _TASK_TIMEOUT
    async with httpx.AsyncClient(base_url=base + "/", timeout=_HTTP_TIMEOUT, trust_env=False) as client:
        if task_path.exists():
            task = _load(task_path)
            if task.get("pdf_sha256") != pdf_hash or task.get("endpoint_hash") != endpoint_hash:
                raise _error("MinerU task cache belongs to a different PDF or server")
        else:
            try:
                with pdf_path.open("rb") as handle:
                    response = await client.post("tasks", files={"files": (pdf_path.name, handle, "application/pdf")},
                                                 data={"backend": "pipeline", "parse_method": "auto", "lang_list": "ch",
                                                       "formula_enable": "true", "table_enable": "true",
                                                       "image_analysis": "false", "return_md": "true",
                                                       "return_content_list": "true", "return_middle_json": "true",
                                                       "return_images": "false", "response_format_zip": "false"})
            except (httpx.HTTPError, OSError):
                raise _error("MinerU upload failed; submission was not automatically replayed") from None
            if not response.is_success:
                raise _error(f"MinerU rejected PDF submission (HTTP {response.status_code})")
            try:
                task = response.json()
            except ValueError:
                raise _error("MinerU submission returned invalid JSON") from None
            if not isinstance(task, dict) or not isinstance(task.get("task_id"), str) or not task["task_id"]:
                raise _error("MinerU submission returned no task ID")
            task = {"task_id": task["task_id"], "pdf_sha256": pdf_hash, "endpoint_hash": endpoint_hash}
            _save(task_path, task)
        task_id = task.get("task_id")
        if not isinstance(task_id, str) or not task_id:
            raise _error("MinerU cached task ID is invalid")
        task_route = "tasks/" + quote(task_id, safe="")
        while time.monotonic() < deadline:
            status = await _get(client, task_route)
            state = status.get("status")
            if state in {"completed", "succeeded", "success"}:
                result = await _get(client, task_route + "/result")
                _save(result_path, result)
                parsed = _extract(result, pdf_path.name)
                _save(parsed_path, parsed)
                return parsed
            if state in {"failed", "cancelled", "canceled"}:
                raise _error("MinerU task failed or was cancelled; no fallback parser was used")
            if state not in {"pending", "queued", "running", "processing", "created", "waiting", "started"}:
                raise _error("MinerU task returned an unknown state; saved task was retained")
            await asyncio.sleep(_POLL_INTERVAL)
    raise _error("MinerU task exceeded one hour; saved task can be resumed without another upload")


async def parse_pdf(
    pdf_path: Path, cache_dir: Path, base_url: str, progress: Callable[[str], Awaitable[None]],
) -> dict[str, Any]:
    """Parse PDF into page-anchored text; preserve completed tasks across retries.

    Progress reports only ``parsing``. Chunking/embedding/indexing belong to the
    caller. Cache directories are content-addressed; uploads are serialized for
    the same PDF in this worker, and successful task submission is persisted
    before the first poll. GET failures never discard or re-upload that task.
    """
    await progress("parsing")
    try:
        with pdf_path.open("rb") as handle:
            pdf_hash = hashlib.file_digest(handle, "sha256").hexdigest()
        folder = cache_dir / pdf_hash
        folder.mkdir(parents=True, exist_ok=True)
    except OSError:
        raise _error("Cannot read PDF or initialize MinerU cache; check local storage") from None
    key = str(folder.resolve())
    lock = _LOCKS.setdefault(key, asyncio.Lock())
    async with lock:
        try:
            return await _parse_locked(pdf_path, folder, base_url, pdf_hash)
        except ProviderError:
            raise
        except (KeyError, TypeError, ValueError, AttributeError):
            raise _error("MinerU returned malformed document content; cached task was retained") from None
