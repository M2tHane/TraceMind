# TraceMind API contract

Local-first workbench with accounts. FastAPI `/api`, raw JSON; all IDs (and `*_by` account references) serialized as strings (snowflake bigint in DB). Errors `{detail: string}`. Vite proxies `/api` to `http://127.0.0.1:8010`. Browser never receives model credentials. Tenant identity comes from server config, not request payload. Bind loopback only.

## Authentication and roles
- Every endpoint except GET `/health` and POST `/auth/login` requires a signed-in account: the HttpOnly `rag_session` cookie (SameSite=Lax, 7 days) or `Authorization: Bearer rwb_...` (personal access token). 401 `请先登录` otherwise.
- Accounts are created by administrators (no self-registration). New and reset accounts get a temporary password and `must_change_password=true`: until changed, a session may only call `/auth/me`, `/auth/password`, `/auth/logout` (others 403). Passwords: 10-128 chars, not containing the username, ≥5 distinct characters, stored as salted scrypt. 5 failed logins per username and client within 15 minutes → 429.
- Roles: `admin` and `employee`. Administrator-only: `/admin/*`, `/datasets`, `/questions`, `/runs`, `/tuning*`, `/settings` (incl. `/settings/check`, `/settings/test/*`), `/examples`, `/debug`, model-profile writes and tests (GET `/model-profiles` is open to all accounts). Others 403 `需要管理员权限`.
- Scopes: knowledge bases and memories are `platform` or `personal`. Platform libraries are visible to everyone and managed by administrators; employee uploads into them wait for approval (`review_status=pending`, `status=pending_review`, not parsed). Personal libraries, conversations and personal memories are visible to their owner only (also hidden from administrators); invisible resources answer 404.
- Audit: chat, `/debug` and MCP retrievals write query logs (question text for platform libraries only, metadata for personal ones); every MCP tool call writes an MCP call log (identifiers and sizes only).

## Types
- Account: `{id,username,display_name,role:admin|employee,must_change_password}`; `/auth/me` adds `via:session|token`.
- KnowledgeBase: `{id,name,description,scope:platform|personal,owner_id,can_manage,pending_count?,chunk_size,chunk_overlap,embedding_model,version,retrieval_config,document_count,ready_count,chunk_count,created_at}`. `pending_count` (documents awaiting review) is returned to administrators for platform libraries. `retrieval_config` is the default RetrievalConfig (`{}` = legacy method mapping).
- Document: `{id,knowledge_base_id,filename,source_type,replaces_document_id,uploaded_by,review_status,reviewed_by,reviewed_at,review_note,status,stage,error,page_count,chunk_count,created_at,updated_at}`. source_type pdf/markdown/text. review_status approved/pending/rejected. status pending_review/queued/processing/ready/failed/rejected/deleting. stage queued/parsing/chunking/embedding/indexing/ready/failed. `error` nullable.
- Chunk/Citation: `{id,document_id,filename,page,chunk_index,text,score?,context_before?,context_after?}`. page is parser page anchor, NOT exact geometric highlight. PDF URL `/api/documents/{document_id}/file#page={page}`.
- Method: `bm25|vector|hybrid|hybrid_rerank|no_context`.
- RetrievalConfig: `{routes:("vector"|"bm25")[],route_k:20,bm25_weight:1,vector_weight:1,rrf_k:60,fusion_k:20,rerank:true,query_rewrite:"none"|"multi_query",rewrite_count:3,min_score?:number,dedupe_threshold:1,mmr_lambda?:number,neighbor_window:0,top_k:5,document_ids?:string[]}`. Unknown fields rejected. `min_score` requires rerank. Legacy methods map onto it (bm25/vector = single route, hybrid = both, hybrid_rerank = both + rerank).
- TraceStage: `{stage,ms,count?,candidates?:[{rank,id,document_id,filename,page,score}],...params}`. stage scope/query_rewrite/recall.vector/recall.bm25/fusion/rerank/postprocess; recall stages repeat per query.
- RagResult: `{answer,citations: Citation[],contexts: Citation[],abstain,method,retrieval_config,queries,trace:TraceStage[],timing:{retrieval_ms,generation_ms},usage:{total_tokens},error?}`.
- Conversation: `{id,title,knowledge_base_id,owner_id,created_at}` (private to its owner)
- Message: `{id,conversation_id,role,content,status,stage,error,citations: Citation[],contexts: Citation[],method,timing,usage,retrieval_trace:{config,queries,stages,memories_used},created_at}`. role user/assistant; status queued/processing/completed/failed. Poll conversations while pending. Citations persist a source-text snapshot.
- Dataset: `{id,name,description,question_count,created_at}`
- Question: `{id,dataset_id,question,reference_answer,answerable,evidence:[{document_id?:string,doc_id?:string,page:number,quote:string}],review_status}`. `doc_id` is portable filename stem for imported examples. reference_answer may be empty. review_status pending/reviewed.
- Run: `{id,name,dataset_id,knowledge_base_id,status,methods:string[],judge_enabled,total,completed,failed,config,summary,created_at,error?}`. statuses queued/running/paused/completed/failed. config records KB/dataset snapshots.
- EvalItem: `{id,run_id,question_id,question,reference_answer,method,status,error,result:RagResult|null,metrics:object,judgment:object|null,judge_error:string|null}`. metrics include token_f1/exact_match when gold exists, hit_at_5/evidence_recall_at_5/mrr_at_10 when usable evidence exists; undefined fields aren't zeros. judgment `{correct,faithful,reason}` automatic proxy.

- Memory: `{id,user_id,scope,created_by,reviewed_by,content,category,tags,importance,source,status,merged_into_id,attributes,version,access_count,last_accessed_at,expires_at,has_embedding,created_at,updated_at}`. `user_id` is the namespace: `platform` or `user:<account id>`. category preference/profile/fact/goal/instruction/other; status active/pending/rejected/merged/deleted. Search results add `score` and `similarity`.
- MemoryEvent: `{id,memory_id,user_id,action,before,after,actor,created_at}`; action create/update/delete/restore/merge/purge/pending/approve/reject; actor `user:<id>`.
- TuningRun: `{id,name,knowledge_base_id,dataset_id,status,objective,candidates:[{name,config}],total,completed,failed,leaderboard,best,config,question_count,error}`. Leaderboard rows: `{name,questions,failed,latency_p50_ms,latency_p95_ms,hit_at_1/3/5/10,recall_at_5/10,mrr_at_10,ndcg_at_10}` (means; lexical evidence proxy).

## Endpoints
- GET `/health`: `{status,database}` (public)
- Auth:
  - POST `/auth/login` `{username,password}` → Account, sets the session cookie. POST `/auth/logout` → 204.
  - GET `/auth/me` → Account. POST `/auth/password` `{current_password,new_password}` → Account; signs out the account's other sessions.
  - GET `/auth/tokens` → `[{id,name,prefix,last_used_at,expires_at,revoked_at,created_at}]`; POST `{name,expires_days?}` (browser session only) → token row plus `token` (shown once); DELETE `/auth/tokens/{id}` revokes. Max 20 active tokens.
- Admin (administrators):
  - GET `/admin/users`; POST `/admin/users` `{username,display_name?,role?:employee}` → account plus `temporary_password` (shown once); PATCH `/admin/users/{id}` `{display_name?,role?,status?:active|disabled}` (cannot demote or disable yourself or the last active administrator; demoting/disabling signs the account out); POST `/admin/users/{id}/reset-password` → account plus `temporary_password`.
  - GET `/admin/reviews` → `{documents:[Document & {knowledge_base_name,uploader:{username,display_name}}],memories:[Memory & {author}]}`; GET `/admin/reviews/count` → `{documents,memories,total}`.
  - POST `/admin/reviews/documents/{id}` and `/admin/reviews/memories/{id}` `{approve,note?}`. Approving a document queues parsing; rejecting deletes its stored file.
  - GET `/admin/query-logs?user_id&knowledge_base_id&source=chat|debug|mcp&kb_scope&status&q&since&until&limit&offset` → `{total,items,limit,offset}`; items `{id,user_id,username,source,action,knowledge_base_id,knowledge_base_name,kb_scope,query|null,query_chars,method,result_count,latency_ms,status,error,created_at}`.
  - GET `/admin/mcp-logs?user_id&tool&status&since&until&limit&offset` → `{total,items,tools,limit,offset}`; items `{id,user_id,username,token_id,transport,tool,arguments,status,error,latency_ms,created_at}`.
- GET/POST `/knowledge-bases` (platform + own personal); POST body `{name,description?,scope?:personal|platform,chunk_size?:2200,chunk_overlap?:400}`; `scope=platform` is admin-only.
- GET `/knowledge-bases/{id}`
- GET `/knowledge-bases/{id}/documents`; POST same URL multipart `files` (PDF, .md, .markdown, .txt; up to 10).
- PUT `/knowledge-bases/{id}/retrieval-config` RetrievalConfig or `null` → KnowledgeBase (requires management rights). Chat messages using the default method and MCP `method=auto` use it.
- GET `/documents/{id}`; GET `/documents/{id}/file` PDF; GET `/documents/{id}/parsed`: `{markdown,chunks:Chunk[]}` (empty until available).
- POST `/documents/{id}/retry` resumes failed processing (management rights).
- PUT `/documents/{id}/content` multipart `file` (management rights) → new Document 202 (`replaces_document_id` = old). Old version stays searchable and is deleted when the new one is ready; if the new one fails, the old one remains.
- DELETE `/documents/{id}` removes vectors, chunks, row and files (management rights; uploaders may withdraw their own pending submissions); 409 while processing or while an evaluation freezes the library. Idempotent.
- GET/POST `/conversations`; POST `{knowledge_base_id,title?}`.
- GET `/conversations/{id}/messages`
- POST `/conversations/{id}/messages` `{content,method?:hybrid_rerank,top_k?:5,candidate_k?:20,model_profile_id?:string,retrieval?:RetrievalConfig}` -> assistant Message 202. The answer is personalized with the caller's personal and the platform memories. Backend persists user+assistant, freezes selected/default model and schedules generation. Message adds `model_profile_id` and public `model_snapshot`; credentials remain server-only.
- POST `/debug` `{knowledge_base_id,question,methods:string[],retrieval_only?:false,top_k?:5,candidate_k?:20,reference_answer?:string}` -> `{results:RagResult[]}`. Synchronous, may take minutes. No fake streaming. Retrieval-only returns empty answer. Optional `retrieval:RetrievalConfig` adds a result with method `custom`.
- GET/POST `/datasets`; POST `{name,description?}`.
- GET/POST `/datasets/{id}/questions`; POST Question fields without id/dataset_id.
- PATCH `/questions/{id}` editable Question fields.
- POST `/datasets/{id}/import` multipart `file` JSONL or CSV, atomic validation. CSV columns question,reference_answer,answerable; evidence as JSON optional.
- POST `/datasets/import-example` -> Dataset (idempotently import existing 100-question example; does NOT ingest PDFs). Example docs separately available via GET `/examples`: `[{name,url}]`, and GET `/examples/{name}` PDF. Names are attention.pdf,rag.pdf,react.pdf,lora.pdf.
- GET/POST `/runs`; POST `{name,knowledge_base_id,dataset_id,methods,limit?:10,judge_enabled?:false}`. methods max5; questions max1000. Default 10. Snapshot input; per-result commit. Judge opt-in.
- GET `/runs/{id}`; GET `/runs/{id}/items`
- POST `/runs/{id}/pause`, `/resume`, `/retry-failed`. Resume keeps complete answers; retry-failed only failed generation/missing judges, never valid judgments. No changing config in a run.
- GET `/runs/{id}/export` JSON download includes config, summary and items.
- GET/PATCH `/settings`: editable Embedding/Rerank/MinerU/Milvus configuration with write-only keys; PostgreSQL remains a startup setting. GET retains existing fields and adds `editable`, `milvus` and selected chat profile/protocol.
- GET/POST `/model-profiles`, PATCH/DELETE `/model-profiles/{id}`: multiple named chat profiles; OpenAI Chat, OpenAI Responses or Anthropic Messages. DELETE archives non-default profiles.
- POST `/model-profiles/{id}/test` and `/settings/test/{service}`: test saved configuration. Model probes require `{confirm:true}` and may be billed; infrastructure probes are read-only.
- POST `/settings/check` -> `{checks:[{name,status,detail}]}` checks PostgreSQL/MinerU/Milvus and reports key presence without calling models. No secrets returned.

Full request shapes, key semantics and snapshot behavior: [model configuration extension](model-configuration-api.md).

- Memory (signed-in account; `scope=personal` (default) is the caller's own namespace, `scope=platform` the shared one):
  - GET `/memories?scope&status=active|pending|rejected|merged|deleted|all&category&tag&limit&offset&mine` → `{total,items}`. Employees listing non-active platform memories see their own proposals only.
  - POST `/memories?scope` `{content,category?,tags?,importance?:3,attributes?,expires_at?,on_duplicate?:skip|update|insert,dedupe_threshold?:0.92}` → `{action:created|duplicate|updated|pending,similarity,memory}`. Employee platform writes become `pending` proposals.
  - POST `/memories/search?scope` `{query,top_k?:5,categories?,tags?,min_importance?,min_similarity?}` → `{results,searched,mode:hybrid|lexical,unembedded}`
  - GET/PATCH/DELETE `/memories/{id}?scope`; PATCH `{content?,category?,tags?,importance?,attributes?,expires_at?,clear_expiry?,expected_version?}` (409 on version mismatch); DELETE `&hard=false`. Platform PATCH/DELETE are admin-only (employees may DELETE their own pending proposal).
  - POST `/memories/{id}/restore?scope`; GET `/memories/{id}/history?scope` → MemoryEvent[]
  - POST `/memories/merge?scope` `{memory_ids,content?,category?,tags?,importance?}` → `{memory,merged}` (no content = chat model consolidates, may be billed). Platform: admin-only.
  - POST `/memories/extract` `{text,max_items?:10,dedupe_threshold?,dry_run?}` into personal memories (chat model, may be billed)
  - POST `/memories/reembed?scope` (platform: admin-only); DELETE `/memories?hard=false` clears the caller's personal memories.
- Tuning:
  - GET `/tuning/presets` → `{candidates,objectives,tunable_fields}`
  - GET/POST `/tuning-runs`; POST `{name,knowledge_base_id,dataset_id,candidates?:[{name,config}],grid?:{field:[values]},base?:RetrievalConfig,include_paid_rewrite?:false,objective?:mrr_at_10,limit?:100}`. Uses answerable questions with evidence; no answer generation.
  - GET `/tuning-runs/{id}?include_results=false`; POST `/tuning-runs/{id}/pause`, `/resume` (retries failed pairs), `/apply` `{candidate}` → KnowledgeBase.
- MCP: Streamable HTTP at `/mcp` (outside `/api`). See [`mcp.md`](mcp.md).

## Summary shape
Run summary `{by_method:{[method]:{count,completed,failed,scored,unscored,hit_at_5:number|null,evidence_recall_at_5:number|null,mrr_at_10:number|null,token_f1:number|null,auto_correct:number|null,retrieval_p95_ms:number|null,generation_p95_ms:number|null,total_tokens:number}},note:string}`. Ratios 0..1; missing labels null, denominator coverage explicit. All metrics marked automatic/lexical proxies, never human scores. Source IDs from output are checked against supplied contexts before citations are returned.
