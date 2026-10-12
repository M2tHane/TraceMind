import { expect, test, type Page } from '@playwright/test'
import { ADMIN_ACCOUNT } from './support/accounts'

// Isolated fixtures for the knowledge list, library detail, document detail, memory and auto-consolidation screens.
const createdAt = '2026-10-12T02:17:00Z'
const kb = (id: string, name: string, scope: 'platform' | 'personal', extra: Record<string, unknown> = {}) => ({ id, name, scope, owner_id: '1', can_manage: true, description: `${name}的描述`, chunk_size: 800, chunk_overlap: 100, embedding_model: 'qwen3.7-text-embedding', embedding_dimensions: 1024, version: 4, retrieval_config: {}, document_count: 4, ready_count: 2, chunk_count: 120, created_at: createdAt, ...extra })
const handbook = kb('kb-1', '产品手册', 'platform', { pending_count: 1 })
const notes = kb('kb-2', '学习笔记', 'personal', { document_count: 1, ready_count: 1, chunk_count: 3 })
const doc = (id: string, filename: string, extra: Record<string, unknown> = {}) => ({ id, knowledge_base_id: 'kb-1', filename, source_type: 'pdf', status: 'ready', stage: 'ready', review_status: 'approved', uploaded_by: '1', replaces_document_id: null, error: null, page_count: 12, chunk_count: 30, created_at: createdAt, updated_at: createdAt, ...extra })
const docs = [
  doc('d1', 'guide.md', { source_type: 'markdown', page_count: 1, chunk_count: 25 }),
  doc('d2', 'deploy.pdf', { status: 'processing', stage: 'embedding', chunk_count: 0, replaces_document_id: 'd9' }),
  doc('d3', 'license.pdf', { status: 'failed', stage: 'parsing', error: 'MinerU 超时', chunk_count: 0, uploaded_by: '2' }),
  doc('d4', 'proposal.md', { source_type: 'markdown', status: 'pending_review', stage: 'pending_review', review_status: 'pending', uploaded_by: '2', chunk_count: 0 }),
]
const chunks = Array.from({ length: 25 }, (_, index) => ({ id: `c${index + 1}`, document_id: 'd1', filename: 'guide.md', page: 1, chunk_index: index, text: `第 ${index + 1} 段：发布流程需要先通过评审，再进入灰度环境。` }))
const memory = (id: string, content: string, extra: Record<string, unknown> = {}) => ({ id, user_id: 'user:1', content, category: 'preference', tags: [], importance: 4, source: 'web', status: 'active', merged_into_id: null, attributes: {}, version: 1, access_count: 2, last_accessed_at: null, expires_at: null, has_embedding: true, created_at: createdAt, updated_at: createdAt, ...extra })
const consolidation = {
  settings: { enabled: true, interval_minutes: 360, threshold: 2000, target_ratio: 0.8, target: 1600, similarity: 0.85, batch_size: 10, max_active_per_user: 10000 },
  running: false,
  runs: [
    { id: 'r2', status: 'failed', trigger: 'manual', started_at: createdAt, finished_at: createdAt, users_processed: 1, memories_merged: 0, memories_archived: 0, error: '模型调用失败', created_at: createdAt },
    { id: 'r1', status: 'completed', trigger: 'schedule', started_at: createdAt, finished_at: createdAt, users_processed: 3, memories_merged: 12, memories_archived: 4, error: null, created_at: createdAt },
  ],
  users_over_threshold: [{ user_id: 'user:2', active: 2400 }],
}

async function mockApi(page: Page, options: { busy?: boolean } = {}): Promise<string[]> {
  const writes: string[] = []
  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()
    if (path === '/api/auth/me') return route.fulfill({ json: ADMIN_ACCOUNT })
    if (method !== 'GET') {
      writes.push(`${method} ${path}`)
      if (path === '/api/admin/memory/consolidate') return options.busy ? route.fulfill({ status: 409, json: { detail: '已有整理任务在运行' } }) : route.fulfill({ status: 202, json: consolidation.runs[0] })
      return route.fulfill({ status: 202, json: {} })
    }
    if (path === '/api/admin/reviews/count') return route.fulfill({ json: { documents: 1, total: 1 } })
    if (path === '/api/admin/users') return route.fulfill({ json: [{ id: '1', username: 'admin', display_name: '管理员', role: 'admin', status: 'active', must_change_password: false, last_login_at: null, created_at: createdAt }, { id: '2', username: 'alice', display_name: 'Alice', role: 'employee', status: 'active', must_change_password: false, last_login_at: null, created_at: createdAt }] })
    if (path === '/api/admin/memory/consolidation') return route.fulfill({ json: consolidation })
    if (path === '/api/knowledge-bases') return route.fulfill({ json: [handbook, notes] })
    if (path === '/api/knowledge-bases/kb-1') return route.fulfill({ json: handbook })
    if (path === '/api/knowledge-bases/kb-1/documents') return route.fulfill({ json: docs })
    if (path === '/api/knowledge-bases/kb-2') return route.fulfill({ json: notes })
    if (path === '/api/knowledge-bases/kb-2/documents') return route.fulfill({ json: [doc('n1', 'notes.md', { knowledge_base_id: 'kb-2', source_type: 'markdown' })] })
    if (path === '/api/documents/d1') return route.fulfill({ json: docs[0] })
    if (path === '/api/documents/d1/parsed') return route.fulfill({ json: { markdown: '# 发布手册\n\n正文', chunks } })
    if (path === '/api/documents/d1/file') return route.fulfill({ contentType: 'text/markdown', body: '# 发布手册\n\n正文' })
    if (path === '/api/memories') {
      const status = url.searchParams.get('status')
      const items = status === 'active' ? [memory('m1', '回答尽量简洁'), memory('m2', '周报每周五提交', { category: 'instruction', importance: 2 })]
        : status === 'deleted' ? [memory('m3', '旧的偏好', { status: 'deleted' })] : []
      return route.fulfill({ json: { total: items.length, items } })
    }
    if (path === '/api/memories/m1/history') return route.fulfill({ json: [
      { id: 'e1', memory_id: 'm1', user_id: 'user:1', action: 'create', before: null, after: memory('m1', '回答尽量简洁。', { importance: 4 }), actor: 'mcp', created_at: createdAt },
      { id: 'e2', memory_id: 'm1', user_id: 'user:1', action: 'update', before: { content: '回答尽量简洁。', importance: 4, version: 1, source: 'web' }, after: memory('m1', '回答尽量简洁，先给结论。', { importance: 5, version: 2 }), actor: 'user:1', created_at: createdAt },
    ] })
    return route.fulfill({ json: [] })
  })
  return writes
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }))
  expect(layout.scroll, JSON.stringify(layout)).toBeLessThanOrEqual(layout.width + 1)
}

for (const width of [375, 1440]) {
  test(`knowledge list and library detail at ${width}px`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width, height: width < 500 ? 812 : 1000 })
    const writes = await mockApi(page)

    await page.goto('/knowledge')
    await expect(page.getByRole('row', { name: /产品手册.*平台.*2 \/ 4 已就绪/ })).toBeVisible()
    await expect(page.getByRole('row', { name: /学习笔记.*个人/ })).toBeVisible()
    // Problem documents come from the per-library lists; only the failed one can be reprocessed.
    const problems = page.getByRole('region', { name: '处理中和失败的文档' })
    await expect(problems.getByRole('link', { name: 'deploy.pdf' })).toBeVisible()
    await expect(problems.getByRole('link', { name: 'license.pdf' })).toBeVisible()
    await expect(problems.getByRole('button', { name: /^重新处理/ })).toHaveCount(1)
    await expectNoPageOverflow(page)
    await problems.getByRole('button', { name: '重新处理 license.pdf' }).click()
    await page.getByRole('link', { name: /处理失败的文档/ }).click()
    await expect(page).toHaveURL(/docs=failed/)
    await expect(problems.getByRole('link', { name: 'deploy.pdf' })).toHaveCount(0)
    await page.getByRole('group', { name: '范围' }).getByRole('button', { name: /^个人/ }).click()
    await expect(page).toHaveURL(/scope=personal/)
    await expect(page.getByRole('table', { name: '知识库' }).getByRole('row', { name: /产品手册/ })).toHaveCount(0)

    await page.goto('/knowledge/kb-1')
    await expect(page.getByRole('heading', { name: '产品手册', exact: true })).toBeVisible()
    await expect(page.getByText('qwen3.7-text-embedding').first()).toBeVisible()
    await expect(page.getByText('替换中')).toBeVisible()
    await expect(page.getByText('MinerU 超时，可重新处理')).toBeVisible()
    const status = page.getByRole('group', { name: '文档状态' })
    await expect(status.getByRole('button', { name: /^失败 1/ })).toBeVisible()
    await status.getByRole('button', { name: /^待审批 1/ }).click()
    await expect(page.getByRole('link', { name: 'proposal.md' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'guide.md' })).toHaveCount(0)
    await status.getByRole('button', { name: /^全部/ }).click()
    await page.getByRole('checkbox', { name: '选择 license.pdf' }).check()
    await expect(page.getByRole('region', { name: '批量操作' })).toContainText('已选 1 份')
    await page.getByRole('button', { name: '取消选择' }).click()
    await expect(page.getByRole('region', { name: '批量操作' })).toHaveCount(0)
    await page.getByRole('tab', { name: '默认检索配置' }).click()
    await expect(page.getByText('系统默认')).toBeVisible()
    await expect(page.getByRole('button', { name: '恢复默认' })).toHaveCount(0)
    await page.getByRole('tab', { name: '访问与审批' }).click()
    await expect(page.getByText('员工上传需要你审批')).toBeVisible()
    await expectNoPageOverflow(page)

    expect(writes).toEqual(['POST /api/documents/d3/retry'])
    expect(errors).toEqual([])
  })
}

test('document detail selects the chunk from the link and follows the chunk list', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width: 1440, height: 960 })
  await mockApi(page)

  await page.goto('/knowledge/kb-1/documents/d1?chunk=c23')
  await expect(page.getByRole('heading', { name: 'guide.md', exact: true })).toBeVisible()
  // The deep-linked chunk sits on the second list page and is the selected card.
  await expect(page.locator('.chunk-card[aria-pressed="true"]')).toContainText('第 23 段')
  await expect(page.getByRole('navigation', { name: '分页' }).getByRole('button', { name: '第 2 页' })).toHaveAttribute('aria-current', 'page')
  await page.getByRole('navigation', { name: '分页' }).getByRole('button', { name: '第 1 页' }).click()
  await page.locator('.chunk-card').first().click()
  await expect(page.locator('.chunk-card[aria-pressed="true"]')).toContainText('第 1 段')
  await page.getByRole('tab', { name: '处理记录' }).click()
  await expect(page.getByText('审批状态')).toBeVisible()
  await page.getByRole('tab', { name: '解析正文' }).click()
  await expect(page.locator('.document-parsed .markdown')).toContainText('正文')
  await page.getByRole('link', { name: '产品手册' }).first().click()
  await expect(page).toHaveURL(/\/knowledge\/kb-1$/)
  expect(errors).toEqual([])
})

for (const width of [375, 1440]) {
  test(`memory table, history panel and auto consolidation at ${width}px`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width, height: width < 500 ? 812 : 1000 })
    const writes = await mockApi(page, { busy: true })

    await page.goto('/memory')
    await expect(page.getByRole('heading', { name: '我的记忆', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '回答尽量简洁' }).click()
    const history = page.getByRole('complementary', { name: '变更历史' })
    await expect(history.getByText('v2 更新')).toBeVisible()
    await expect(history.getByText('v1 创建')).toBeVisible()
    await expect(history.getByLabel('内容变化')).toContainText('回答尽量简洁。')
    await expect(history.getByText('重要度 4 → 5')).toBeVisible()
    await history.getByRole('button', { name: '关闭变更历史' }).click()
    await page.getByRole('group', { name: '记忆状态' }).getByRole('button', { name: /^已删除/ }).click()
    await expect(page.getByRole('button', { name: '恢复', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '彻底删除' })).toBeVisible()
    await expectNoPageOverflow(page)

    await page.getByRole('link', { name: '自动整理' }).click()
    await expect(page).toHaveURL(/\/memory\/consolidation$/)
    await expect(page.getByText('超过 2,000 条')).toBeVisible()
    await expect(page.getByRole('cell', { name: 'Alice' })).toBeVisible()
    await expect(page.getByRole('cell', { name: '模型调用失败' })).toBeVisible()
    await page.getByRole('button', { name: '立即整理' }).click()
    await expect(page.getByText('整理正在运行，请稍后再试')).toBeVisible()
    await expectNoPageOverflow(page)

    expect(writes).toEqual(['POST /api/admin/memory/consolidate'])
    expect(errors).toEqual([])
  })
}
