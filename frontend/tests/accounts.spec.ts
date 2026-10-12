import { expect, test, type Page } from '@playwright/test'
import { ADMIN_ACCOUNT, EMPLOYEE_ACCOUNT } from './support/accounts'

// Isolated fixtures for sign-in, roles, approvals and audit logs: no real records are touched.
const createdAt = '2026-10-12T02:17:00Z'
const kb = (id: string, name: string, scope: 'platform' | 'personal', extra: Record<string, unknown> = {}) => ({ id, name, scope, owner_id: '1', can_manage: scope === 'personal', description: '', chunk_size: 2200, chunk_overlap: 400, embedding_model: 'mock', version: 1, retrieval_config: {}, document_count: 1, ready_count: 1, chunk_count: 3, created_at: createdAt, ...extra })
const handbook = kb('kb-1', '员工手册', 'platform')
const notes = kb('kb-2', 'Alice 的笔记', 'personal')
const document = (id: string, filename: string, extra: Record<string, unknown> = {}) => ({ id, knowledge_base_id: 'kb-1', filename, source_type: 'markdown', status: 'ready', stage: 'ready', review_status: 'approved', uploaded_by: '1', error: null, page_count: 1, chunk_count: 2, created_at: createdAt, updated_at: createdAt, ...extra })

interface Mock { writes: string[]; account: Record<string, unknown> | null }

async function mockApi(page: Page, account: Record<string, unknown> | null): Promise<Mock> {
  const mock: Mock = { writes: [], account }
  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()
    if (method !== 'GET') mock.writes.push(`${method} ${path}`)
    if (path === '/api/auth/me') return mock.account ? route.fulfill({ json: mock.account }) : route.fulfill({ status: 401, json: { detail: '请先登录' } })
    if (path === '/api/auth/login') {
      const body = request.postDataJSON() as { password: string }
      if (body.password !== 'Temp-pass-123') return route.fulfill({ status: 401, json: { detail: '用户名或密码错误' } })
      mock.account = { ...EMPLOYEE_ACCOUNT, must_change_password: true }
      return route.fulfill({ json: mock.account })
    }
    if (path === '/api/auth/password') { mock.account = { ...EMPLOYEE_ACCOUNT }; return route.fulfill({ json: mock.account }) }
    if (path === '/api/auth/logout') { mock.account = null; return route.fulfill({ status: 204 }) }
    if (path === '/api/auth/tokens' && method === 'POST') return route.fulfill({ status: 201, json: { id: 't1', name: 'Claude', prefix: 'rwb_abcd', last_used_at: null, expires_at: null, revoked_at: null, created_at: createdAt, token: 'rwb_secret-token-value' } })
    if (path === '/api/knowledge-bases') return route.fulfill({ json: [handbook, notes] })
    if (path === '/api/knowledge-bases/kb-1') return route.fulfill({ json: handbook })
    if (path === '/api/knowledge-bases/kb-1/documents') return route.fulfill({ json: [document('d1', 'policy.md'), document('d2', 'proposal.md', { status: 'pending_review', stage: 'pending_review', review_status: 'pending', uploaded_by: '2' })] })
    if (path === '/api/memories') return route.fulfill({ json: { total: 0, items: [] } })
    if (path === '/api/admin/reviews/count') return route.fulfill({ json: { documents: 1, memories: 1, total: 2 } })
    if (path === '/api/admin/reviews') return route.fulfill({ json: { documents: [{ ...document('d2', 'proposal.md', { status: 'pending_review', review_status: 'pending', uploaded_by: '2' }), knowledge_base_name: '员工手册', uploader: { username: 'alice', display_name: 'Alice' } }], memories: [{ id: 'm9', user_id: 'platform', content: '报销需在 30 天内提交', category: 'fact', tags: [], importance: 3, source: 'api', status: 'pending', created_by: '2', author: 'alice', merged_into_id: null, attributes: {}, version: 1, access_count: 0, last_accessed_at: null, expires_at: null, has_embedding: true, created_at: createdAt, updated_at: createdAt }] } })
    if (path.startsWith('/api/admin/reviews/')) return route.fulfill({ json: {} })
    if (path === '/api/admin/users' && method === 'POST') return route.fulfill({ status: 201, json: { id: '3', username: 'bob', display_name: 'Bob', role: 'employee', status: 'active', must_change_password: true, last_login_at: null, created_at: createdAt, temporary_password: 'Gen-temp-PW-42' } })
    if (path === '/api/admin/users') return route.fulfill({ json: [{ id: '1', username: 'admin', display_name: '管理员', role: 'admin', status: 'active', must_change_password: false, last_login_at: createdAt, created_at: createdAt }, { id: '2', username: 'alice', display_name: 'Alice', role: 'employee', status: 'active', must_change_password: false, last_login_at: null, created_at: createdAt }] })
    if (path === '/api/admin/query-logs') return route.fulfill({ json: { total: 2, limit: 50, offset: 0, items: [
      { id: 'q1', user_id: '2', username: 'alice', source: 'chat', action: 'answer', knowledge_base_id: 'kb-1', knowledge_base_name: '员工手册', kb_scope: 'platform', query: '年假怎么申请？', query_chars: 7, method: 'hybrid_rerank', result_count: 5, latency_ms: 812, status: 'ok', error: null, created_at: createdAt },
      { id: 'q2', user_id: '2', username: 'alice', source: 'mcp', action: 'search', knowledge_base_id: 'kb-2', knowledge_base_name: 'Alice 的笔记', kb_scope: 'personal', query: null, query_chars: 12, method: 'auto', result_count: 3, latency_ms: 95, status: 'ok', error: null, created_at: createdAt },
    ] } })
    if (path === '/api/admin/mcp-logs') return route.fulfill({ json: { total: 1, limit: 50, offset: 0, tools: ['rag_search'], items: [{ id: 'l1', user_id: '2', username: 'alice', token_id: 't1', transport: 'http', tool: 'rag_search', arguments: { knowledge_base_id: '2', query: { chars: 12 } }, status: 'ok', error: null, latency_ms: 95, created_at: createdAt }] } })
    return route.fulfill({ json: [] })
  })
  return mock
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }))
  expect(layout.scroll, JSON.stringify(layout)).toBeLessThanOrEqual(layout.width + 1)
}

test('sign in, forced password change and employee navigation', async ({ page }) => {
  const mock = await mockApi(page, null)
  await page.goto('/knowledge')
  await page.getByLabel('用户名').fill('alice')
  await page.getByLabel('密码').fill('wrong-password')
  await page.getByRole('button', { name: '登录' }).click()
  await expect(page.getByRole('alert')).toHaveText('用户名或密码错误')
  await page.getByLabel('密码').fill('Temp-pass-123')
  await page.getByRole('button', { name: '登录' }).click()
  await expect(page.getByRole('heading', { name: '设置新密码' })).toBeVisible()
  await page.getByLabel('当前密码').fill('Temp-pass-123')
  await page.locator('input[name="new_password"]').fill('Alice-own-pass-1')
  await page.getByLabel('确认新密码').fill('Alice-own-pass-1')
  await page.getByRole('button', { name: '保存并进入工作台' }).click()

  const nav = page.getByRole('navigation', { name: '主要导航' })
  await expect(nav.getByRole('link', { name: '知识库' })).toBeVisible()
  await expect(nav.getByRole('link', { name: '评测实验' })).toHaveCount(0)
  await expect(nav.getByRole('link', { name: '管理' })).toHaveCount(0)
  await expect(nav.getByRole('link', { name: '环境设置' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: /平台知识库/ })).toBeVisible()
  await expect(page.getByRole('heading', { name: /我的知识库/ })).toBeVisible()

  await page.getByRole('link', { name: /员工手册/ }).click()
  await expect(page.getByText('你上传的文档需要管理员审批')).toBeVisible()
  await expect(page.getByText('待管理员审批')).toBeVisible()
  await expect(page.getByRole('button', { name: '删除 policy.md' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '删除 proposal.md' })).toBeVisible()
  await expect(page.getByText('恢复默认')).toHaveCount(0)

  await page.goto('/memory/platform')
  await expect(page.getByRole('button', { name: '提议平台记忆' })).toBeVisible()
  await expect(page.getByRole('button', { name: '我的提议' })).toBeVisible()
  await page.goto('/evaluation')
  await expect(page.getByText('页面不存在')).toBeVisible()

  await page.goto('/account')
  await page.getByRole('button', { name: '新建令牌' }).click()
  await page.getByLabel('名称').fill('Claude')
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await expect(page.getByTestId('new-token')).toHaveText('rwb_secret-token-value')
  await page.getByRole('button', { name: '我已保存' }).click()
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page.getByRole('button', { name: '登录' })).toBeVisible()
  expect(mock.writes).toEqual(['POST /api/auth/login', 'POST /api/auth/login', 'POST /api/auth/password', 'POST /api/auth/tokens', 'POST /api/auth/logout'])
})

for (const width of [375, 1440]) {
  test(`admin console: approvals, accounts and audit logs at ${width}px`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width, height: width < 500 ? 812 : 1000 })
    const mock = await mockApi(page, ADMIN_ACCOUNT)
    await page.goto('/admin')
    await expect(page.getByRole('link', { name: '待审批 2' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'proposal.md' })).toBeVisible()
    await expect(page.getByText('报销需在 30 天内提交')).toBeVisible()
    await expectNoPageOverflow(page)
    await page.getByRole('button', { name: '通过 proposal.md' }).click()
    await page.getByRole('button', { name: /^通过 报销/ }).click()

    await page.getByRole('link', { name: '员工账号' }).click()
    await expect(page.getByText('（我）')).toBeVisible()
    await page.getByRole('button', { name: '新建账号' }).click()
    await page.getByLabel('用户名').fill('bob')
    await page.getByRole('button', { name: '创建账号' }).click()
    await expect(page.getByTestId('temporary-password')).toHaveText('Gen-temp-PW-42')
    await page.getByRole('button', { name: '完成' }).click()
    await expectNoPageOverflow(page)

    await page.getByRole('link', { name: '查询日志' }).click()
    await expect(page.getByText('年假怎么申请？')).toBeVisible()
    await expect(page.getByText('（个人库，未记录内容 · 12 字）')).toBeVisible()
    await expectNoPageOverflow(page)
    await page.getByRole('link', { name: 'MCP 调用日志' }).click()
    await expect(page.getByRole('cell', { name: 'rag_search' })).toBeVisible()
    await expectNoPageOverflow(page)

    expect(mock.writes).toEqual(['POST /api/admin/reviews/documents/d2', 'POST /api/admin/reviews/memories/m9', 'POST /api/admin/users'])
    expect(errors).toEqual([])
  })
}
