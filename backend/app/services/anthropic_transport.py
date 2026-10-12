"""Isolated official Anthropic SDK transport; never resolves ambient credentials.

This module is loaded only when the explicitly selected protocol is ``anthropic``.
It sends a single Messages request, with no fallback model or automatic retries.
"""

from __future__ import annotations

import logging
from typing import cast

import anthropic
from anthropic.types import Message, MessageParam

from .providers import _failure, _quota_error, _url, _usage

# SDK debug logs include request bodies. Application-safe failures are logged by
# _failure instead; do not let ANTHROPIC_LOG enable payload logging in this service.
logging.getLogger("anthropic").setLevel(logging.CRITICAL + 1)
logging.getLogger("anthropic._base_client").disabled = True


class AnthropicTransport:
    """Messages transport using only the user's explicit endpoint and API key."""

    def __init__(self, *, api_key: str, base_url: str, timeout: float) -> None:
        if not api_key.strip():
            raise _failure("Anthropic API key must be explicitly configured")
        _url(base_url, "messages")  # Shared validation rejects URL credentials and query strings.
        base = base_url.rstrip("/")
        if base.endswith("/messages"):
            base = base[:-len("/messages")]
        if base.endswith("/v1"):
            base = base[:-len("/v1")]
        # Use the SDK HTTP client, not the OpenAI httpx pool: SDK 1.x uses httpx2.
        # An empty auth_token prevents older SDKs reading ANTHROPIC_AUTH_TOKEN;
        # an explicit nonempty api_key also bypasses SDK OAuth profile discovery.
        self._client = anthropic.AsyncAnthropic(
            api_key=api_key, auth_token="", base_url=base + "/", max_retries=0, timeout=timeout,
            default_headers={"Authorization": anthropic.omit, "X-Api-Key": api_key,
                             "anthropic-beta": anthropic.omit},
            http_client=anthropic.DefaultAsyncHttpxClient(
                timeout=timeout, trust_env=False, follow_redirects=False,
            ),
        )

    async def close(self) -> None:
        """Release this SDK client's independent connection pool."""
        await self._client.close()

    async def complete(
        self, *, model: str, messages: list[dict[str, str]], max_tokens: int,
    ) -> tuple[str, dict[str, int]]:
        """Return only visible text and validated usage from one complete response."""
        system: list[str] = []
        turns: list[MessageParam] = []
        for message in messages:
            if message.get("role") == "system" and not turns:
                system.append(message["content"])
            elif message.get("role") in {"user", "assistant"}:
                turns.append(cast(MessageParam, dict(message)))
            else:
                raise _failure("Anthropic history must contain user or assistant text messages")
        try:
            # Existing answer/judge prompts request JSON themselves. Do not send
            # OpenAI response_format or model-gated sampling/thinking parameters.
            response = await self._client.messages.create(
                model=model, messages=turns, system="\n\n".join(system), max_tokens=max_tokens,
            )
        except anthropic.APITimeoutError:
            raise _failure("Model service timed out; request was not replayed") from None
        except anthropic.APIConnectionError:
            raise _failure("Model service transport failed; request was not replayed") from None
        except anthropic.APIStatusError as error:
            if _quota_error(error.body):
                raise _failure("Model account has no available credits or is unavailable", account=True) from None
            if error.status_code == 429:
                raise _failure("Model service rate limited the request; request was not replayed") from None
            raise _failure(f"Model service rejected the request (HTTP {error.status_code})") from None
        except anthropic.APIError:
            raise _failure("Model service returned an invalid response") from None
        except (TypeError, ValueError):
            raise _failure("Model service could not process the configured request") from None

        if not isinstance(response, Message):
            raise _failure("Chat model returned an invalid response object")
        # Do not emit Pydantic serializer warnings containing malformed remote values.
        payload = response.model_dump(mode="json", warnings=False)
        if payload.get("error"):
            if _quota_error(payload["error"]):
                raise _failure("Model account has no available credits or is unavailable", account=True)
            raise _failure("Model service rejected the request")
        if payload.get("stop_reason") == "refusal":
            raise _failure("Chat model declined the request; no valid answer was saved")
        if payload.get("stop_reason") not in {"end_turn", "stop_sequence"}:
            raise _failure("Chat response is truncated or incomplete; no valid answer was saved")
        if payload.get("type") != "message" or payload.get("role") != "assistant":
            raise _failure("Chat model returned an invalid response object")
        blocks = payload.get("content")
        if not isinstance(blocks, list):
            raise _failure("Chat model returned invalid output")
        text: list[str] = []
        for block in blocks:
            if not isinstance(block, dict):
                raise _failure("Chat model returned invalid output")
            if block.get("type") == "refusal":
                raise _failure("Chat model declined the request; no valid answer was saved")
            if block.get("type") == "text":
                if not isinstance(block.get("text"), str):
                    raise _failure("Chat model returned invalid output text")
                text.append(block["text"])
        return "".join(text), _usage(payload)
