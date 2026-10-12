"""Small real-service smoke test. Requires explicit --paid for model calls."""
import argparse
import asyncio
import json
import time
from pathlib import Path
import httpx
import pymupdf

ROOT = Path(__file__).resolve().parents[1]
TEXT = """RAG Workbench Quick Start

This document is a small integration-test guide, not a research paper.

The workbench stores document metadata, conversations, citation snapshots,
and evaluation records in PostgreSQL. Dense document vectors are stored
in a separate Milvus collection. Uploaded PDF files stay on local disk.

MinerU parses PDFs into structured text. Text is split into page-anchored
chunks before embedding. A document is searchable only after parsing,
chunking, embedding and vector indexing all finish successfully.

Hybrid retrieval combines keyword BM25 and dense vector results using
reciprocal rank fusion. Reranking reorders the retrieved candidates before
the selected passages are supplied to the answer model. It does not add
new facts to the source document.

A citation identifies the source filename, parser page anchor and exact
stored chunk text. Citations must come from the passages supplied to the
answer model. The number of citations counts unique cited chunks, not the
number of retrieved candidates.

Evaluation questions and reference answers must never be indexed into
the knowledge base. Missing automatic judgments are unscored, not wrong.
"""


async def wait_for(client: httpx.AsyncClient, path: str, complete: set[str], timeout: int = 900) -> dict:
    started = time.monotonic()
    last = None
    while time.monotonic() - started < timeout:
        response = await client.get(path)
        response.raise_for_status()
        row = response.json()
        state = row.get("status")
        if state != last:
            print(f"{path}: {state} / {row.get('stage', '')}", flush=True)
            last = state
        if state in complete:
            return row
        if state == "failed":
            raise RuntimeError(row.get("error", "Task failed"))
        await asyncio.sleep(2)
    raise TimeoutError(path)


async def run() -> None:
    async with httpx.AsyncClient(base_url="http://127.0.0.1:8010/api", timeout=180, trust_env=False) as client:
        health = (await client.get("/health")).json()
        assert health["database"] == "connected"
        libraries = (await client.get("/knowledge-bases")).json()
        kb = next((item for item in libraries if item["name"] == "入门演示"), None)
        if not kb:
            response = await client.post("/knowledge-bases", json={"name": "入门演示", "description": "真实小样例：上传、解析、引用与评测链路验证"})
            response.raise_for_status()
            kb = response.json()
        docs = (await client.get(f"/knowledge-bases/{kb['id']}/documents")).json()
        document = next((row for row in docs if row["filename"] == "quick-start.pdf"), None)
        if not document:
            pdf = pymupdf.open()
            page = pdf.new_page()
            page.insert_textbox(pymupdf.Rect(45, 45, 550, 795), TEXT, fontsize=12)
            content = pdf.tobytes()
            pdf.close()
            response = await client.post(f"/knowledge-bases/{kb['id']}/documents",
                                         files=[("files", ("quick-start.pdf", content, "application/pdf"))])
            response.raise_for_status()
            uploaded = response.json()
            document = uploaded[0] if isinstance(uploaded, list) else uploaded["documents"][0]
        ready = await wait_for(client, f"/documents/{document['id']}", {"ready"})
        parsed = (await client.get(f"/documents/{document['id']}/parsed")).json()
        assert parsed["chunks"] and parsed["markdown"]
        pdf_response = await client.get(f"/documents/{document['id']}/file")
        assert pdf_response.content.startswith(b"%PDF-")
        response = await client.post("/conversations", json={"knowledge_base_id": kb["id"], "title": "引用验证"})
        response.raise_for_status()
        conversation = response.json()
        response = await client.post(f"/conversations/{conversation['id']}/messages", json={
            "content": "这个工作台把元数据和向量分别存在哪里？", "method": "hybrid_rerank"})
        response.raise_for_status()
        assistant = response.json()
        started = time.monotonic()
        while time.monotonic() - started < 240:
            rows = (await client.get(f"/conversations/{conversation['id']}/messages")).json()
            message = next(row for row in rows if row["id"] == assistant["id"])
            if message["status"] in {"completed", "failed"}:
                break
            await asyncio.sleep(2)
        assert message["status"] == "completed", message.get("error")
        assert message["citations"], "Expected verified citations"
        assert all(c["document_id"] == document["id"] and c["text"] for c in message["citations"])
        print(f"Chat completed with {len(message['citations'])} verified citations", flush=True)
        response = await client.post("/debug", json={"knowledge_base_id": kb["id"],
            "question": "Where are document vectors stored?", "methods": ["bm25", "vector"], "retrieval_only": True})
        response.raise_for_status()
        debug = response.json()
        assert all(row.get("contexts") and not row.get("error") for row in debug["results"])
        response = await client.post("/datasets", json={"name": "入门单题验证", "description": "人工编写来源与预期答案；只验证产品流程"})
        response.raise_for_status()
        dataset = response.json()
        response = await client.post(f"/datasets/{dataset['id']}/questions", json={
            "question": "Where are document vectors stored?", "reference_answer": "Document vectors are stored in Milvus.",
            "answerable": True, "evidence": [{"document_id": document["id"], "page": 1,
                "quote": "Dense document vectors are stored in a separate Milvus collection."}], "review_status": "pending"})
        response.raise_for_status()
        response = await client.post("/runs", json={"name": "单题流程验证", "knowledge_base_id": kb["id"],
            "dataset_id": dataset["id"], "methods": ["bm25"], "limit": 1, "judge_enabled": True})
        response.raise_for_status()
        run_row = await wait_for(client, f"/runs/{response.json()['id']}", {"completed", "paused"}, timeout=240)
        assert run_row["status"] == "completed", run_row.get("error")
        items = (await client.get(f"/runs/{run_row['id']}/items")).json()
        assert items[0]["result"] is not None and items[0]["judgment"] is not None, items[0]
        export = await client.get(f"/runs/{run_row['id']}/export")
        assert export.status_code == 200 and "attachment" in export.headers.get("content-disposition", "")
        example = await client.post("/datasets/import-example")
        example.raise_for_status()
        assert example.json()["question_count"] == 100
        report = {"knowledge_base_id": kb["id"], "document": ready, "conversation_id": conversation["id"],
                  "citation_count": len(message["citations"]), "debug_methods": [r["method"] for r in debug["results"]],
                  "evaluation": run_row, "example_questions": 100}
        path = ROOT / "data/smoke-report.json"
        path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print("PASS: upload -> MinerU -> Milvus -> cited answer -> debug -> evaluation -> export -> 100-question import", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--paid", action="store_true", help="Allow a few real model API calls")
    args = parser.parse_args()
    if not args.paid:
        parser.error("Add --paid to acknowledge real model usage")
    asyncio.run(run())
