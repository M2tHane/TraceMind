"""Real end-to-end smoke test through the MCP endpoint (calls the configured models; may be billed).

Usage (backend running with its worker; the token comes from 我的账户 → MCP 访问令牌):
    RAG_MCP_TOKEN=rwb_... backend/.venv/bin/python scripts/smoke_mcp.py [--url http://127.0.0.1:8010/mcp] [--skip-pdf]

Creates a personal knowledge base named "MCP 冒烟测试 <time>" owned by the token's account, uploads
README.md, docs/mcp.md and examples/pdfs/rag.pdf, then exercises retrieval, answering and personal
memory (plus dataset listing for administrators). Data is kept for inspection in the UI, delete the
knowledge base documents afterwards if not needed.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import time
from pathlib import Path
from typing import Any

import httpx
from mcp import Client
from mcp.client.streamable_http import streamable_http_client

ROOT = Path(__file__).resolve().parents[1]


class Smoke:
    def __init__(self, client: Client) -> None:
        self.client = client
        self.report: list[dict[str, Any]] = []

    async def call(self, tool: str, **arguments: Any) -> dict[str, Any]:
        started = time.perf_counter()
        result = await self.client.call_tool(tool, arguments)
        elapsed = round((time.perf_counter() - started) * 1000)
        text = "".join(getattr(block, "text", "") for block in result.content)
        self.report.append({"tool": tool, "ok": not result.is_error, "ms": elapsed})
        if result.is_error:
            raise RuntimeError(f"{tool} failed: {text}")
        return result.structured_content if result.structured_content is not None else json.loads(text)

    async def wait_ready(self, document_id: str, timeout: float) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        last = ""
        while time.monotonic() < deadline:
            document = await self.call("document_get", document_id=document_id)
            if document["status"] in {"ready", "failed"}:
                return document
            if document["stage"] != last:
                last = document["stage"]
                print(f"    {document['filename']}: {last}")
            await asyncio.sleep(3)
        raise TimeoutError(f"document {document_id} not ready after {timeout}s")


def step(title: str) -> None:
    print(f"\n== {title}")


async def run(url: str, token: str | None, skip_pdf: bool) -> None:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    async with httpx.AsyncClient(headers=headers, timeout=600) as http, \
            Client(streamable_http_client(url, http_client=http)) as client:
        smoke = Smoke(client)
        print(f"tools: {len((await client.list_tools()).tools)}")
        me = await smoke.call("whoami")
        print(f"acting as {me['username']} ({me['role']})")

        step("知识库与文档上传")
        kb = await smoke.call("kb_create", name=f"MCP 冒烟测试 {time.strftime('%m-%d %H:%M')}",
                              description="scripts/smoke_mcp.py 自动创建", chunk_size=1200, chunk_overlap=200)
        kb_id = kb["id"]
        readme = await smoke.call("document_upload", knowledge_base_id=kb_id, filename="README.md",
                                  content=(ROOT / "README.md").read_text(encoding="utf-8"))
        guide = await smoke.call("document_upload", knowledge_base_id=kb_id, filename="mcp.md",
                                 content=(ROOT / "docs" / "mcp.md").read_text(encoding="utf-8"))
        pdf = None
        if not skip_pdf:
            pdf = await smoke.call("document_upload", knowledge_base_id=kb_id, filename="rag.pdf",
                                   content_base64=base64.b64encode((ROOT / "examples/pdfs/rag.pdf").read_bytes()).decode())
        for document in (readme, guide):
            ready = await smoke.wait_ready(document["id"], 300)
            print(f"  {ready['filename']}: {ready['status']} chunks={ready['chunk_count']} {ready.get('error') or ''}")
            assert ready["status"] == "ready", ready

        step("检索：rag_search（混合 + 重排，含 trace）")
        found = await smoke.call("rag_search", knowledge_base_id=kb_id, query="记忆合并时标签和重要度如何处理？")
        for hit in found["results"][:3]:
            print(f"  #{hit['rank']} {hit['filename']} score={hit['score']:.4f} {hit['text'][:60]!r}")
        for stage in found["trace"]:
            print(f"  [{stage['stage']}] {stage['ms']} ms count={stage.get('count', '-')}")
        assert found["results"], "no retrieval results"

        step("问答：rag_answer（带用户记忆）")
        await smoke.call("memory_add", content="用户偏好用要点列表形式、简洁的中文回答",
                         category="preference", importance=4)
        answer = await smoke.call("rag_answer", knowledge_base_id=kb_id,
                                  question="MinerU 和 Milvus 分别运行在哪个端口？")
        print("  answer:", answer["answer"][:300].replace("\n", " "))
        print("  citations:", [(c["filename"], c["page"]) for c in answer["citations"]],
              "memories_used:", len(answer["memories_used"]))

        step("用户记忆：增 / 查 / 改 / 合并 / 抽取 / 历史")
        first = await smoke.call("memory_add", content="用户正在研究混合检索中的融合权重",
                                 category="profile", tags=["research"])
        second = await smoke.call("memory_add", content="用户关注 RRF 融合中向量与 BM25 的权重配比",
                                  category="profile", tags=["rrf"])
        dup = await smoke.call("memory_add", content="用户正在研究混合检索中的融合权重")
        print("  duplicate add ->", dup["action"])
        searched = await smoke.call("memory_search", query="检索融合权重")
        print("  search:", searched["mode"], [(r["content"][:24], r["similarity"]) for r in searched["results"]])
        updated = await smoke.call("memory_update", memory_id=first["memory"]["id"],
                                   content="用户正在研究混合检索中向量与 BM25 的融合权重", expected_version=1)
        print("  update -> version", updated["version"])
        merged = await smoke.call("memory_merge",
                                  memory_ids=[first["memory"]["id"], second["memory"]["id"]])
        print("  merge (model) ->", merged["memory"]["content"])
        extracted = await smoke.call("memory_extract", text=(
            "用户：我是一名后端工程师，主要用 Python 和 PostgreSQL。\n助手：了解。\n"
            "用户：以后给我示例代码时请优先使用 FastAPI。"))
        print("  extract ->", [(r["action"], r["memory"]["content"]) for r in extracted["results"]])
        history = await smoke.call("memory_history", memory_id=first["memory"]["id"])
        print("  history ->", [event["action"] for event in history["events"]])

        if me["role"] == "admin":
            step("检索调优")
            datasets = await smoke.call("dataset_list")
            print("  datasets:", [d["name"] for d in datasets["datasets"]])

        if pdf:
            step("PDF（MinerU）")
            ready = await smoke.wait_ready(pdf["id"], 900)
            print(f"  rag.pdf: {ready['status']} pages={ready['page_count']} chunks={ready['chunk_count']} "
                  f"{ready.get('error') or ''}")
            pdf_hit = await smoke.call("rag_search", knowledge_base_id=kb_id, top_k=3,
                                       query="What retriever does the RAG paper use?", document_ids=[pdf["id"]])
            for hit in pdf_hit["results"]:
                print(f"  p.{hit['page']} score={hit['score']:.4f} {hit['text'][:70]!r}")

        print("\nsummary:", json.dumps({"knowledge_base_id": kb_id, "account": me["username"],
                                        "calls": len(smoke.report),
                                        "failed": [r for r in smoke.report if not r["ok"]]}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8010/mcp")
    parser.add_argument("--token", default=os.environ.get("RAG_MCP_TOKEN"))
    parser.add_argument("--skip-pdf", action="store_true")
    args = parser.parse_args()
    if not args.token:
        parser.error("set RAG_MCP_TOKEN or pass --token (personal access token from the account page)")
    asyncio.run(run(args.url, args.token, args.skip_pdf))
