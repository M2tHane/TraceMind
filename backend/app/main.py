"""Local-only FastAPI application. Run migrations before starting the server."""
import asyncio
import sys
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager, suppress

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from loguru import logger
from sqlalchemy import text
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.api import (
    admin,
    auth,
    chat,
    evaluation,
    library,
    memory,
    model_profiles,
    service_settings,
    system,
    tuning,
)
from app.api.deps import current_principal, require_admin
from app.config import settings
from app.db import Session, engine
from app.mcp_server import mcp, mcp_http_app
from app.services.auth import bearer, resolve_api_token
from app.services.configuration import bootstrap_configuration
from app.worker import serve_worker

# Never render local variable values (which can include environment secrets) in tracebacks.
logger.remove()
logger.add(sys.stderr, diagnose=False, backtrace=False)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    async with engine.connect() as connection:
        await connection.execute(text("SELECT version_num FROM alembic_version"))
    async with Session() as db:
        await bootstrap_configuration(db)
        await db.commit()
    task = asyncio.create_task(serve_worker(), name="rag-worker") if settings.run_worker else None
    try:
        # A mounted sub-application's lifespan never runs: the host must start the MCP session manager.
        async with mcp.session_manager.run():
            yield
    finally:
        if task:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
        await engine.dispose()


app = FastAPI(title="TraceMind", version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=settings.allowed_origins, allow_credentials=True,
                   allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE"],
                   allow_headers=["Content-Type", "Authorization"])
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1", "[::1]"])


@app.middleware("http")
async def local_guard(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
    if request.client and request.client.host not in {"127.0.0.1", "::1", "localhost", "testclient"}:
        return JSONResponse({"detail": "此版本仅允许本机访问"}, status_code=403)
    origin = request.headers.get("origin")
    if origin and origin not in settings.allowed_origins and origin not in {"http://127.0.0.1:8010", "http://localhost:8010"}:
        return JSONResponse({"detail": "不允许此来源访问本地工作台"}, status_code=403)
    if request.url.path.startswith("/mcp"):
        # Every MCP call acts as the account owning the personal access token.
        raw = bearer(request.headers.get("authorization"))
        principal = None
        if raw:
            async with Session() as db:
                principal = await resolve_api_token(db, raw)
                await db.commit()
        if principal is None:
            return JSONResponse({"detail": "MCP 需要有效的个人访问令牌（Authorization: Bearer rwb_...）"},
                                status_code=401, headers={"WWW-Authenticate": "Bearer"})
        request.state.principal = principal
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "same-origin"
    return response


@app.exception_handler(Exception)
async def unhandled_error(request: Request, exc: Exception) -> JSONResponse:
    logger.opt(exception=exc).error("Unhandled API failure: method={}, path={}", request.method, request.url.path)
    return JSONResponse({"detail": "服务器处理失败，请查看服务端日志"}, status_code=500)


@app.exception_handler(RequestValidationError)
async def invalid_request(request: Request, exc: RequestValidationError) -> JSONResponse:
    # Never echo request input or validator context: both may contain credentials.
    errors = [{"loc": error["loc"], "type": error["type"], "msg": "Invalid request field"}
              for error in exc.errors()]
    return JSONResponse({"detail": errors}, status_code=422)


# /api/health and /api/auth/login are public. Every other route needs a signed-in account,
# and evaluation, tuning and service configuration are administrator-only.
signed_in, admin_only = [Depends(current_principal)], [Depends(require_admin)]
app.include_router(system.router, prefix="/api")
app.include_router(auth.router, prefix="/api")
app.include_router(admin.router, prefix="/api")
for router in (library.router, chat.router, memory.router, model_profiles.router):
    app.include_router(router, prefix="/api", dependencies=signed_in)
for router in (evaluation.router, tuning.router, service_settings.router):
    app.include_router(router, prefix="/api", dependencies=admin_only)

# MCP streamable HTTP endpoint at /mcp. Mounted last so every /api route takes precedence.
app.mount("/", mcp_http_app)
