import type { ModelProtocol, PublicModelSnapshot, RerankProtocol } from './configuration'

export type Method = 'bm25' | 'vector' | 'hybrid' | 'hybrid_rerank' | 'no_context'
export const METHODS: { value: Method; label: string; description: string }[] = [
  { value: 'bm25', label: 'BM25', description: '关键词检索' },
  { value: 'vector', label: '向量检索', description: '语义相似度' },
  { value: 'hybrid', label: '混合检索', description: '关键词 + 向量' },
  { value: 'hybrid_rerank', label: '混合 + 重排', description: '混合召回后重排序' },
  { value: 'no_context', label: '无上下文', description: '不检索知识库的基线' },
]
export const methodLabel = (value: string): string => value === 'custom' ? '自定义流水线' : METHODS.find(m => m.value === value)?.label ?? value
export type Scope = 'platform' | 'personal'
export interface KnowledgeBase { retrieval_config?: Partial<RetrievalConfig>; scope: Scope; owner_id: string | null; can_manage: boolean; pending_count?: number; id: string; name: string; description: string; chunk_size: number; chunk_overlap: number; embedding_model: string; version: number; document_count: number; ready_count: number; chunk_count: number; created_at: string }
export interface Document { review_status?: 'approved' | 'pending' | 'rejected'; uploaded_by?: string | null; reviewed_by?: string | null; reviewed_at?: string | null; review_note?: string | null; id: string; knowledge_base_id: string; filename: string; source_type?: 'pdf' | 'markdown' | 'text'; replaces_document_id?: string | null; status: string; stage: string; error: string | null; page_count: number | null; chunk_count: number; created_at: string; updated_at: string }
export interface Citation { id: string; document_id: string; filename: string; page: number | null; text: string; score?: number }
export interface Timing { retrieval_ms?: number; generation_ms?: number }
export interface Usage { total_tokens?: number }
export interface RetrievalConfig { routes: ('vector' | 'bm25')[]; route_k: number; bm25_weight: number; vector_weight: number; rrf_k: number; fusion_k: number; rerank: boolean; query_rewrite: 'none' | 'multi_query'; rewrite_count: number; min_score: number | null; dedupe_threshold: number; mmr_lambda: number | null; neighbor_window: number; top_k: number; document_ids?: string[] | null }
export const DEFAULT_RETRIEVAL: RetrievalConfig = { routes: ['vector', 'bm25'], route_k: 20, bm25_weight: 1, vector_weight: 1, rrf_k: 60, fusion_k: 20, rerank: true, query_rewrite: 'none', rewrite_count: 3, min_score: null, dedupe_threshold: 1, mmr_lambda: null, neighbor_window: 0, top_k: 5 }
export interface TraceCandidate { rank: number; id: string; document_id: string; filename: string; page: number | null; score: number; text?: string }
export interface TraceStage { stage: string; ms: number; count?: number; candidates?: TraceCandidate[]; query?: string; queries?: string[]; [key: string]: unknown }
export interface RetrievalTrace { config: RetrievalConfig | null; queries: string[]; stages: TraceStage[] }
export interface RagResult { answer: string; citations: Citation[]; contexts: Citation[]; abstain: boolean; method: Method | 'custom'; timing: Timing; usage: Usage; error?: string; trace?: TraceStage[]; queries?: string[]; retrieval_config?: RetrievalConfig | null }
export interface Conversation { id: string; title: string; knowledge_base_id: string; created_at: string }
export interface Message { model_profile_id?: string | null; model_snapshot?: PublicModelSnapshot | null; id: string; conversation_id: string; role: 'user' | 'assistant'; content: string; status: string; stage: string; error: string | null; citations: Citation[]; contexts: Citation[]; method: Method; timing: Timing | null; usage: Usage | null; retrieval_trace?: RetrievalTrace | null; created_at: string }
export interface Dataset { id: string; name: string; description: string; question_count: number; created_at: string }
export interface Evidence { document_id?: string | null; doc_id?: string | null; page: number; quote: string }
export interface QuestionFields { question: string; reference_answer: string; answerable: boolean; evidence: Evidence[]; review_status: 'pending' | 'reviewed' }
export interface Question extends QuestionFields { id: string; dataset_id: string }
export interface SummaryMethod { count: number; completed: number; failed: number; scored: number; unscored: number; hit_at_5: number | null; evidence_recall_at_5: number | null; mrr_at_10: number | null; token_f1: number | null; auto_correct: number | null; retrieval_p95_ms: number | null; generation_p95_ms: number | null; total_tokens: number }
export interface Run { id: string; name: string; dataset_id: string; knowledge_base_id: string; status: string; methods: Method[]; judge_enabled: boolean; total: number; completed: number; failed: number; config: Record<string, unknown>; summary: { by_method?: Record<string, SummaryMethod>; note?: string }; created_at: string; error?: string | null }
export interface EvalItem { id: string; run_id: string; question_id: string; question: string; reference_answer: string; method: Method; status: string; error: string | null; result: RagResult | null; metrics: Record<string, number | string | boolean | null>; judgment: { correct: boolean; faithful: boolean; reason: string } | null; judge_error: string | null }
export interface Settings {
  chat: { model: string; base_url: string; configured: boolean; profile_id?: string; protocol?: ModelProtocol }
  embedding: { model: string; base_url: string; configured: boolean; dimensions: number }
  rerank: { model: string; base_url: string; configured: boolean; protocol: RerankProtocol }
  mineru: { base_url: string }
  milvus: { uri: string; collection: string }
  storage: { backend: string; local_only: boolean }
  config_file?: string
  editable: boolean
}
export interface ServiceCheck { name: string; status: string; detail: string }
export type MemoryCategory = 'preference' | 'profile' | 'fact' | 'goal' | 'instruction' | 'other'
export const MEMORY_CATEGORIES: { value: MemoryCategory; label: string }[] = [
  { value: 'preference', label: '偏好' }, { value: 'profile', label: '画像' }, { value: 'fact', label: '事实' },
  { value: 'goal', label: '目标' }, { value: 'instruction', label: '指令' }, { value: 'other', label: '其他' },
]
export const memoryCategoryLabel = (value: string): string => MEMORY_CATEGORIES.find(c => c.value === value)?.label ?? value
export interface Memory { id: string; user_id: string; content: string; category: MemoryCategory; tags: string[]; importance: number; source: string; status: 'active' | 'pending' | 'rejected' | 'merged' | 'deleted'; scope?: Scope; created_by?: string | null; reviewed_by?: string | null; author?: string; merged_into_id: string | null; attributes: Record<string, unknown>; version: number; access_count: number; last_accessed_at: string | null; expires_at: string | null; has_embedding: boolean; created_at: string; updated_at: string; score?: number; similarity?: number | null }
export interface MemoryEvent { id: string; memory_id: string; user_id: string; action: string; before: Partial<Memory> | null; after: Partial<Memory> | null; actor: string; created_at: string }
export interface MemoryUser { user_id: string; active: number; total: number; updated_at: string }
export interface MemorySearchResult { results: Memory[]; searched: number; mode: 'hybrid' | 'lexical'; unembedded: number }
export interface LeaderboardRow { name: string; questions: number; failed: number; latency_p50_ms: number | null; latency_p95_ms: number | null; hit_at_1: number | null; hit_at_3: number | null; hit_at_5: number | null; hit_at_10: number | null; recall_at_5: number | null; recall_at_10: number | null; mrr_at_10: number | null; ndcg_at_10: number | null }
export interface TuningRun { id: string; name: string; knowledge_base_id: string; dataset_id: string; status: string; objective: string; candidates: { name: string; config: RetrievalConfig }[]; total: number; completed: number; failed: number; leaderboard: LeaderboardRow[]; best: LeaderboardRow | null; config: Record<string, unknown>; question_count: number; error: string | null; created_at: string }
export interface TuningPresets { candidates: { name: string; config: RetrievalConfig }[]; objectives: string[]; tunable_fields: string[] }
export type Role = 'admin' | 'employee'
export interface Account { id: string; username: string; display_name: string; role: Role; must_change_password: boolean; via?: 'session' | 'token' }
export interface UserAccount { id: string; username: string; display_name: string; role: Role; status: 'active' | 'disabled'; must_change_password: boolean; last_login_at: string | null; created_at: string; temporary_password?: string }
export interface ApiToken { id: string; name: string; prefix?: string; last_used_at: string | null; expires_at: string | null; revoked_at: string | null; created_at: string; token?: string }
export interface PendingDocument extends Document { knowledge_base_name: string; uploader: { username: string; display_name: string } }
export interface Reviews { documents: PendingDocument[] }
export interface QueryLog { id: string; user_id: string | null; username: string; source: 'chat' | 'debug' | 'mcp'; action: string; knowledge_base_id: string | null; knowledge_base_name: string; kb_scope: Scope; query: string | null; query_chars: number; method: string; result_count: number; latency_ms: number; status: 'ok' | 'error'; error: string | null; created_at: string }
export interface McpCallLog { id: string; user_id: string | null; username: string; token_id: string | null; transport: 'http' | 'stdio'; tool: string; arguments: Record<string, unknown>; status: 'ok' | 'error'; error: string | null; latency_ms: number; created_at: string }
export interface Page<T> { total: number; items: T[]; limit: number; offset: number }
