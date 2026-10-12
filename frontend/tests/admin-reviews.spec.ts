import { expect, test, type Page } from '@playwright/test'
import { ADMIN_ACCOUNT } from './support/accounts'

// Approval queue and approval history. Every /api request is intercepted; no record is touched.
const stamp = '2026-10-12T02:17:00Z'
const reviewedAt = '2026-10-12T03:30:00Z'
const alice = { username: 'alice', display_name: 'Alice' }
const bob = { username: 'bob', display_name: '' }
const root = { username: 'admin', display_name: '管理员' }
const base = (id: string, filename: string, extra: Record<string, unknown> = {}) => ({
  id, knowledge_base_id: 'kb-1', knowledge_base_name: '员工手册', filename, source_type: 'markdown', status: 'pending_review', stage: 'pending_review',
  review_status: 'pending', uploaded_by: '2', error: null, page_count: 1, chunk_count: 0, created_at: stamp, updated_at: stamp, uploader: alice, ...extra,
})
const users = [
  { id: '1', username: 'admin', display_name: '管理员', role: 'admin', status: 'active', must_change_password: false, last_login_at: stamp, created_at: stamp },
  { id: '2', username: 'alice', display_name: 'Alice', role: 'employee', status: 'active', must_change_password: false, last_login_at: null, created_at: stamp },
  { id: '3', username: 'bob', display_name: '', role: 'employee', status: 'active', must_change_password: false, last_login_at: null, created_at: stamp },
]

async function mockApi(page: Page, options: { pending?: Record<string, unknown>[]; history?: Record<string, unknown>[] } = {}) {
  let pending = options.pending ?? []
  const history = options.history ?? []
  const writes: { path: string; body: Record<string, unknown> }[] = []
  const historyRequests: URL[] = []
  const unexpected: string[] = []
  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace('/api', '')
    const method = request.method()
    if (path === '/auth/me') return route.fulfill({ json: ADMIN_ACCOUNT })
    if (path === '/admin/users') return route.fulfill({ json: users })
    if (path === '/admin/reviews/count') return route.fulfill({ json: { documents: pending.length, total: pending.length } })
    if (path === '/admin/reviews' && method === 'GET') return route.fulfill({ json: { documents: pending } })
    if (path === '/admin/reviews/history') {
      historyRequests.push(url)
      const result = url.searchParams.get('result')
      const items = history.filter(item => !result || item.result === result)
      const counts = { all: history.length, approved: history.filter(item => item.result === 'approved').length, rejected: history.filter(item => item.result === 'rejected').length }
      return route.fulfill({ json: { total: items.length, items, limit: 20, offset: 0, counts } })
    }
    const decision = /^\/admin\/reviews\/documents\/([^/]+)$/.exec(path)
    if (decision && method === 'POST') {
      writes.push({ path, body: request.postDataJSON() as Record<string, unknown> })
      pending = pending.filter(item => item.id !== decision[1])
      return route.fulfill({ json: {} })
    }
    if (/^\/documents\/[^/]+\/file$/.test(path)) return route.fulfill({ contentType: 'text/markdown', body: '# 远程办公制度\n\n本文为隔离测试的示例文本。' })
    unexpected.push(`${method} ${path}`)
    return route.fulfill({ status: 404, json: { detail: `Unmocked API: ${method} ${path}` } })
  })
  return { writes, historyRequests, unexpected }
}

test('approval drawer: open, step through items, close with Esc, and move on after a decision', async ({ page }) => {
  const mock = await mockApi(page, { pending: [base('d1', 'leave-policy.md'), base('d2', 'remote-work.md'), base('d3', 'team-building.md', { uploader: bob, uploaded_by: '3' })] })
  await page.goto('/admin/reviews')
  await expect(page.getByRole('row')).toHaveCount(4)
  await expect(page.getByRole('cell', { name: /^Alice\s*员工$/ }).first()).toBeVisible()

  const first = page.getByRole('button', { name: 'leave-policy.md', exact: true })
  await first.click()
  const drawer = page.getByRole('dialog', { name: 'leave-policy.md' })
  await expect(drawer).toBeVisible()
  await expect(drawer.getByText('1 / 3')).toBeVisible()
  await expect(drawer.getByText('员工手册（平台）')).toBeVisible()
  await expect(drawer.getByText('Alice，员工')).toBeVisible()
  await expect(drawer.getByRole('region', { name: '原文预览' }).getByRole('heading', { name: '远程办公制度' })).toBeVisible()

  await drawer.getByRole('button', { name: '下一项' }).click()
  await expect(page.getByRole('dialog', { name: 'remote-work.md' }).getByText('2 / 3')).toBeVisible()
  await page.getByRole('button', { name: '上一项' }).click()
  await expect(page.getByRole('dialog', { name: 'leave-policy.md' }).getByText('1 / 3')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
  await expect(first).toBeFocused()

  // The row's own reject button opens the drawer with the reason box ready.
  await page.getByRole('button', { name: '驳回 team-building.md' }).click()
  await expect(page.getByRole('dialog', { name: 'team-building.md' }).getByText('3 / 3')).toBeVisible()
  await expect(page.getByRole('textbox', { name: /驳回原因/ })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()

  await first.click()
  await page.getByRole('button', { name: '通过并开始解析' }).click()
  const second = page.getByRole('dialog', { name: 'remote-work.md' })
  await expect(second).toBeVisible()
  await expect(second.getByText('1 / 2')).toBeVisible()
  await second.getByRole('textbox', { name: /驳回原因/ }).fill('内容与现行制度重复')
  await second.getByRole('button', { name: '驳回并删除原文件' }).click()
  const last = page.getByRole('dialog', { name: 'team-building.md' })
  await expect(last.getByText('1 / 1')).toBeVisible()
  await expect(last.getByText('Bob，员工')).toBeVisible()
  await last.getByRole('button', { name: '通过并开始解析' }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(page.getByText('没有待审批文档')).toBeVisible()
  expect(mock.writes).toEqual([
    { path: '/admin/reviews/documents/d1', body: { approve: true, note: '' } },
    { path: '/admin/reviews/documents/d2', body: { approve: false, note: '内容与现行制度重复' } },
    { path: '/admin/reviews/documents/d3', body: { approve: true, note: '' } },
  ])
  expect(mock.unexpected).toEqual([])
})

test('approved sub-page: switch the result filter and read a decision', async ({ page }) => {
  const reviewed = (id: string, filename: string, result: 'approved' | 'rejected', extra: Record<string, unknown> = {}) => base(id, filename, {
    result, review_status: result, status: result === 'approved' ? 'ready' : 'rejected', stage: result === 'approved' ? 'ready' : 'rejected', chunk_count: result === 'approved' ? 12 : 0,
    reviewed_by: '1', reviewed_at: reviewedAt, reviewer: root, review_note: '', ...extra,
  })
  const mock = await mockApi(page, { history: [
    reviewed('h1', 'onboarding-checklist.md', 'approved'),
    reviewed('h2', 'office-wifi.txt', 'rejected', { uploader: bob, source_type: 'text', review_note: '内容包含内网 Wi-Fi 密码，不能放进平台库' }),
    reviewed('h3', 'network-ports.md', 'approved', { chunk_count: 9 }),
  ] })
  await page.goto('/admin/reviews/history')
  await expect(page.getByRole('link', { name: '已审批 3' })).toBeVisible()
  await expect(page.getByRole('row')).toHaveCount(4)
  const results = page.getByRole('group', { name: '审批结果' })
  await expect(results.getByRole('button', { name: /^全部/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(results.getByRole('button', { name: /^已通过/ })).toContainText('2')
  await expect(results.getByRole('button', { name: /^已驳回/ })).toContainText('1')

  await results.getByRole('button', { name: /^已驳回/ }).click()
  await expect(results.getByRole('button', { name: /^已驳回/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('row')).toHaveCount(2)
  await expect(page.getByRole('cell', { name: '内容包含内网 Wi-Fi 密码，不能放进平台库' })).toBeVisible()
  expect(mock.historyRequests.at(-1)?.searchParams.get('result')).toBe('rejected')

  await page.getByRole('button', { name: 'office-wifi.txt', exact: true }).click()
  const drawer = page.getByRole('dialog', { name: 'office-wifi.txt' })
  await expect(drawer.getByText('1 / 1')).toBeVisible()
  await expect(drawer.getByText('已驳回')).toBeVisible()
  await expect(drawer.getByText(/^管理员，\d\d\/\d\d \d\d:\d\d$/)).toBeVisible()
  await expect(drawer.getByText('内容包含内网 Wi-Fi 密码，不能放进平台库')).toBeVisible()
  await expect(drawer.getByText('已删除')).toBeVisible()
  await expect(drawer.getByRole('link', { name: '打开这份文档' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  await results.getByRole('button', { name: /^已通过/ }).click()
  await expect(page.getByRole('row')).toHaveCount(3)
  expect(mock.historyRequests.at(-1)?.searchParams.get('result')).toBe('approved')
  await page.getByRole('button', { name: 'network-ports.md', exact: true }).click()
  const approved = page.getByRole('dialog', { name: 'network-ports.md' })
  await expect(approved.getByText('已就绪，9 个分块').first()).toBeVisible()
  await expect(approved.getByRole('link', { name: '打开这份文档' })).toHaveAttribute('href', '/knowledge/kb-1/documents/h3')
  await approved.getByRole('button', { name: '上一项' }).click()
  await expect(page.getByRole('dialog', { name: 'onboarding-checklist.md' }).getByText('1 / 2')).toBeVisible()
  expect(mock.unexpected).toEqual([])
})
