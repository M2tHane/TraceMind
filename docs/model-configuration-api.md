# Configurable models extension

All new endpoints remain under `/api`. IDs are strings. Existing APIs stay compatible. Secrets are write-only: browser receives `api_key_set`, never the key or ciphertext. Tests are limited to this feature; no full suite and no 100-question run.

## Model profiles

`GET /model-profiles` -> `ModelProfile[]`

ModelProfile: `{id,name,model,protocol,base_url,api_key_set,is_default,enabled,max_tokens,timeout_seconds,json_mode,updated_at}`.
Protocols: `openai_chat`, `openai_responses`, `anthropic`.

- `POST /model-profiles` -> profile, body `{name,model,protocol,base_url,api_key?:string,max_tokens?:4096,timeout_seconds?:120,json_mode?:true,enabled?:true,is_default?:false}`.
- `PATCH /model-profiles/{id}` -> profile; partial fields. Omit `api_key` to retain it, empty string clears it. Cannot disable default before another default is chosen.
- `DELETE /model-profiles/{id}` -> 204; archives profile, cannot archive default. Messages keep original public model snapshots.
- `POST /model-profiles/{id}/test` body `{confirm:true}` -> `{success:boolean,detail:string,latency_ms:number,model:string,protocol:string,usage:{total_tokens:number},preview?:string}`. ONE short real model request; no document data. Never auto-trigger it. Confirm UI explains possible model charge. Errors safe, no remote body echo.
- Initial setup imports the old env chat configuration as one default profile, encrypted server-side. No model list is hardcoded into frontend.

## Service configuration

`GET /settings` remains compatible, adds:
```
embedding: {model,base_url,configured,dimensions}
rerank: {model,base_url,configured,protocol:"dashscope"|"standard"}
mineru: {base_url}
milvus: {uri,collection}
chat: {model,base_url,configured,profile_id,protocol}
storage: {backend:"PostgreSQL + Milvus",local_only:true}
editable: true
```
`PATCH /settings` accepts any subset:
- `embedding:{model?,base_url?,api_key?,dimensions?}`
- `rerank:{model?,base_url?,api_key?,protocol?}`
- `mineru:{base_url?}`
- `milvus:{uri?,collection?}` (collection restricted to rag_workbench_* namespace)
Returns new settings. Write-only secret semantics same as profiles. Changes affect new operations immediately; existing jobs hold their request's model snapshot. Changing embedding model/dimensions/endpoint can invalidate existing indexed libraries; UI must warn that existing libraries need compatible settings/re-indexing, no silent rebuilding. PostgreSQL remains bootstrap storage (no browser-driven live DB switch).

`POST /settings/test/{service}` service embedding/rerank/mineru/milvus/postgres, body `{confirm?:false}` -> `{success,detail,latency_ms,usage?:{total_tokens}}`.
Embedding/rerank require confirm:true and perform one tiny real request; MinerU/Milvus/Postgres are read-only connectivity checks. Saved settings are tested; save before testing. Existing `/settings/check` remains non-billed health/config check.

## Chat model selection

POST `/conversations/{id}/messages` adds optional `model_profile_id:string`. Backend validates tenant+enabled profile and snapshots it into job params before queueing. Default selected if omitted. No arbitrary model URL/key accepted in messages.
Message output adds `model_profile_id:string|null` and `model_snapshot:{id,name,model,protocol,...}` (public only, no secrets).
Composer shows enabled models from GET /model-profiles as a compact borderless Radix selector near retrieval settings; no fake thinking-level widget. Selection only affects new messages. Persist per-conversation convenience in browser storage safely if desired, but backend message snapshot is authoritative. Models can change between turns; old messages retain their model.
KB selection moves immediately after the chat heading, not right-aligned.

## Persistence and compatibility

Alembic `002_configuration` adds `model_profiles`, `service_configurations`, `messages.model_profile_id`, `messages.model_snapshot`, and `knowledge_bases.index_config`. IDs are BIGINT Snowflakes with no foreign keys. One active default profile and one service-configuration row per tenant are enforced by unique indexes. Profile mutations serialize through the tenant configuration row; resource queries include tenant scope and unauthorized resources return 404.

API keys are Fernet-encrypted in PostgreSQL. The local encryption key is `data/.secrets/configuration.key` (0600 in a 0700 directory); back it up securely with the database. It is never returned or committed. The configuration row is also the one-time env-import marker. Reboot does not overwrite saved configuration. Partial input validation omits raw input/context from 422 responses.

Profile limits: `max_tokens` 16–65536, `timeout_seconds` 5–600; embedding dimensions 1–32768. Endpoints allow HTTP(S) only and reject embedded credentials, query strings and fragments. Anthropic uses the official Python SDK (tested with 1.9.0), explicitly configured credentials, no ambient OAuth or fallback model. `json_mode` controls OpenAI-native JSON parameters only; Anthropic relies on the JSON prompt and the same strict local validation. Standard rerank posts query/documents/top_n to the API base's `/rerank`; DashScope uses the native double `text-rerank` path with a bare-host base URL.

Legacy KBs receive the original embedding endpoint/Milvus identity once during bootstrap. New KBs freeze current identity. Changing embedding model/dimensions/endpoint or vector-store identity never silently mixes indexes: restore compatible settings or create/reingest a new library. Existing jobs hold their chat snapshot; service settings are copied once at task start. Evaluations capture default model/protocol/endpoints/budget and pause on incompatible configuration at resume instead of silently changing the experiment.

## Backend integration interfaces
`app.services.configuration.resolve_settings(model_config:dict|None=None, db:AsyncSession|None=None) -> Settings` async returns copied runtime settings, never mutates global settings. Settings adds chat_protocol/json_mode/rerank_protocol.
`get_chat_snapshot(db,profile_id:int|None)->dict` server-only returns encrypted credential snapshot `{id,name,model,protocol,base_url,max_tokens,timeout_seconds,json_mode,api_key_ciphertext}`; `public_snapshot(snapshot)` removes ciphertext.
`Providers(settings)` uses resolved settings. Existing answer/judge/embed/rerank APIs unchanged. New `probe_chat()->dict` returns safe short probe text/usage/latency via selected protocol. `_post` remains bounded, sanitized, no replay after timeout.
