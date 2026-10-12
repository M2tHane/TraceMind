"""Offline evaluation state-machine tests using an in-memory async-session double."""

from __future__ import annotations

import copy
from collections.abc import Awaitable, Callable
from types import SimpleNamespace
from typing import Any, Self

import pytest
from sqlalchemy.sql import operators

from app.models import EvalItem, EvalRun, KnowledgeBase
from app.services import evaluation
from app.services.providers import AccountUnavailable, ProviderError


def _source(identifier: str = "supplied", text: str = "The supported answer is blue.") -> dict[str, Any]:
    return {"id": identifier, "document_id": "9", "filename": "reference.pdf", "page": 1, "text": text}


def _result(answer: str = "blue") -> dict[str, Any]:
    return {
        "answer": answer, "abstain": False, "method": "hybrid_rerank", "citations": [_source()],
        "contexts": [_source(), _source("not-supplied", "UNSUPPLIED CANDIDATE MUST NOT REACH JUDGE")],
        "generation_context_ids": ["supplied"],
        "timing": {"retrieval_ms": 5.0, "generation_ms": 20.0}, "usage": {"total_tokens": 7},
    }


def _judgment(correct: bool = True) -> dict[str, Any]:
    return {"correct": correct, "faithful": True, "reason": "Supported by supplied context.",
            "usage": {"total_tokens": 3}}


def _item(identifier: int = 1, **changes: Any) -> EvalItem:
    attributes = {
        "id": identifier, "tenant_id": 123, "run_id": 10, "question_id": identifier + 100,
        "question": f"Question {identifier}", "reference_answer": "blue", "answerable": True,
        "evidence": [{"doc_id": "reference", "page": 1, "quote": "The supported answer is blue."}],
        "method": "hybrid_rerank", "status": "queued", "error": None, "result_payload": None,
        "metrics": {}, "judgment": None, "judge_error": None, "attempts": 0, "judge_attempts": 0,
        "attempt_history": [],
    }
    return EvalItem(**{**attributes, **changes})


@pytest.fixture
def workspace(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    config = SimpleNamespace(tenant_id=123, chat_model="chat-v1", embedding_model="embed-v1",
                             embedding_dimensions=3, rerank_model="rerank-v1", max_output_tokens=2048,
                             chat_base_url="http://chat.test/v1", embedding_base_url="http://embed.test/v1",
                             rerank_base_url="http://rerank.test", chat_protocol="openai_chat", json_mode=True,
                             rerank_protocol="dashscope", milvus_uri="http://milvus.test:19530",
                             milvus_collection="rag_workbench_test")
    run = EvalRun(id=10, tenant_id=123, name="offline", dataset_id=2, knowledge_base_id=3,
                  status="queued", methods=["hybrid_rerank"], judge_enabled=False, total=1,
                  completed=0, failed=0, config={"kb_version": 1, "chat_model": config.chat_model,
                                               "embedding_model": config.embedding_model,
                                               "rerank_model": config.rerank_model, "embedding_dimensions": 3,
                                               "top_k": 5, "candidate_k": 20}, summary={}, error=None)
    kb = KnowledgeBase(id=3, tenant_id=123, name="offline", version=1,
                       embedding_model=config.embedding_model, embedding_dimensions=3,
                       index_config={"embedding_base_url": config.embedding_base_url,
                                     "milvus_uri": config.milvus_uri, "milvus_collection": config.milvus_collection})
    state: dict[str, Any] = {"run": run, "kb": kb, "items": [_item()], "settings": config,
                             "active_transactions": 0, "commits": [], "answer_calls": [], "judge_calls": [],
                             "model_calls": 0, "provider_closed": 0}

    def selected(statement: Any) -> list[Any]:
        entity = statement.column_descriptions[0]["entity"]
        rows = {EvalRun: [state["run"]], KnowledgeBase: [state["kb"]], EvalItem: state["items"]}[entity]
        conditions = statement._where_criteria
        assert any(clause.left.key == "tenant_id" for clause in conditions), "Every DB query must be tenant-scoped"
        for clause in conditions:
            if clause.operator is operators.eq:
                rows = [row for row in rows if getattr(row, clause.left.key) == clause.right.value]
            elif clause.operator is operators.in_op:
                rows = [row for row in rows if getattr(row, clause.left.key) in clause.right.value]
            else:
                raise AssertionError("Unexpected query condition in test double")
        return sorted(rows, key=lambda row: row.id)

    class Result:
        def __init__(self, rows: list[Any]) -> None:
            self.rows = rows

        def scalars(self) -> Result:
            return self

        def all(self) -> list[Any]:
            return self.rows

    class Transaction:
        async def __aenter__(self) -> Self:
            state["active_transactions"] += 1
            return self

        async def __aexit__(self, exc_type: object, exc: object, tb: object) -> None:
            state["active_transactions"] -= 1
            if exc_type is None:
                state["commits"].append({item.id: copy.deepcopy(item.result_payload) for item in state["items"]})

    class FakeSession:
        async def __aenter__(self) -> Self:
            return self

        async def __aexit__(self, exc_type: object, exc: object, tb: object) -> None:
            return None

        def begin(self) -> Transaction:
            return Transaction()

        async def scalar(self, statement: Any) -> Any:
            rows = selected(statement)
            return rows[0] if rows else None

        async def execute(self, statement: Any) -> Result:
            return Result(selected(statement))

    async def fake_answer(
        knowledge_base_id: int, question: str, *, method: str, top_k: int, candidate_k: int,
        before_model_call: Callable[[], Awaitable[None]], runtime_settings: object,
    ) -> dict[str, Any]:
        assert runtime_settings is config
        assert state["active_transactions"] == 0
        state["answer_calls"].append((knowledge_base_id, question, method, top_k, candidate_k))
        await before_model_call()
        assert state["active_transactions"] == 0
        state["model_calls"] += 1
        if (error := state.get("answer_error")) and (
            not state.get("fail_first_only") or len(state["answer_calls"]) == 1
        ):
            raise error
        if state.get("pause_between_calls"):
            state["run"].status = "paused"
            await before_model_call()
            raise AssertionError("No model call should start after pause")
        return _result()

    class FakeProviders:
        def __init__(self, settings: object) -> None:
            assert settings is config

        async def judge(
            self, question: str, reference_answer: str, answerable: bool, result: dict[str, Any],
        ) -> dict[str, Any]:
            assert state["active_transactions"] == 0
            assert any(any(payload for payload in commit.values()) for commit in state["commits"])
            state["judge_calls"].append((question, reference_answer, answerable, copy.deepcopy(result)))
            if error := state.get("judge_error"):
                raise error
            return copy.deepcopy(state.get("judge_response", _judgment()))

        async def close(self) -> None:
            state["provider_closed"] += 1
            if state.get("close_error"):
                raise RuntimeError("secret cleanup details")

    async def resolve_settings() -> object:
        return config

    monkeypatch.setattr(evaluation, "settings", config)
    monkeypatch.setattr(evaluation, "resolve_settings", resolve_settings)
    monkeypatch.setattr(evaluation, "Session", FakeSession)
    monkeypatch.setattr(evaluation, "answer_question", fake_answer)
    monkeypatch.setattr(evaluation, "Providers", FakeProviders)
    return state


def test_summary_failed_labeled_rows_stay_in_denominators_and_missing_gold_is_null() -> None:
    completed = _item(1, status="completed", result_payload=_result())
    failed = _item(2, status="failed")
    unlabeled = _item(3, status="failed", reference_answer="", evidence=[])
    summary = evaluation._build_summary([completed, failed, unlabeled], ["hybrid_rerank", "no_context"])
    method = summary["by_method"]["hybrid_rerank"]
    assert method["count"] == 3 and method["completed"] == 1 and method["failed"] == 2
    assert method["token_f1"] == 0.5 and method["exact_match"] == 0.5
    assert method["hit_at_5"] == 0.5 and method["evidence_recall_at_5"] == 0.5
    assert method["token_f1_denominator"] == 2 and method["hit_at_5_denominator"] == 2
    assert method["auto_correct"] is None and method["scored"] == 0 and method["unscored"] == 3
    assert method["generation_p95_ms"] == 20 and method["retrieval_p95_ms"] == 5
    assert method["total_tokens"] == 7
    assert summary["by_method"]["no_context"]["token_f1"] is None
    assert "lexical" in summary["note"]


def test_summary_pending_cohort_and_missing_judge_do_not_become_final_accuracy() -> None:
    correct = _item(1, status="completed", result_payload=_result(), judgment=_judgment())
    unscored = _item(2, status="completed", result_payload=_result())
    partial = evaluation._build_summary([correct, unscored], ["hybrid_rerank"])["by_method"]["hybrid_rerank"]
    assert partial["auto_correct"] is None and partial["scored"] == 1 and partial["unscored"] == 1
    unscored.judgment = _judgment(False)
    final = evaluation._build_summary([correct, unscored], ["hybrid_rerank"])["by_method"]["hybrid_rerank"]
    assert final["auto_correct"] == 0.5
    assert final["total_tokens"] == 20
    unscored.status = "queued"
    pending = evaluation._build_summary([correct, unscored], ["hybrid_rerank"])["by_method"]["hybrid_rerank"]
    assert pending["token_f1"] is None and pending["auto_correct"] is None
    assert pending["pending"] == 1 and pending["evaluation_complete"] is False


def test_summary_reuses_persisted_metrics_and_nearest_rank_p95(monkeypatch: pytest.MonkeyPatch) -> None:
    item = _item(status="completed", result_payload=_result())
    item.metrics = evaluation._metrics(item)

    def do_not_realign(row: EvalItem) -> dict[str, Any]:
        raise AssertionError("Summary must reuse complete persisted lexical metrics")

    monkeypatch.setattr(evaluation, "_metrics", do_not_realign)
    summary = evaluation._build_summary([item], ["hybrid_rerank"])
    assert summary["by_method"]["hybrid_rerank"]["token_f1"] == 1
    assert evaluation._p95([float(value) for value in range(1, 101)]) == 95
    assert evaluation._p95([]) is None


def test_judge_receives_only_actual_generation_sources_without_mutating_snapshot() -> None:
    result = _result()
    original = copy.deepcopy(result)
    candidate = evaluation._judge_input(result)
    assert [row["id"] for row in candidate["contexts"]] == ["supplied"]
    assert "UNSUPPLIED" not in str(candidate)
    assert result == original
    del result["generation_context_ids"]
    with pytest.raises(ProviderError, match="snapshot"):
        evaluation._judge_input(result)


async def test_execute_persists_answers_then_judges_without_gold_leak(workspace: dict[str, Any]) -> None:
    workspace["run"].judge_enabled = True
    await evaluation.execute_run(10)
    item = workspace["items"][0]
    assert workspace["answer_calls"] == [(3, "Question 1", "hybrid_rerank", 5, 20)]
    question, reference, answerable, candidate = workspace["judge_calls"][0]
    assert (question, reference, answerable) == ("Question 1", "blue", True)
    assert "UNSUPPLIED" not in str(candidate)
    assert len(item.result_payload["contexts"]) == 2  # Complete retrieval trace is still saved.
    assert item.status == "completed" and item.attempts == 1 and item.judge_attempts == 1
    assert item.metrics["token_f1"] == 1
    assert workspace["run"].status == "completed" and workspace["run"].completed == 1
    assert workspace["run"].summary["by_method"]["hybrid_rerank"]["auto_correct"] == 1
    assert workspace["provider_closed"] == 1


async def test_resume_reuses_answer_and_valid_judgment_without_paid_calls(workspace: dict[str, Any]) -> None:
    workspace["run"].judge_enabled = True
    item = workspace["items"][0]
    item.result_payload, item.judgment = _result(), _judgment()
    item.attempts, item.judge_attempts = 1, 1
    await evaluation.execute_run(10)
    assert workspace["answer_calls"] == [] and workspace["judge_calls"] == []
    assert item.attempts == 1 and item.judge_attempts == 1 and item.status == "completed"


async def test_missing_judge_only_retry_keeps_answer_and_appends_failed_audit(workspace: dict[str, Any]) -> None:
    workspace["run"].judge_enabled = True
    workspace["judge_error"] = ProviderError("Judge model returned invalid final JSON")
    await evaluation.execute_run(10)
    item = workspace["items"][0]
    original = copy.deepcopy(item.result_payload)
    assert item.status == "completed" and item.judgment is None and item.judge_error
    assert item.attempt_history[0]["stage"] == "judge" and item.attempt_history[0]["attempt"] == 1
    assert workspace["run"].summary["by_method"]["hybrid_rerank"]["auto_correct"] is None
    # A normal duplicate worker invocation does not automatically retry completed judgments.
    await evaluation.execute_run(10)
    assert len(workspace["judge_calls"]) == 1
    workspace["run"].status, item.status = "queued", "queued"
    del workspace["judge_error"]
    await evaluation.execute_run(10)
    assert len(workspace["answer_calls"]) == 1 and len(workspace["judge_calls"]) == 2
    assert item.result_payload == original and item.judgment["correct"] is True
    assert item.judge_error is None and len(item.attempt_history) == 1


async def test_account_unavailable_during_judge_pauses_with_answer_checkpoint(workspace: dict[str, Any]) -> None:
    workspace["run"].judge_enabled = True
    workspace["items"].append(_item(2))
    workspace["judge_error"] = AccountUnavailable("Model account is unavailable")
    await evaluation.execute_run(10)
    first, second = workspace["items"]
    assert workspace["run"].status == "paused" and workspace["run"].completed == 1
    assert first.status == "queued" and first.result_payload and first.judgment is None
    assert first.judge_error and second.attempts == 0
    workspace["run"].status = "queued"
    del workspace["judge_error"]
    await evaluation.execute_run(10)
    assert first.attempts == 1 and first.judge_attempts == 2
    assert len(workspace["answer_calls"]) == 2 and workspace["run"].status == "completed"


async def test_generation_failure_is_local_and_does_not_disappear_from_summary(workspace: dict[str, Any]) -> None:
    workspace["items"].append(_item(2))
    workspace["answer_error"] = RuntimeError("secret api key and raw provider details")
    workspace["fail_first_only"] = True
    await evaluation.execute_run(10)
    first, second = workspace["items"]
    assert first.status == "failed" and second.status == "completed"
    assert "secret" not in str(first.attempt_history) and "secret" not in first.error
    assert workspace["run"].failed == 1 and workspace["run"].completed == 1
    summary = workspace["run"].summary["by_method"]["hybrid_rerank"]
    assert summary["token_f1"] == 0.5 and summary["token_f1_denominator"] == 2
    assert summary["auto_correct"] is None and summary["unscored"] == 2


async def test_generation_quota_stops_run_immediately(workspace: dict[str, Any]) -> None:
    workspace["items"].append(_item(2))
    workspace["answer_error"] = AccountUnavailable("Model credits unavailable")
    await evaluation.execute_run(10)
    assert workspace["run"].status == "paused"
    assert len(workspace["answer_calls"]) == 1
    assert workspace["items"][0].status == "queued" and workspace["items"][0].attempts == 1
    assert workspace["items"][1].attempts == 0
    assert workspace["run"].summary["by_method"]["hybrid_rerank"]["token_f1"] is None


async def test_pause_is_checked_between_internal_model_calls(workspace: dict[str, Any]) -> None:
    workspace["pause_between_calls"] = True
    await evaluation.execute_run(10)
    assert workspace["model_calls"] == 1
    assert workspace["run"].status == "paused" and workspace["items"][0].status == "queued"
    assert workspace["items"][0].result_payload is None
    assert workspace["items"][0].attempt_history == []  # Explicit pause is not an error attempt.


@pytest.mark.parametrize("mismatch", ["chat_model", "embedding_model", "rerank_model", "embedding_dimensions",
                                      "kb_version", "max_output_tokens", "chat_base_url"])
async def test_snapshot_mismatch_pauses_before_any_paid_attempt(workspace: dict[str, Any], mismatch: str) -> None:
    workspace["run"].config[mismatch] = "changed"
    await evaluation.execute_run(10)
    assert workspace["run"].status == "paused" and "snapshot" in workspace["run"].error
    assert workspace["answer_calls"] == [] and workspace["items"][0].attempts == 0


async def test_attempt_caps_block_paid_loops_and_preserve_missing_judge(workspace: dict[str, Any]) -> None:
    workspace["run"].judge_enabled = True
    first = workspace["items"][0]
    first.attempts = 3
    second = _item(2, result_payload=_result(), attempts=1, judge_attempts=3)
    workspace["items"].append(second)
    await evaluation.execute_run(10)
    assert first.status == "failed" and "limit" in first.error
    assert second.status == "completed" and second.judgment is None and "limit" in second.judge_error
    assert workspace["answer_calls"] == [] and workspace["judge_calls"] == []
    assert first.attempts == 3 and second.judge_attempts == 3


async def test_missing_generation_snapshot_withholds_judge_without_fabricated_label(workspace: dict[str, Any]) -> None:
    workspace["run"].judge_enabled = True
    item = workspace["items"][0]
    item.result_payload = _result()
    del item.result_payload["generation_context_ids"]
    await evaluation.execute_run(10)
    assert workspace["judge_calls"] == [] and workspace["answer_calls"] == []
    assert item.judgment is None and "snapshot" in item.judge_error and item.status == "completed"
    assert item.judge_attempts == 1


async def test_cleanup_failure_does_not_discard_paid_valid_judgment(workspace: dict[str, Any]) -> None:
    workspace["run"].judge_enabled = True
    workspace["close_error"] = True
    await evaluation.execute_run(10)
    assert workspace["items"][0].judgment["correct"] is True
    assert workspace["items"][0].status == "completed"


async def test_refresh_summary_keeps_paused_status_and_counts_available_answers(workspace: dict[str, Any]) -> None:
    workspace["run"].status = "paused"
    workspace["items"][0].result_payload = _result()
    summary = await evaluation.refresh_summary(10)
    assert workspace["run"].status == "paused" and workspace["run"].completed == 1
    assert summary["by_method"]["hybrid_rerank"]["pending"] == 1
    assert summary["by_method"]["hybrid_rerank"]["token_f1"] is None
