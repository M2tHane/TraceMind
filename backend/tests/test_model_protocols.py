"""Offline transport contracts: mock HTTP and official SDK HTTP, never model calls."""

from __future__ import annotations

import copy
import importlib
import json
import logging
from collections.abc import Callable
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from loguru import logger

from app.services.providers import AccountUnavailable, ProviderError, Providers

PROTOCOLS = ["openai_chat", "openai_responses", "anthropic"]
TEST_KEY = "explicit-test-key-not-a-credential"
MODEL = "user-configured-model"
ANSWER = {"answer": "Supported.", "citations": ["c1"], "abstain": False}
CHUNKS = [{"id": "c1", "text": "Support"}, {"id": "c2", "text": "Other"}]


def _settings(**overrides: Any) -> SimpleNamespace:
    settings = {
        "chat_base_url": "https://model.test/v1", "chat_model": MODEL, "chat_api_key": TEST_KEY,
        "embedding_base_url": "https://embedding.test/v1", "embedding_model": "embedding-test",
        "embedding_api_key": TEST_KEY, "embedding_dimensions": 3,
        "rerank_base_url": "https://rerank.test/v1", "rerank_model": "rerank-test",
        "rerank_api_key": TEST_KEY, "model_timeout": 10.0, "max_output_tokens": 2048,
    }
    return SimpleNamespace(**(settings | overrides))


def _body(protocol: str, text: str = "OK") -> dict[str, Any]:
    if protocol == "openai_chat":
        return {"choices": [{"finish_reason": "stop", "message": {"content": text}}],
                "usage": {"prompt_tokens": 4, "completion_tokens": 3}}
    if protocol == "openai_responses":
        return {"status": "completed", "error": None, "incomplete_details": None,
                "output": [{"type": "reasoning", "summary": [{"text": "private reasoning"}]},
                           {"type": "message", "status": "completed", "role": "assistant",
                            "content": [{"type": "output_text", "text": text}]}],
                "usage": {"input_tokens": 4, "output_tokens": 3}}
    return {"id": "msg_test", "type": "message", "model": MODEL, "role": "assistant",
            "stop_reason": "end_turn", "stop_sequence": None,
            "content": [{"type": "thinking", "thinking": "private reasoning", "signature": "signature"},
                        {"type": "text", "text": text}], "usage": {"input_tokens": 4, "output_tokens": 3}}


@pytest.fixture
def provider_factory(monkeypatch: pytest.MonkeyPatch) -> Callable[..., Any]:
    async def create(
        protocol: str, handler: Callable[..., Any], **overrides: Any,
    ) -> Providers:
        if protocol == "anthropic":
            sdk = importlib.import_module("anthropic")
            wire = importlib.import_module("httpx2" if sdk.__version__.split(".")[0] == "1" else "httpx")
            # Capture the real SDK HTTP factory before patching (tests create one provider each).
            factory = sdk.DefaultAsyncHttpxClient

            def mock_sdk_http(**kwargs: Any) -> Any:
                assert kwargs["trust_env"] is False
                assert kwargs["follow_redirects"] is False
                assert 0 < kwargs["timeout"] <= 600
                return factory(**kwargs, transport=wire.MockTransport(handler))

            monkeypatch.setattr(sdk, "DefaultAsyncHttpxClient", mock_sdk_http)
        provider = Providers(_settings(chat_protocol=protocol, **overrides))
        await provider.close()
        provider._client = httpx.AsyncClient(transport=httpx.MockTransport(handler), trust_env=False)
        return provider

    return create


def _response(protocol: str, body: Any, status: int = 200) -> Any:
    if protocol == "anthropic":
        sdk = importlib.import_module("anthropic")
        wire = importlib.import_module("httpx2" if sdk.__version__.split(".")[0] == "1" else "httpx")
        return wire.Response(status, json=body)
    return httpx.Response(status, json=body)


@pytest.mark.parametrize("protocol", PROTOCOLS)
async def test_answer_and_judge_select_protocol_preserve_history_and_model(
    protocol: str, provider_factory: Callable[..., Any], monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE", "OPENAI_API_KEY"):
        monkeypatch.setenv(name, "ambient-must-never-be-used")
    monkeypatch.setenv(
        "ANTHROPIC_CUSTOM_HEADERS",
        "authorization: Bearer ambient-must-never-be-used\n"
        "x-api-key: ambient-must-never-be-used\nanthropic-beta: oauth-2025-04-20",
    )
    calls: list[dict[str, Any]] = []
    history = [{"role": "user", "content": "Prior question"}, {"role": "assistant", "content": "Prior reply"}]

    def respond(request: Any) -> Any:
        body = json.loads(request.content)
        calls.append(body)
        assert body["model"] == MODEL
        assert "ambient-must-never-be-used" not in str(request.headers)
        assert "fallbacks" not in body and "thinking" not in body
        if protocol == "anthropic":
            assert request.url.path == "/v1/messages"
            assert request.headers["x-api-key"] == TEST_KEY
            assert "authorization" not in request.headers
            assert "anthropic-beta" not in request.headers
            assert request.headers["anthropic-version"]
            assert body["system"]
            assert "temperature" not in body and "response_format" not in body
            assert body["max_tokens"] == 2048
            turns = body["messages"]
        else:
            assert request.headers["authorization"] == "Bearer " + TEST_KEY
            assert "x-api-key" not in request.headers
            turns = body["messages"] if protocol == "openai_chat" else body["input"]
            assert turns[0]["role"] == "system"
            turns = turns[1:]
            if protocol == "openai_chat":
                assert request.url.path == "/v1/chat/completions"
                assert body["response_format"] == {"type": "json_object"}
                assert body["max_tokens"] == 2048
            else:
                assert request.url.path == "/v1/responses"
                assert body["text"] == {"format": {"type": "json_object"}}
                assert body["max_output_tokens"] == 2048
                assert "temperature" not in body and "max_tokens" not in body
        if len(calls) == 1:
            assert turns[:-1] == history
            assert json.loads(turns[-1]["content"])["sources"] == CHUNKS
            text = json.dumps(ANSWER)
        else:
            assert "reference_answer" in json.loads(turns[-1]["content"])
            text = json.dumps({"correct": True, "faithful": True, "reason": "Supported."})
        return _response(protocol, _body(protocol, text))

    provider = await provider_factory(protocol, respond)
    try:
        answer = await provider.answer("Question", CHUNKS, history=history)
        assert answer["usage"] == {"total_tokens": 7}
        assert answer["citations"] == ["c1"]
        assert answer["latency_ms"] >= 0
        judgment = await provider.judge("Question", "Reference", True, answer)
        assert judgment["correct"] is True and judgment["usage"] == {"total_tokens": 7}
        assert len(calls) == 2
    finally:
        await provider.close()


@pytest.mark.parametrize("protocol", PROTOCOLS)
@pytest.mark.parametrize("budget", [32, 2048])
async def test_probe_is_one_bounded_plaintext_request(
    protocol: str, budget: int, provider_factory: Callable[..., Any],
) -> None:
    calls = 0

    def respond(request: Any) -> Any:
        nonlocal calls
        calls += 1
        body = json.loads(request.content)
        assert body.get("max_tokens", body.get("max_output_tokens")) == min(budget, 128)
        assert "text" not in body and "response_format" not in body
        assert body.get("messages", body.get("input")) == [{"role": "user", "content": "Reply with only OK."}]
        return _response(protocol, _body(protocol, "OK " + TEST_KEY))

    provider = await provider_factory(protocol, respond, max_output_tokens=budget)
    try:
        result = await provider.probe_chat()
        assert result["preview"] == "OK [redacted]"
        assert result["usage"] == {"total_tokens": 7} and result["latency_ms"] >= 0
        assert calls == 1
    finally:
        await provider.close()


@pytest.mark.parametrize("protocol", PROTOCOLS)
@pytest.mark.parametrize("invalid", ["fenced", "partial", "array", "citation", "extra", "types"])
async def test_strict_json_and_citation_validation_survives_protocol_switch(
    protocol: str, invalid: str, provider_factory: Callable[..., Any],
) -> None:
    values = {
        "fenced": "```json\n" + json.dumps(ANSWER) + "\n```", "partial": '{"answer":',
        "array": "[]", "citation": json.dumps(ANSWER | {"citations": ["fabricated"]}),
        "extra": json.dumps(ANSWER | {"extra": 1}), "types": json.dumps(ANSWER | {"abstain": "false"}),
    }
    provider = await provider_factory(protocol, lambda _: _response(protocol, _body(protocol, values[invalid])))
    try:
        with pytest.raises(ProviderError):
            await provider.answer("Question", CHUNKS)
    finally:
        await provider.close()


@pytest.mark.parametrize("protocol", PROTOCOLS)
@pytest.mark.parametrize("failure", ["refusal", "truncated", "empty", "usage"])
async def test_refusal_truncation_empty_and_bad_usage_fail_safely(
    protocol: str, failure: str, provider_factory: Callable[..., Any],
) -> None:
    body = _body(protocol, json.dumps(ANSWER))
    if failure == "usage":
        body["usage"] = {"total_tokens": -1, "input_tokens": -1, "output_tokens": -1}
    elif protocol == "openai_chat":
        if failure == "refusal":
            body["choices"][0]["message"]["refusal"] = TEST_KEY
        elif failure == "truncated":
            body["choices"][0]["finish_reason"] = "length"
        else:
            body["choices"][0]["message"]["content"] = ""
    elif protocol == "openai_responses":
        if failure == "refusal":
            body["output"][-1]["content"].append({"type": "refusal", "refusal": TEST_KEY})
        elif failure == "truncated":
            body["status"] = "incomplete"
            body["incomplete_details"] = {"reason": "max_output_tokens"}
        else:
            body["output"] = []
            body["output_text"] = json.dumps(ANSWER)  # Convenience fields must never be trusted.
    elif failure == "empty":
        body["content"] = body["content"][:1]  # Thinking-only is not visible text.
    else:
        body["stop_reason"] = "refusal" if failure == "refusal" else "max_tokens"
        body["stop_details"] = {"explanation": TEST_KEY}
    provider = await provider_factory(protocol, lambda _: _response(protocol, body))
    try:
        with pytest.raises(ProviderError) as error:
            await provider.answer("Question", CHUNKS)
        assert TEST_KEY not in str(error.value)
    finally:
        await provider.close()


@pytest.mark.parametrize("protocol", PROTOCOLS)
@pytest.mark.parametrize("failure", ["quota", "rejected", "timeout"])
async def test_errors_never_leak_payloads_or_retry_ambiguous_posts(
    protocol: str, failure: str, provider_factory: Callable[..., Any], caplog: pytest.LogCaptureFixture,
) -> None:
    calls = 0
    logs: list[str] = []
    sink = logger.add(lambda message: logs.append(str(message)), diagnose=False, backtrace=False)
    caplog.set_level(logging.DEBUG)

    def respond(request: Any) -> Any:
        nonlocal calls
        calls += 1
        if failure == "timeout":
            wire = importlib.import_module(type(request).__module__.split(".")[0])
            raise wire.ReadTimeout(TEST_KEY + " raw provider error", request=request)
        code = "insufficient_quota" if failure == "quota" else "invalid_request_error"
        return _response(protocol, {"error": {"type": code, "code": code,
                                              "message": TEST_KEY + " raw provider error"}}, 429)

    provider = await provider_factory(protocol, respond)
    try:
        with pytest.raises(AccountUnavailable if failure == "quota" else ProviderError) as error:
            await provider.answer("Question", CHUNKS)
        if failure == "quota":
            with pytest.raises(AccountUnavailable):
                await provider.probe_chat()
            with pytest.raises(AccountUnavailable):
                await provider.embed(["Do not spend after quota failure"])
        assert calls == 1
        assert TEST_KEY not in str(error.value)
        assert "raw provider error" not in str(error.value)
        output = "".join(logs) + caplog.text
        assert TEST_KEY not in output and "raw provider error" not in output
    finally:
        logger.remove(sink)
        await provider.close()


@pytest.mark.parametrize("protocol", PROTOCOLS)
async def test_explicit_empty_key_only_allowed_for_openai_self_hosting(
    protocol: str, provider_factory: Callable[..., Any], monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "ambient-unused")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "ambient-unused")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "ambient-unused")
    calls = 0

    def respond(request: Any) -> Any:
        nonlocal calls
        calls += 1
        assert "authorization" not in request.headers and "x-api-key" not in request.headers
        return _response(protocol, _body(protocol))

    provider = await provider_factory(protocol, respond, chat_api_key="", chat_base_url="http://localhost:9000/v1")
    try:
        if protocol == "anthropic":
            with pytest.raises(ProviderError, match="explicitly configured"):
                await provider.probe_chat()
            assert calls == 0
        else:
            assert (await provider.probe_chat())["preview"] == "OK"
            assert calls == 1
    finally:
        await provider.close()


@pytest.mark.parametrize("protocol", ["openai_chat", "openai_responses"])
async def test_json_mode_disabled_keeps_local_answer_schema_validation(
    protocol: str, provider_factory: Callable[..., Any],
) -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        request_body = json.loads(request.content)
        assert "text" not in request_body and "response_format" not in request_body
        return _response(protocol, _body(protocol, json.dumps(ANSWER)))

    provider = await provider_factory(protocol, respond, json_mode=False)
    try:
        assert (await provider.answer("Question", CHUNKS))["answer"] == ANSWER["answer"]
    finally:
        await provider.close()


@pytest.mark.parametrize("mutation", ["status", "message_status", "role", "error", "details", "refusal_only"])
async def test_responses_requires_complete_assistant_output(
    mutation: str, provider_factory: Callable[..., Any],
) -> None:
    body = _body("openai_responses", json.dumps(ANSWER))
    if mutation == "status":
        body["status"] = "failed"
    elif mutation == "message_status":
        body["output"][-1]["status"] = "incomplete"
    elif mutation == "role":
        body["output"][-1]["role"] = "user"
    elif mutation == "error":
        body["error"] = {"message": TEST_KEY}
    elif mutation == "details":
        body["incomplete_details"] = {"reason": TEST_KEY}
    else:
        body["output"][-1]["content"] = [{"type": "refusal", "refusal": TEST_KEY}]
    provider = await provider_factory("openai_responses", lambda _: httpx.Response(200, json=body))
    try:
        with pytest.raises(ProviderError) as error:
            await provider.answer("Question", CHUNKS)
        assert TEST_KEY not in str(error.value)
    finally:
        await provider.close()


@pytest.mark.parametrize("protocol", ["dashscope", "standard"])
@pytest.mark.parametrize("invalid", [False, True])
async def test_rerank_protocol_body_path_and_complete_permutation(
    protocol: str, invalid: bool, provider_factory: Callable[..., Any],
) -> None:
    original = copy.deepcopy(CHUNKS)

    def respond(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["model"] == "rerank-test"
        results = [{"index": 1, "relevance_score": 0.9}, {"index": 1 if invalid else 0, "relevance_score": 0.1}]
        if protocol == "standard":
            assert request.url.path == "/v1/rerank"
            assert body == {"model": "rerank-test", "query": "Question", "documents": ["Support", "Other"], "top_n": 2}
            assert "authorization" not in request.headers
            return httpx.Response(200, json={"results": results})
        assert request.url.path == "/api/v1/services/rerank/text-rerank/text-rerank"
        assert body["input"] == {"query": "Question", "documents": ["Support", "Other"]}
        assert body["parameters"] == {"top_n": 2, "return_documents": False}
        return httpx.Response(200, json={"output": {"results": results}})

    provider = await provider_factory(
        "openai_chat", respond, rerank_protocol=protocol,
        rerank_base_url="https://rerank.test/v1" if protocol == "standard" else "https://rerank.test",
        rerank_api_key="" if protocol == "standard" else TEST_KEY,
    )
    try:
        if invalid:
            with pytest.raises(ProviderError, match="indices"):
                await provider.rerank("Question", CHUNKS)
        else:
            assert [row["id"] for row in await provider.rerank("Question", CHUNKS)] == ["c2", "c1"]
        assert CHUNKS == original
    finally:
        await provider.close()


@pytest.mark.parametrize("base_url", [
    "https://model.test", "https://model.test/v1/", "https://model.test/v1/messages",
    "https://model.test/proxy/v1",
])
async def test_anthropic_endpoint_normalization_and_retries_disabled(
    base_url: str, provider_factory: Callable[..., Any],
) -> None:
    def respond(request: Any) -> Any:
        assert request.url.path == ("/proxy/v1/messages" if "/proxy" in base_url else "/v1/messages")
        return _response("anthropic", _body("anthropic"))

    provider = await provider_factory("anthropic", respond, chat_base_url=base_url)
    try:
        assert (await provider.probe_chat())["preview"] == "OK"
        assert provider._anthropic is not None
        assert provider._anthropic._client.max_retries == 0
        assert provider._anthropic._client.api_key == TEST_KEY
        assert not provider._anthropic._client.auth_token
    finally:
        await provider.close()


@pytest.mark.parametrize("invalid_body", [[], None, "raw body must not be reflected", {}])
async def test_anthropic_malformed_response_is_a_safe_provider_error(
    invalid_body: Any, provider_factory: Callable[..., Any],
) -> None:
    provider = await provider_factory("anthropic", lambda _: _response("anthropic", invalid_body))
    try:
        with pytest.raises(ProviderError) as error:
            await provider.probe_chat()
        assert "raw body must not be reflected" not in str(error.value)
    finally:
        await provider.close()


@pytest.mark.parametrize("protocol", ["openai_responses", "anthropic"])
async def test_visible_text_blocks_are_joined_without_reasoning_or_tool_content(
    protocol: str, provider_factory: Callable[..., Any],
) -> None:
    text = json.dumps(ANSWER)
    body = _body(protocol, text[:10])
    if protocol == "openai_responses":
        body["output"][-1]["content"].append({"type": "output_text", "text": text[10:]})
        body["output"].insert(0, {"type": "function_call", "arguments": "not answer text"})
        body["output_text"] = "not answer text"
    else:
        body["content"].append({"type": "text", "text": text[10:]})
    provider = await provider_factory(protocol, lambda _: _response(protocol, body))
    try:
        assert (await provider.answer("Question", CHUNKS))["answer"] == ANSWER["answer"]
    finally:
        await provider.close()
