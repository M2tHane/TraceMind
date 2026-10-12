import { expect, test, type Page, type Request } from '@playwright/test'
import { ADMIN_ACCOUNT } from './support/accounts'

// Isolated fixtures for the evaluation screens: no real records, models or evaluations.
const createdAt = '2026-10-12T02:17:00Z'
const baseConfig = { routes: ['vector', 'bm25'], route_k: 20, bm25_weight: 1, vector_weight: 1, rrf_k: 60, fusion_k: 20, rerank: true, query_rewrite: 'none', rewrite_count: 3, min_score: null, dedupe_threshold: 1, mmr_lambda: null, neighbor_window: 0, top_k: 5 }
const kb = { id: 'kb-1', scope: 'platform', owner_id: '1', can_manage: true, name: '演示库', description: '', chunk_size: 2200, chunk_overlap: 400, embedding_model: 'mock', version: 3, retrieval_config: baseConfig, document_count: 2, ready_count: 2, chunk_count: 8, created_at: createdAt }
const dataset = { id: 'ds-1', name: '论文问答基准', description: '三道题', question_count: 3, created_at: createdAt }
const questions = ['LoRA 会增加推理延迟吗？', 'Transformer 为什么除以根号 dk？', 'RAG 的检索器是什么模型？']
const summary = (hit: number, f1: number, p95: number) => ({ count: 3, completed: 3, failed: 0, scored: 3, unscored: 0, hit_at_5: hit, evidence_recall_at_5: hit, mrr_at_10: hit, token_f1: f1, auto_correct: null, retrieval_p95_ms: p95, generation_p95_ms: 4300, total_tokens: 21480 })
const run = {
  id: 'run-1', name: '混合对比', dataset_id: 'ds-1', knowledge_base_id: 'kb-1', status: 'completed', methods: ['bm25', 'hybrid_rerank'], judge_enabled: false, total: 6, completed: 6, failed: 0,
  config: { kb_version: 3, chat_model: 'mock-chat', question_ids: ['q1', 'q2', 'q3'] }, summary: { by_method: { bm25: summary(0.3333, 0.4, 46), hybrid_rerank: summary(0.6667, 0.51, 1460) } }, created_at: createdAt,
}
// q1: only hybrid hits; q2: both hit; q3: neither hits.
const hits: Record<string, Record<string, number>> = { q1: { bm25: 0, hybrid_rerank: 1 }, q2: { bm25: 1, hybrid_rerank: 1 }, q3: { bm25: 0, hybrid_rerank: 0 } }
const items = ['q1', 'q2', 'q3'].flatMap((qid, index) => ['bm25', 'hybrid_rerank'].map(method => ({
  id: `${qid}-${method}`, run_id: 'run-1', question_id: qid, question: questions[index], reference_answer: `参考答案 ${index + 1}`, method, status: 'completed', error: null,
  result: { answer: `${method} 的回答`, citations: [], contexts: [], abstain: false, method, timing: {}, usage: {} }, metrics: { hit_at_5: hits[qid][method], token_f1: 0.4 }, judgment: null, judge_error: null,
})))
const candidate = (name: string, routeK: number) => ({ name, config: { ...baseConfig, route_k: routeK } })
const row = (name: string, mrr: number) => ({ name, questions: 6, failed: 0, latency_p50_ms: 12.5, latency_p95_ms: 30, hit_at_1: mrr, hit_at_3: 1, hit_at_5: 1, hit_at_10: 1, recall_at_5: 1, recall_at_10: 1, mrr_at_10: mrr, ndcg_at_10: mrr })
const tuning = {
  id: 't2', name: '召回宽度', knowledge_base_id: 'kb-1', dataset_id: 'ds-1', status: 'completed', objective: 'mrr_at_10', candidates: [candidate('wide', 40), candidate('base', 20)], total: 12, completed: 12, failed: 0,
  leaderboard: [row('wide', 1), row('base', 0.9)], best: row('wide', 1), config: {}, question_count: 6, error: null, created_at: createdAt,
}
const datasetQuestions = questions.map((question, index) => ({ id: `q${index + 1}`, dataset_id: 'ds-1', question, reference_answer: `参考答案 ${index + 1}`, answerable: true, evidence: [{ doc_id: 'lora', page: 2, quote: '引文' }], review_status: 'pending' }))

async function mockApi(page: Page): Promise<Request[]> {
  const writes: Request[] = []
  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/auth/me') return route.fulfill({ json: ADMIN_ACCOUNT })
    if (path === '/api/admin/reviews/count') return route.fulfill({ json: { total: 0 } })
    if (request.method() !== 'GET') {
      writes.push(request)
      if (path === '/api/runs') return route.fulfill({ status: 201, json: run })
      if (path === '/api/debug') return route.fulfill({ json: { results: [{ method: 'custom', answer: '', citations: [], contexts: [], abstain: false, timing: {}, usage: {} }] } })
      if (path.endsWith('/apply')) return route.fulfill({ json: kb })
      return route.fulfill({ status: 400, json: { detail: 'unexpected write' } })
    }
    if (path === '/api/knowledge-bases') return route.fulfill({ json: [kb] })
    if (path === '/api/knowledge-bases/kb-1') return route.fulfill({ json: kb })
    if (path === '/api/datasets') return route.fulfill({ json: [dataset] })
    if (path === '/api/datasets/ds-1/questions') return route.fulfill({ json: datasetQuestions })
    if (path === '/api/runs') return route.fulfill({ json: [run] })
    if (path === '/api/runs/run-1') return route.fulfill({ json: run })
    if (path === '/api/runs/run-1/items') return route.fulfill({ json: items })
    if (path === '/api/tuning-runs') return route.fulfill({ json: [tuning] })
    if (path === '/api/tuning-runs/t2') return route.fulfill({ json: tuning })
    if (path === '/api/tuning/presets') return route.fulfill({ json: { candidates: [candidate('bm25', 20)], objectives: ['mrr_at_10', 'hit_at_1'], tunable_fields: ['route_k'] } })
    if (path === '/api/examples') return route.fulfill({ json: [] })
    return route.fulfill({ json: [] })
  })
  return writes
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }))
  expect(layout.scroll, JSON.stringify(layout)).toBeLessThanOrEqual(layout.width + 1)
}

for (const width of [375, 1440]) {
  test(`run list, run detail and inspection drawer at ${width}px`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width, height: width < 500 ? 812 : 1000 })
    const writes = await mockApi(page)

    await page.goto('/evaluation')
    await expect(page.getByRole('heading', { name: '批量评测', exact: true })).toBeVisible()
    await expect(page.getByRole('main').getByRole('link', { name: '混合对比' })).toBeVisible()
    // One run fits on one page, so there is no pager.
    await expect(page.getByRole('navigation', { name: '分页' })).toHaveCount(0)
    await expectNoPageOverflow(page)

    await page.goto('/evaluation/runs/run-1')
    await expect(page.getByRole('heading', { name: '混合对比', exact: true })).toBeVisible()
    await expect(page.getByText('论文问答基准，3 题')).toBeVisible()
    await expect(page.getByText('mock-chat（已冻结）')).toBeVisible()
    await expect(page.getByRole('button', { name: '只重试失败项' })).toBeDisabled()
    await expect(page.getByRole('group', { name: 'Hit@5' })).toContainText('33.3%')
    const table = page.getByRole('table', { name: '逐题结果' })
    await expect(table.locator('tbody tr')).toHaveCount(3)
    await expectNoPageOverflow(page)

    // Filters: results that differ between methods, and questions nobody hit.
    await page.getByRole('button', { name: /^结果不一致/ }).click()
    await expect(table.locator('tbody tr')).toHaveCount(1)
    await expect(table).toContainText(questions[0])
    await page.getByRole('button', { name: /^都没命中/ }).click()
    await expect(table.locator('tbody tr')).toHaveCount(1)
    await expect(table).toContainText(questions[2])
    await page.getByRole('button', { name: /^全部/ }).click()
    await expect(table.locator('tbody tr')).toHaveCount(3)
    await expect(table.getByRole('link', { name: '对比召回' }).first()).toHaveAttribute('href', `/evaluation/retrieval?kb=kb-1&q=${encodeURIComponent(questions[0]).replace(/%20/g, '+')}`)

    // Drawer: opens from the question button, steps through questions, closes on Esc and returns focus.
    const opener = table.getByRole('button', { name: questions[1] })
    await opener.click()
    const drawer = page.getByRole('dialog')
    await expect(drawer).toContainText('参考答案 2')
    await expect(drawer).toContainText('hybrid_rerank 的回答')
    await expect(drawer).toContainText('2 / 3')
    await drawer.getByRole('button', { name: '下一项' }).click()
    await expect(drawer).toContainText('参考答案 3')
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
    await expect(opener).toBeFocused()

    expect(writes).toEqual([])
    expect(errors).toEqual([])
  })
}

test('tuning conclusion compares the best candidate with the current default and applies it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const writes = await mockApi(page)
  await page.goto('/evaluation/tuning/t2')
  const conclusion = page.getByRole('region', { name: '调优结论' })
  await expect(conclusion).toContainText('最优配置的 MRR@10')
  await expect(conclusion).toContainText('100.0%')
  await expect(conclusion).toContainText('比当前默认高 10.0 个点')
  await expect(conclusion).toContainText('与当前默认只差一个参数')
  await expect(conclusion).toContainText('每路召回')
  await expect(page.getByRole('region', { name: '排行榜' }).getByText('当前默认')).toHaveCount(1)
  await page.getByRole('button', { name: '设为演示库的默认配置' }).click()
  await expect.poll(() => writes.map(request => `${request.method()} ${new URL(request.url()).pathname}`)).toEqual(['POST /api/tuning-runs/t2/apply'])
  expect(writes[0].postDataJSON()).toEqual({ candidate: 'wide' })

  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出 JSON' }).click()
  expect((await download).suggestedFilename()).toBe('tuning-run-t2.json')
})

test('retrieval comparison fills from kb, q and config in the address', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const writes = await mockApi(page)
  const config = { ...baseConfig, routes: ['bm25'], route_k: 33, rerank: false }
  await page.goto(`/evaluation/retrieval?kb=kb-1&q=${encodeURIComponent(questions[0])}&config=${encodeURIComponent(JSON.stringify(config))}`)
  await expect(page.getByRole('textbox', { name: '测试问题' })).toHaveValue(questions[0])
  await expect(page.getByRole('button', { name: '知识库', exact: true })).toContainText('演示库')
  await expect(page.getByRole('checkbox', { name: /追加自定义流水线/ })).toBeChecked()
  await expect(page.getByLabel('每路召回数')).toHaveValue('33')
  expect(writes).toEqual([])

  const sent = page.waitForRequest(request => new URL(request.url()).pathname === '/api/debug')
  await page.getByRole('button', { name: '开始对比' }).click()
  const body = (await sent).postDataJSON()
  expect(body).toMatchObject({ knowledge_base_id: 'kb-1', question: questions[0], retrieval: { routes: ['bm25'], route_k: 33, rerank: false } })

  // A config that cannot be read is ignored instead of breaking the page.
  await page.goto(`/evaluation/retrieval?kb=kb-1&config=${encodeURIComponent('{broken')}`)
  await expect(page.getByRole('checkbox', { name: /追加自定义流水线/ })).not.toBeChecked()
})

test('creating a run picks a library and a dataset from searchable selects in a drawer', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const writes = await mockApi(page)
  await page.goto('/evaluation')
  await page.getByRole('button', { name: '新建评测', exact: true }).click()
  const drawer = page.getByRole('dialog')
  await expect(drawer.getByRole('button', { name: '创建并运行' })).toBeDisabled()
  await drawer.getByRole('textbox', { name: '评测名称' }).fill('第一次对比')
  await drawer.getByRole('button', { name: '知识库', exact: true }).click()
  await page.getByRole('option', { name: /演示库/ }).click()
  await expect(drawer.getByRole('button', { name: '知识库', exact: true })).toContainText('演示库')
  await drawer.getByRole('button', { name: '题集', exact: true }).click()
  await page.getByRole('option', { name: /论文问答基准/ }).click()
  await drawer.getByRole('button', { name: '创建并运行' }).click()
  await expect(page).toHaveURL(/\/evaluation\/runs\/run-1$/)
  expect(writes).toHaveLength(1)
  expect(writes[0].postDataJSON()).toMatchObject({ name: '第一次对比', knowledge_base_id: 'kb-1', dataset_id: 'ds-1', methods: ['bm25', 'hybrid_rerank'], limit: 10, judge_enabled: false })
})

test('dataset questions open in an editing drawer that closes with Esc', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const writes = await mockApi(page)
  await page.goto('/evaluation/datasets')
  await expect(page.getByRole('main').getByRole('link', { name: '论文问答基准' })).toBeVisible()
  await page.getByRole('main').getByRole('link', { name: '论文问答基准' }).click()
  await expect(page.getByRole('heading', { name: '论文问答基准', exact: true })).toBeVisible()
  await expect(page.getByRole('table', { name: '题集问题' }).locator('tbody tr')).toHaveCount(3)
  await page.getByRole('button', { name: '编辑问题 2', exact: true }).click()
  const drawer = page.getByRole('dialog')
  await expect(drawer.getByRole('textbox', { name: '问题' })).toHaveValue(questions[1])
  await expect(drawer).toContainText('2 / 3')
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
  expect(writes).toEqual([])
})
