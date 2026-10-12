"""Validated write-only configuration inputs."""
from typing import Annotated, Literal
from urllib.parse import urlsplit

from pydantic import AfterValidator, Field, model_validator

from app.schemas import InputModel


def validate_url(value: str) -> str:
    try:
        parts = urlsplit(value)
        if (parts.scheme not in {"http", "https"} or not parts.hostname
                or parts.username is not None or parts.password is not None
                or parts.query or parts.fragment
                or any(char.isspace() or ord(char) < 32 or ord(char) == 127 for char in value)):
            raise ValueError
        _ = parts.port
    except ValueError:
        raise ValueError("Use an HTTP(S) URL without credentials, query or fragment") from None
    return value.rstrip("/")


Endpoint = Annotated[str, Field(min_length=1, max_length=1000), AfterValidator(validate_url)]
Name = Annotated[str, Field(min_length=1, max_length=200)]
Secret = Annotated[str, Field(max_length=8192)]
Protocol = Literal["openai_chat", "openai_responses", "anthropic"]


class NoNullInput(InputModel):
    @model_validator(mode="before")
    @classmethod
    def reject_null(cls, payload: object) -> object:
        if isinstance(payload, dict) and any(value is None for value in payload.values()):
            raise ValueError("Omit unchanged fields; null is not supported")
        return payload


class ProfileCreate(NoNullInput):
    name: Name
    model: Name
    protocol: Protocol
    base_url: Endpoint
    api_key: Secret = Field(default="", repr=False)
    is_default: bool = False
    enabled: bool = True
    max_tokens: int = Field(default=4096, ge=16, le=65536, strict=True)
    timeout_seconds: int = Field(default=120, ge=5, le=600, strict=True)
    json_mode: bool = True


class ProfilePatch(NoNullInput):
    name: Name | None = None
    model: Name | None = None
    protocol: Protocol | None = None
    base_url: Endpoint | None = None
    api_key: Secret | None = Field(default=None, repr=False)
    is_default: bool | None = None
    enabled: bool | None = None
    max_tokens: int | None = Field(default=None, ge=16, le=65536, strict=True)
    timeout_seconds: int | None = Field(default=None, ge=5, le=600, strict=True)
    json_mode: bool | None = None


class EmbeddingPatch(NoNullInput):
    model: Name | None = None
    base_url: Endpoint | None = None
    api_key: Secret | None = Field(default=None, repr=False)
    dimensions: int | None = Field(default=None, ge=1, le=32768, strict=True)


class RerankPatch(NoNullInput):
    model: Name | None = None
    base_url: Endpoint | None = None
    api_key: Secret | None = Field(default=None, repr=False)
    protocol: Literal["dashscope", "standard"] | None = None


class MineruPatch(NoNullInput):
    base_url: Endpoint | None = None


class MilvusPatch(NoNullInput):
    uri: Endpoint | None = None
    collection: str | None = Field(default=None, pattern=r"^rag_workbench_[A-Za-z0-9_]+$", max_length=200)


class SettingsPatch(NoNullInput):
    embedding: EmbeddingPatch | None = None
    rerank: RerankPatch | None = None
    mineru: MineruPatch | None = None
    milvus: MilvusPatch | None = None


class TestRequest(InputModel):
    confirm: bool = Field(default=False, strict=True)
