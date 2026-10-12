"""Account administration from the server shell.

    .venv/bin/python -m app.cli create-admin --username admin [--display-name 管理员]
    .venv/bin/python -m app.cli reset-password --username alice

A generated temporary password is printed once; the account must change it at first login.
Creating the first administrator also assigns data created before accounts existed:
libraries become platform libraries owned by the administrator, and ownerless conversations
and memories (old free-form user_id namespaces) move to the administrator.
"""
from __future__ import annotations

import argparse
import asyncio
import sys

from sqlalchemy import func, or_, select, update

from app.api.admin import generate_password
from app.config import settings
from app.db import Session, engine
from app.models import Conversation, KnowledgeBase, Memory, User
from app.services.auth import AuthError, hash_password, normalize_username, revoke_user_sessions


async def backfill(db, admin: User) -> dict[str, int]:
    tenant = settings.tenant_id
    kbs = await db.execute(update(KnowledgeBase).where(
        KnowledgeBase.tenant_id == tenant, KnowledgeBase.owner_id.is_(None)).values(owner_id=admin.id))
    conversations = await db.execute(update(Conversation).where(
        Conversation.tenant_id == tenant, Conversation.owner_id.is_(None)).values(owner_id=admin.id))
    memories = await db.execute(update(Memory).where(
        Memory.tenant_id == tenant, Memory.user_id != "platform", ~Memory.user_id.like("user:%"),
    ).values(user_id=f"user:{admin.id}", scope="personal"))
    return {"knowledge_bases": kbs.rowcount, "conversations": conversations.rowcount, "memories": memories.rowcount}


async def create_admin(username: str, display_name: str) -> None:
    username = normalize_username(username)
    async with Session() as db, db.begin():
        if await db.scalar(select(User).where(User.tenant_id == settings.tenant_id, User.username == username)):
            raise AuthError("用户名已存在，可使用 reset-password")
        first = not await db.scalar(select(func.count(User.id)).where(
            User.tenant_id == settings.tenant_id, or_(User.role == "admin", User.role == "employee")))
        password = generate_password(username)
        admin = User(tenant_id=settings.tenant_id, username=username, display_name=display_name or username,
                     role="admin", password_hash=hash_password(password), status="active",
                     must_change_password=True)
        db.add(admin)
        await db.flush()
        moved = await backfill(db, admin) if first else None
    print(f"已创建管理员 {username}")
    print(f"临时密码：{password}")
    print("首次登录后必须修改密码。")
    if moved:
        print(f"已归属历史数据：知识库 {moved['knowledge_bases']}，会话 {moved['conversations']}，"
              f"记忆 {moved['memories']}")


async def reset_password(username: str) -> None:
    username = normalize_username(username)
    async with Session() as db, db.begin():
        user = await db.scalar(select(User).where(User.tenant_id == settings.tenant_id, User.username == username)
                               .with_for_update())
        if user is None:
            raise AuthError("用户不存在", 404)
        password = generate_password(username)
        user.password_hash, user.must_change_password, user.status = hash_password(password), True, "active"
        await revoke_user_sessions(db, user.id)
    print(f"已重置 {username} 的密码（账户已启用）")
    print(f"临时密码：{password}")


async def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create-admin", help="create an administrator account")
    create.add_argument("--username", required=True)
    create.add_argument("--display-name", default="")
    reset = commands.add_parser("reset-password", help="issue a new temporary password")
    reset.add_argument("--username", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "create-admin":
            await create_admin(args.username, args.display_name)
        else:
            await reset_password(args.username)
        return 0
    except AuthError as error:
        print(f"失败：{error}", file=sys.stderr)
        return 1
    finally:
        await engine.dispose()


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
