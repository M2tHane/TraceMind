import { expect, test, type Page } from '@playwright/test'
import { ADMIN_ACCOUNT } from './support/accounts'

// Isolated fixtures for the memory, tuning and recall-trace screens: no real records or model calls.
const createdAt = '2026-10-12T02:17:00Z'
const config = { routes: ['vector', 'bm25'], route_k: 20, bm25_weight: 1, vector_weight: 1, rrf_k: 60, fusion_k: 20, rerank: true, query_rewrite: 'none', rewrite_count: 3, min_score: null, dedupe_threshold: 1, mmr_lambda: null, neighbor_window: 0, top_k: 5 }
const memory = (id: string, content: string, extra: Record<string, unknown> = {}) => ({ id, user_id: 'user:1', scope: 'personal', created_by: '1', content, category: 'preference', tags: ['lang'], importance: 4, source: 'mcp', status: 'active', merged_into_id: null, attributes: {}, version: 1, access_count: 2, last_accessed_at: null, expires_at: null, has_embedding: true, created_at: createdAt, updated_at: createdAt, ...extra })
const memories = [memory('m1', '用户偏好简洁的中文回答'), memory('m2', '用户是一名后端工程师，主要使用 Python 和 PostgreSQL', { category: 'profile', tags: [] })]
const row = (name: string, mrr: number) => ({ name, questions: 6, failed: 0, latency_p50_ms: 12.5, latency_p95_ms: 30, hit_at_1: mrr, hit_at_3: 1, hit_at_5: 1, hit_at_10: 1, recall_at_5: 1, recall_at_10: 1, mrr_at_10: mrr, ndcg_at_10: mrr })
const leaderboard = [row('hybrid_rerank', 1), row('bm25', 0.83), row('vector_with_a_particularly_long_candidate_name', 0.61)]
const tuning = { id: 'tune-1', name: '预设网格', knowledge_base_id: 'kb-1', dataset_id: 'ds-1', status: 'completed', objective: 'mrr_at_10', candidates: leaderboard.map((item, index) => ({ name: item.name, config: { ...config, route_k: 20 + index * 10 } })), total: 18, completed: 18, failed: 0, leaderboard, best: leaderboard[0], config: {}, question_count: 6, error: null, created_at: createdAt }
const kb = { id: 'kb-1', scope: 'platform', owner_id: '1', can_manage: true, name: '演示库', description: '', chunk_size: 2200, chunk_overlap: 400, embedding_model: 'mock', version: 3, retrieval_config: config, document_count: 1, ready_count: 1, chunk_count: 4, created_at: createdAt }
const trace = [
  { stage: 'scope', ms: 0, corpus_chunks: 4, document_filter: null },
  { stage: 'recall.vector', ms: 120.5, count: 2, query: 'q', k: 20, candidates: [{ rank: 1, id: 'c1', document_id: 'd1', filename: 'notes.md', page: 1, score: 0.81 }] },
  { stage: 'recall.bm25', ms: 2.1, count: 1, query: 'q', k: 20, candidates: [{ rank: 1, id: 'c1', document_id: 'd1', filename: 'notes.md', page: 1, score: 3.2 }] },
  { stage: 'fusion', ms: 0.01, count: 2, method: 'weighted_rrf', rrf_k: 60, weights: [1, 1] },
  { stage: 'rerank', ms: 80, count: 2 },
  { stage: 'postprocess', ms: 0, count: 2, input: 2, kept: 2, top_k: 5 },
]

async function mockApi(page: Page): Promise<string[]> {
  const writes: string[] = []
  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (path === '/api/auth/me') return route.fulfill({ json: ADMIN_ACCOUNT })
    if (path === '/api/admin/reviews/count') return route.fulfill({ json: { total: 0 } })
    if (request.method() !== 'GET') {
      writes.push(`${request.method()} ${path}`)
      if (path === '/api/debug') return route.fulfill({ json: { results: [{ method: 'custom', answer: '', citations: [], contexts: [], abstain: false, timing: { retrieval_ms: 203 }, usage: {}, trace, queries: ['q'], retrieval_config: config }] } })
      if (path.endsWith('/memories/search')) return route.fulfill({ json: { results: [{ ...memories[1], similarity: 0.71, score: 0.03 }], searched: 2, mode: 'hybrid', unembedded: 0 } })
      return route.fulfill({ status: 400, json: { detail: 'unexpected write' } })
    }
    if (path === '/api/conversations') return route.fulfill({ json: [] })
    if (path === '/api/memories' && !url.searchParams.has('scope')) return route.fulfill({ json: { total: url.searchParams.get('status') === 'active' ? 2 : 0, items: url.searchParams.get('status') === 'active' ? memories : [] } })
    if (path === '/api/memories') return route.fulfill({ json: { total: 0, items: [] } })
    if (path === '/api/memories/m1/history') return route.fulfill({ json: [{ id: 'e1', memory_id: 'm1', user_id: 'user:1', action: 'create', before: null, after: memories[0], actor: 'mcp', created_at: createdAt }, { id: 'e2', memory_id: 'm1', user_id: 'user:1', action: 'update', before: { ...memories[0], content: '用户偏好中文' }, after: memories[0], actor: 'api', created_at: createdAt }] })
    if (path === '/api/tuning-runs') return route.fulfill({ json: [tuning] })
    if (path === '/api/tuning-runs/tune-1') return route.fulfill({ json: tuning })
    if (path === '/api/knowledge-bases') return route.fulfill({ json: [kb] })
    if (path === '/api/knowledge-bases/kb-1') return route.fulfill({ json: kb })
    return route.fulfill({ json: [] })
  })
  return writes
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }))
  expect(layout.scroll, JSON.stringify(layout)).toBeLessThanOrEqual(layout.width + 1)
}

for (const width of [375, 1440]) {
  test(`memory, tuning and trace screens render at ${width}px`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width, height: width < 500 ? 812 : 1000 })
    const writes = await mockApi(page)

    await page.goto('/memory')
    await expect(page.getByText('用户偏好简洁的中文回答')).toBeVisible()
    // Merging is offered only after rows are ticked, and needs at least two.
    await expect(page.getByRole('button', { name: '合并为一条' })).toHaveCount(0)
    await page.getByRole('checkbox', { name: /^选择 用户偏好简洁/ }).check()
    await expect(page.getByRole('button', { name: '合并为一条' })).toBeDisabled()
    await page.getByRole('checkbox', { name: /^选择 用户是一名/ }).check()
    await expect(page.getByRole('button', { name: '合并为一条' })).toBeEnabled()
    await page.getByRole('button', { name: '取消选择' }).click()
    await expect(page.getByRole('button', { name: '合并为一条' })).toHaveCount(0)
    await expectNoPageOverflow(page)
    // A row opens its change history in the side panel (it used to be a dialog behind a 历史 button).
    await page.getByRole('button', { name: '用户偏好简洁的中文回答' }).click()
    await expect(page.getByRole('complementary', { name: '变更历史' }).getByText('用户偏好中文')).toBeVisible()
    await page.getByRole('button', { name: '关闭变更历史' }).click()
    await expect(page.getByRole('complementary', { name: '变更历史' })).toHaveCount(0)
    await page.getByLabel('语义检索记忆').fill('数据库')
    await page.getByLabel('语义检索记忆').press('Enter')
    await expect(page.getByText('相似度 0.710')).toBeVisible()
    await expect(page.getByText('用户偏好简洁的中文回答')).toHaveCount(0)

    await page.goto('/evaluation/tuning')
    await expect(page.getByRole('main').getByRole('link', { name: '预设网格' })).toBeVisible()
    await expectNoPageOverflow(page)
    await page.goto('/evaluation/tuning/tune-1')
    await expect(page.getByText('当前默认')).toHaveCount(1)
    // “设为默认” now lives in each row's action menu: offered on the two other candidates, not on the current default.
    await expect(page.getByRole('button', { name: /^更多操作/ })).toHaveCount(3)
    for (const name of ['bm25', 'vector_with_a_particularly_long_candidate_name']) {
      await page.getByRole('button', { name: `更多操作 ${name}`, exact: true }).click()
      await expect(page.getByRole('button', { name: '设为默认' })).toHaveCount(1)
      await page.keyboard.press('Escape')
      await expect(page.getByRole('button', { name: '设为默认' })).toHaveCount(0)
    }
    await page.getByRole('button', { name: '更多操作 hybrid_rerank', exact: true }).click()
    await expect(page.getByRole('button', { name: '设为默认' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expectNoPageOverflow(page)

    await page.goto('/evaluation/retrieval')
    await page.getByRole('textbox', { name: '测试问题' }).fill('q')
    await page.getByRole('checkbox', { name: /追加自定义流水线/ }).check()
    await page.getByRole('button', { name: '开始对比' }).click()
    await page.getByText('调试信息').first().click()
    await expect(page.locator('.trace-stage')).toHaveCount(6)
    await expect(page.locator('.trace').getByText('向量召回')).toBeVisible()
    await expectNoPageOverflow(page)

    expect(writes).toEqual(['POST /api/memories/search', 'POST /api/debug'])
    expect(errors).toEqual([])
  })
}
