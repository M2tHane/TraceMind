"""Server-side environment configuration; never sent verbatim to browsers."""
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND = Path(__file__).resolve().parents[1]
ROOT = BACKEND.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND / ".env", extra="ignore")
    database_url: str = "postgresql+asyncpg://rag@127.0.0.1:25432/rag_workbench"
    tenant_id: int = 900000000000000001
    data_dir: Path = ROOT / "data"
    chat_base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    chat_model: str = "deepseek-v4-flash-0731"
    chat_api_key: str = ""
    chat_protocol: str = "openai_chat"
    json_mode: bool = True
    embedding_base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    embedding_model: str = "qwen3.7-text-embedding"
    embedding_api_key: str = ""
    embedding_dimensions: int = 1024
    rerank_base_url: str = "https://dashscope.aliyuncs.com"
    rerank_model: str = "qwen3.7-text-rerank"
    rerank_api_key: str = ""
    rerank_protocol: str = "dashscope"
    mineru_base_url: str = "http://127.0.0.1:28000"
    milvus_uri: str = "http://127.0.0.1:29530"
    milvus_collection: str = "rag_workbench_chunks_v1"
    model_timeout: float = 120.0
    max_output_tokens: int = 4096
    run_worker: bool = True
    max_upload_mb: int = 50
    max_kb_chunks: int = 20000
    allowed_origins: list[str] = ["http://127.0.0.1:5174", "http://localhost:5174"]


settings = Settings()
