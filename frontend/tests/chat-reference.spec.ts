import { expect, test, type Page } from '@playwright/test'
import { ADMIN_ACCOUNT } from './support/accounts'

// Fully isolated UI fixtures: no model requests, uploads, evaluations or real records.
const createdAt = '2026-09-30T09:20:00Z'
const citationText = 'RAG uses retrieved document passages as evidence for a generated answer. '.repeat(8)
const citation = { id: 'chunk-1', document_id: 'doc-1', filename: 'rag-notes.pdf', page: 1, text: citationText }
const profile = { id: 'model-1', name: 'deepseek-v4-flash-0731', model: 'mock-model', protocol: 'openai_chat', base_url: 'https://mock.invalid/v1', enabled: true, is_default: true, api_key_set: true, max_tokens: 4096, timeout_seconds: 120, json_mode: true, updated_at: createdAt }
const common = { conversation_id: 'chat-1', status: 'completed', stage: 'completed', method: 'hybrid_rerank', created_at: createdAt, citations: [], contexts: [], timing: {}, usage: {} }
const fixtureMessages = [
  { ...common, id: 'm1', role: 'user', content: 'RAG 的核心原理是什么？请用通俗的方式解释。' },
  { ...common, id: 'm2', role: 'assistant', content: '**RAG（检索增强生成）** 是将外部知识检索与大语言模型生成结合的技术。\n\n它的核心思路是：**先从知识库中检索相关内容**，再让模型基于这些材料回答问题。\n\n1. **检索**：找到与问题相关的文档片段。\n2. **增强**：将片段和问题一起交给模型。\n3. **生成**：回答问题，并标明引用依据。', citations: [citation, citation], contexts: [citation], model_snapshot: profile },
]

function sourcePdf(): Buffer {
  const stream = 'BT /F1 18 Tf 40 720 Td (RAG source evidence) Tj ET'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(pdf)
}

async function mockChat(page: Page, status: 'completed' | 'processing' | 'failed' = 'completed') {
  const writes: string[] = []
  const unexpected: string[] = []
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { document.documentElement.dataset.copiedText = text } } })
  })
  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/auth/me') return route.fulfill({ json: ADMIN_ACCOUNT })
    if (request.method() !== 'GET') { writes.push(path); return route.fulfill({ status: 400, json: { detail: 'No writes expected' } }) }
    if (path === '/api/model-profiles') return route.fulfill({ json: [profile] })
    if (path === '/api/knowledge-bases') return route.fulfill({ json: [{ id: 'kb-1', name: '入门演示', ready_count: 1, document_count: 1, chunk_count: 2 }] })
    if (path === '/api/conversations') return route.fulfill({ json: [{ id: 'chat-1', knowledge_base_id: 'kb-1', title: 'RAG 的核心原理', created_at: createdAt }] })
    if (path === '/api/conversations/chat-1/messages') return route.fulfill({ json: status === 'completed' ? fixtureMessages : [fixtureMessages[0], { ...fixtureMessages[1], content: '', status, stage: status === 'processing' ? 'generating' : 'failed', error: status === 'failed' ? '模型服务暂时不可用，请检查连接。' : null }] })
    if (path === '/api/documents/doc-1/file') return route.fulfill({ contentType: 'application/pdf', body: sourcePdf() })
    unexpected.push(path)
    return route.fulfill({ status: 404, json: { detail: 'Unknown fixture route' } })
  })
  return { writes, unexpected }
}

async function expectFits(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const composer = await page.locator('.composer').boundingBox()
  expect(composer!.y + composer!.height).toBeLessThanOrEqual(page.viewportSize()!.height)
}

test('reference welcome fills a draft without sending and keeps responsive controls', async ({ page }, testInfo) => {
  const mock = await mockChat(page)
  for (const width of [1440, 768, 375]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 })
    await page.goto('/chat')
    await expect(page.getByRole('heading', { name: '基于知识库的问答助手' })).toBeVisible()
    await expect(page.getByRole('combobox', { name: '选择对话模型' })).toContainText(profile.name)
    await expectFits(page)
    if (width !== 768) await page.screenshot({ path: testInfo.outputPath(`welcome-${width}.png`) })
    await page.getByRole('button', { name: '总结主要内容', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '输入问题' })).toHaveValue('请概括知识库资料的主要内容，并列出引用来源。')
    await expect(page.getByRole('textbox', { name: '输入问题' })).toBeFocused()
    await page.getByRole('button', { name: '检索设置', exact: true }).click()
    await expect(page.getByRole('combobox', { name: '检索方法' })).toBeVisible()
    await expectFits(page)
  }
  expect(mock.writes).toEqual([])
  expect(mock.unexpected).toEqual([])
})

test('reference conversation preserves source expansion, PDF, copy and model identity', async ({ page }, testInfo) => {
  const mock = await mockChat(page)
  for (const width of [1440, 768, 375]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 })
    await page.goto('/chat/chat-1')
    await expect(page.locator('.assistant-bubble')).toContainText('RAG（检索增强生成）')
    await expect(page.locator('.chat-avatar')).toHaveCount(2)
    await expect(page.locator('.user-content')).toHaveCSS('background-color', 'rgb(228, 237, 255)')
    await expect(page.locator('.assistant-bubble')).toHaveCSS('background-color', 'rgb(245, 246, 249)')
    const user = await page.locator('.user-content').boundingBox()
    const assistant = await page.locator('.assistant-bubble').boundingBox()
    if (width === 1440) expect(user!.x).toBeGreaterThan(assistant!.x)
    await expect(page.getByLabel('引用来源，1 条')).toBeVisible()
    const source = await page.getByLabel('引用来源，1 条').boundingBox()
    expect(source!.y).toBeGreaterThanOrEqual(assistant!.y + assistant!.height)
    await expectFits(page)
    if (width !== 768) await page.screenshot({ path: testInfo.outputPath(`conversation-${width}.png`) })
    await page.getByLabel('引用来源，1 条').click()
    await expect(page.locator('.message-support .citation-item')).toHaveCount(1)
    await page.getByRole('button', { name: '展开全文', exact: true }).click()
    await expect(page.locator('.message-support .excerpt p')).toHaveText(citationText.trim())
    await page.locator('.message-support .citation-source').click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.locator('.dialog-drawer .pdf-viewer')).toHaveAttribute('data-pdf-state', 'ready', { timeout: 15000 })
    await expect(page.locator('.dialog-drawer canvas')).toHaveAttribute('data-rendered', 'true')
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByLabel('引用来源，1 条').click()
    await page.getByRole('button', { name: '复制回答', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-copied-text', fixtureMessages[1].content)
    await page.locator('.debug-details > summary').click()
    await expect(page.getByText('模型 ID：mock-model', { exact: true })).toBeVisible()
    await page.locator('.debug-details > summary').click()
  }
  expect(mock.writes).toEqual([])
  expect(mock.unexpected).toEqual([])
})

for (const status of ['processing', 'failed'] as const) {
  test(`reference conversation keeps ${status} feedback`, async ({ page }) => {
    const mock = await mockChat(page, status)
    await page.setViewportSize({ width: 375, height: 844 })
    await page.goto('/chat/chat-1')
    if (status === 'processing') {
      await expect(page.locator('.pending-answer')).toBeVisible()
      await expect(page.getByRole('textbox', { name: '输入问题' })).toBeDisabled()
    } else await expect(page.locator('.message-assistant .error-state')).toContainText('模型服务暂时不可用')
    await expect(page.locator('.message-support')).toHaveCount(0)
    await expectFits(page)
    expect(mock.writes).toEqual([])
    expect(mock.unexpected).toEqual([])
  })
}
