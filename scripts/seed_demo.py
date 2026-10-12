"""Fill a running TraceMind with demo data for screenshots and walkthroughs (calls the configured models).

Usage (backend with worker and MinerU running):
    cd backend && .venv/bin/python ../scripts/seed_demo.py [--skip-eval]

Creates demo accounts (admin 张伟, employees 李娜 and 王强) with generated passwords that are
written to data/demo-accounts.txt, two platform libraries (example papers and a fictional
employee handbook), a personal library, pending uploads, platform/personal memories, a few
answered conversations, MCP calls with a personal token, and an evaluation plus a tuning run.
Steps whose data already exists are skipped, so the script can be re-run.
"""
from __future__ import annotations

import argparse
import asyncio
import secrets
import sys
import time
from pathlib import Path
from typing import Any

import httpx
from mcp import Client
from mcp.client.streamable_http import streamable_http_client

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from sqlalchemy import select  # noqa: E402

from app.config import settings  # noqa: E402
from app.db import Session, engine  # noqa: E402
from app.models import User  # noqa: E402
from app.services.auth import hash_password  # noqa: E402

API = "http://127.0.0.1:8010/api"
MCP_URL = "http://127.0.0.1:8010/mcp"
ACCOUNTS = [("zhangwei", "张伟", "admin"), ("lina", "李娜", "employee"), ("wangqiang", "王强", "employee")]
PAPERS = ["attention.pdf", "lora.pdf", "rag.pdf", "react.pdf"]
HANDBOOK = ["leave-policy.md", "expense-policy.md", "security-policy.md", "onboarding.md"]


def step(title: str) -> None:
    print(f"\n== {title}", flush=True)


async def ensure_accounts() -> dict[str, str]:
    """Create the demo accounts (or reset their passwords) directly in the database."""
    passwords: dict[str, str] = {}
    async with Session() as db, db.begin():
        for username, display, role in ACCOUNTS:
            password = f"Demo-{secrets.token_urlsafe(9)}"
            user = await db.scalar(select(User).where(User.tenant_id == settings.tenant_id, User.username == username))
            if user is None:
                user = User(tenant_id=settings.tenant_id, username=username, display_name=display, role=role)
                db.add(user)
            user.password_hash, user.must_change_password, user.status = hash_password(password), False, "active"
            passwords[username] = password
    await engine.dispose()
    target = ROOT / "data" / "demo-accounts.txt"
    target.parent.mkdir(exist_ok=True)
    target.write_text("".join(f"{name}\t{passwords[name]}\n" for name, _, _ in ACCOUNTS), encoding="utf-8")
    target.chmod(0o600)
    return passwords


class Api:
    def __init__(self, username: str, password: str) -> None:
        self.username, self.password = username, password
        self.http = httpx.AsyncClient(base_url=API, timeout=120)

    async def login(self) -> Api:
        response = await self.http.post("/auth/login", json={"username": self.username, "password": self.password})
        response.raise_for_status()
        return self

    async def call(self, method: str, path: str, **kwargs: Any) -> Any:
        response = await self.http.request(method, path, **kwargs)
        if response.status_code >= 400:
            raise RuntimeError(f"{self.username} {method} {path}: {response.status_code} {response.text}")
        return response.json() if response.content else None

    async def get(self, path: str) -> Any:
        return await self.call("GET", path)

    async def post(self, path: str, body: Any = None, **kwargs: Any) -> Any:
        return await self.call("POST", path, json=body, **kwargs) if body is not None else await self.call("POST", path, **kwargs)

    async def library(self, name: str, description: str, scope: str, **chunking: int) -> tuple[dict, bool]:
        for kb in await self.get("/knowledge-bases"):
            if kb["name"] == name:
                return kb, False
        return await self.post("/knowledge-bases", {"name": name, "description": description, "scope": scope,
                                                     **chunking}), True

    async def upload(self, kb_id: str, *paths: Path) -> list[dict]:
        files = [("files", (path.name, path.read_bytes())) for path in paths]
        return await self.call("POST", f"/knowledge-bases/{kb_id}/documents", files=files)

    async def wait_documents(self, kb_id: str, timeout: float = 1800) -> None:
        deadline, last = time.monotonic() + timeout, ""
        while time.monotonic() < deadline:
            docs = [d for d in await self.get(f"/knowledge-bases/{kb_id}/documents") if d["review_status"] == "approved"]
            state = ", ".join(f"{d['filename']}:{d['stage']}" for d in docs)
            if state != last:
                print("   ", state, flush=True)
                last = state
            if all(d["status"] in ("ready", "failed") for d in docs):
                return
            await asyncio.sleep(5)
        raise TimeoutError("documents not ready")

    async def ask(self, kb_id: str, question: str) -> None:
        conversation = await self.post("/conversations", {"knowledge_base_id": kb_id})
        await self.post(f"/conversations/{conversation['id']}/messages", {"content": question})
        for _ in range(120):
            messages = await self.get(f"/conversations/{conversation['id']}/messages")
            answer = messages[-1]
            if answer["status"] in ("completed", "failed"):
                print(f"    [{self.username}] {question} -> {answer['status']} {answer['content'][:60]!r}", flush=True)
                return
            await asyncio.sleep(2)

    async def memory(self, content: str, scope: str = "personal", **fields: Any) -> None:
        result = await self.post(f"/memories?scope={scope}", {"content": content, **fields})
        print(f"    [{self.username}] {scope} memory {result['action']}: {content}", flush=True)


async def mcp_calls(token: str, handbook_id: str, notes_id: str) -> None:
    async with httpx.AsyncClient(headers={"Authorization": f"Bearer {token}"}, timeout=120) as http, \
            Client(streamable_http_client(MCP_URL, http_client=http)) as client:
        calls = [("whoami", {}), ("kb_list", {}),
                 ("rag_search", {"knowledge_base_id": handbook_id, "query": "年假最多可以顺延到什么时候", "top_k": 3}),
                 ("rag_search", {"knowledge_base_id": notes_id, "query": "RRF 融合公式", "top_k": 3}),
                 ("memory_search", {"query": "回答风格"}),
                 ("memory_add", {"content": "我负责华东区客户的售前支持", "category": "profile"}),
                 ("document_list", {"knowledge_base_id": handbook_id}),
                 ("tuning_status", {"run_id": "1"})]  # an employee is refused: shows up as an error in the log
        for tool, arguments in calls:
            result = await client.call_tool(tool, arguments)
            print(f"    mcp {tool}: {'error' if result.is_error else 'ok'}", flush=True)


async def main(skip_eval: bool) -> None:
    step("账号")
    passwords = await ensure_accounts()
    for username, display, role in ACCOUNTS:
        print(f"    {username} ({display}, {role})")
    admin, lina, wang = [await Api(name, passwords[name]).login() for name, _, _ in ACCOUNTS]

    step("平台知识库")
    papers, created = await admin.library("论文精读库", "RAG、Transformer、LoRA、ReAct 四篇经典论文，用于检索评测与调优。",
                                          "platform")
    if created:
        await admin.upload(papers["id"], *(ROOT / "examples" / "pdfs" / name for name in PAPERS))
    handbook, created = await admin.library("员工手册", "星河科技（虚构）的休假、报销、信息安全与入职制度。", "platform",
                                            chunk_size=800, chunk_overlap=150)
    if created:
        await admin.upload(handbook["id"], *(ROOT / "examples" / "handbook" / name for name in HANDBOOK))
    await admin.wait_documents(handbook["id"])

    step("个人知识库与待审批上传")
    notes, created = await lina.library("我的学习笔记", "检索增强生成相关的个人笔记。", "personal", chunk_size=600,
                                        chunk_overlap=100)
    if created:
        await lina.upload(notes["id"], ROOT / "examples" / "demo" / "study-notes.md")
        await lina.upload(handbook["id"], ROOT / "examples" / "demo" / "remote-work.md")
        await wang.upload(handbook["id"], ROOT / "examples" / "demo" / "team-building.md")
    await lina.wait_documents(notes["id"])

    step("记忆")
    if not (await admin.get("/memories?scope=platform"))["total"]:
        await admin.memory("回答制度类问题时，注明依据的文档名称和条款。", "platform", category="instruction", importance=5)
        await admin.memory("公司简称：星河科技；OA 指内部办公系统，审批统一在飞书发起。", "platform", category="fact", importance=4)
        await lina.memory("报销单据需在费用发生后 30 天内提交。", "platform", category="fact")
        await lina.memory("回答尽量简洁，先给结论再列要点。", category="preference", importance=5)
        await lina.memory("我在产品部做 AI 应用，最近在研究混合检索。", category="profile", importance=4)
        await lina.memory("本季度目标：把内部知识库问答的 Hit@5 提升到 90%。", category="goal", importance=3)
        await wang.memory("我常驻上海，经常出差到杭州和南京。", category="profile", importance=4)

    step("问答（调用对话模型）")
    if not await lina.get("/conversations"):
        await lina.ask(handbook["id"], "我入职第三年，今年的年假没休完，最晚可以顺延到什么时候？")
        await lina.ask(handbook["id"], "出差去上海住酒店，每晚的报销上限是多少？")
        await lina.ask(notes["id"], "RRF 公式里的 k 一般取多少？")
        await wang.ask(handbook["id"], "收到疑似钓鱼邮件应该怎么上报？")
        await admin.wait_documents(papers["id"])
        await lina.ask(papers["id"], "LoRA 为什么能大幅减少可训练参数？")
        await admin.ask(papers["id"], "ReAct 把推理和行动结合起来，相比只用思维链有什么好处？")

    step("MCP（个人访问令牌）")
    tokens = await lina.get("/auth/tokens")
    if not any(row["name"] == "Claude Code" for row in tokens):
        token = (await lina.post("/auth/tokens", {"name": "Claude Code", "expires_days": 90}))["token"]
        await mcp_calls(token, handbook["id"], notes["id"])

    if not skip_eval:
        await admin.wait_documents(papers["id"])
        dataset = next(d for d in await admin.get("/datasets") if d["name"].startswith("论文问答示例"))
        step("检索调优（Embedding / Rerank）")
        if not any(r["knowledge_base_id"] == papers["id"] for r in await admin.get("/tuning-runs")):
            run = await admin.post("/tuning-runs", {"name": "论文库 · 预设网格", "knowledge_base_id": papers["id"],
                                                    "dataset_id": dataset["id"], "objective": "mrr_at_10", "limit": 40})
            print(f"    tuning run {run['id']}: {run['total']} candidates", flush=True)
        step("批量评测（调用对话模型）")
        if not any(r["knowledge_base_id"] == papers["id"] for r in await admin.get("/runs")):
            run = await admin.post("/runs", {"name": "论文库 · BM25 vs 混合重排", "knowledge_base_id": papers["id"],
                                             "dataset_id": dataset["id"], "methods": ["bm25", "hybrid_rerank"],
                                             "limit": 10})
            print(f"    evaluation run {run['id']} queued", flush=True)

    print("\n账号与密码已写入 data/demo-accounts.txt")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-eval", action="store_true")
    asyncio.run(main(parser.parse_args().skip_eval))
