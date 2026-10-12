import { expect, test, type Page } from '@playwright/test'
import { ADMIN_ACCOUNT } from './support/accounts'

// Fully mocked: collapsing/resizing the chat panes and linking answer markers to evidence cards.
const createdAt = '2026-09-30T09:20:00Z'
const profile = { id: 'model-1', name: 'mock-chat', model: 'mock-model', protocol: 'openai_chat', base_url: 'https://mock.invalid/v1', enabled: true, is_default: true, api_key_set: true, max_tokens: 4096, timeout_seconds: 120, json_mode: true, updated_at: createdAt }
const first = { id: 'chunk-1', document_id: 'doc-1', filename: 'leave-policy.pdf', page: 3, score: 0.912, text: '年假按入职年限计算，满一年享有五天。' }
const second = { id: 'chunk-2', document_id: 'doc-2', filename: 'handbook.docx', page: 7, score: 0.774, text: '病假需提交医院证明，三天以内由直属主管审批。' }
const uncited = { id: 'chunk-3', document_id: 'doc-2', filename: 'handbook.docx', page: 9, score: 0.41, text: '加班调休需在三个月内使用。' }
const candidates = (ids: string[]) => ids.map((id, index) => ({ rank: index + 1, id, document_id: 'doc-1', filename: 'leave-policy.pdf', page: 1, score: 1 - index / 10, text: `${id} 的正文摘录` }))
const trace = {
  config: { method: 'hybrid_rerank', top_k: 2, rerank: true }, queries: ['年假和病假怎么请？'],
  stages: [
    { stage: 'recall.vector', ms: 40, count: 3, candidates: candidates(['chunk-1', 'chunk-3', 'chunk-2']) },
    { stage: 'recall.bm25', ms: 12, count: 3, candidates: candidates(['chunk-2', 'chunk-1', 'chunk-3']) },
    { stage: 'fusion', ms: 1, count: 3, method: 'rrf', candidates: candidates(['chunk-1', 'chunk-2', 'chunk-3']) },
    { stage: 'rerank', ms: 80, count: 3, candidates: candidates(['chunk-1', 'chunk-2', 'chunk-3']) },
    { stage: 'postprocess', ms: 1, input: 3, kept: 2, top_k: 2, candidates: candidates(['chunk-1', 'chunk-2']) },
  ],
}
const common = { conversation_id: 'chat-1', status: 'completed', stage: 'completed', method: 'hybrid_rerank', created_at: createdAt, citations: [], contexts: [], timing: {}, usage: {} }
const messages = [
  { ...common, id: 'm1', role: 'user', content: '年假和病假怎么请？' },
  { ...common, id: 'm2', role: 'assistant', content: '年假按入职年限计算[^1]；病假需提交医院证明[^2]。', citations: [first, second], contexts: [first, second, uncited], retrieval_trace: trace, model_snapshot: profile, timing: { retrieval_ms: 133, generation_ms: 900 } },
  { ...common, id: 'm3', role: 'user', content: '加班以后怎么调休？这是一个很长很长的问题，用来检查下拉框里超出宽度的部分会被省略号截断' },
  { ...common, id: 'm4', role: 'assistant', content: '加班调休需在三个月内使用。', citations: [uncited], contexts: [uncited], retrieval_trace: trace, model_snapshot: profile },
]

async function mockChat(page: Page, rows: unknown[] = messages, hits: { messages: number } = { messages: 0 }) {
  const unexpected: string[] = []
  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() !== 'GET') { unexpected.push(`${request.method()} ${path}`); return route.fulfill({ status: 400, json: { detail: 'No writes expected' } }) }
    if (path === '/api/auth/me') return route.fulfill({ json: ADMIN_ACCOUNT })
    if (path === '/api/admin/reviews/count') return route.fulfill({ json: { documents: 0, total: 0 } })
    if (path === '/api/model-profiles') return route.fulfill({ json: [profile] })
    if (path === '/api/knowledge-bases') return route.fulfill({ json: [{ id: 'kb-1', name: '人事制度', ready_count: 2, document_count: 2, chunk_count: 3 }] })
    if (path === '/api/conversations') return route.fulfill({ json: [{ id: 'chat-1', knowledge_base_id: 'kb-1', title: '年假和病假', created_at: createdAt }] })
    if (path === '/api/conversations/chat-1/messages') { hits.messages += 1; return route.fulfill({ json: rows }) }
    unexpected.push(path)
    return route.fulfill({ status: 404, json: { detail: 'Unknown fixture route' } })
  })
  return unexpected
}

async function width(page: Page, selector: string): Promise<number> {
  return Math.round((await page.locator(selector).boundingBox())!.width)
}

test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1440, height: 1000 }) })

test('conversation list collapses, resizes by drag and keyboard, and remembers both', async ({ page }) => {
  const unexpected = await mockChat(page)
  await page.goto('/chat/chat-1')
  const history = page.getByRole('region', { name: '对话历史' })
  await expect(history.getByText('年假和病假')).toBeVisible()
  expect(await width(page, '.tm-chat-list')).toBe(248)

  const handle = page.getByRole('separator', { name: '拖动调整对话列表宽度' })
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + 200)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + 200, { steps: 5 })
  await page.mouse.up()
  expect(await width(page, '.tm-chat-list')).toBe(308)
  await page.mouse.move(box.x + 60, box.y + 200)
  await page.mouse.down()
  await page.mouse.move(box.x + 400, box.y + 200, { steps: 5 })
  await page.mouse.up()
  await expect(handle).toHaveAttribute('aria-valuenow', '360')
  await handle.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(handle).toHaveAttribute('aria-valuenow', '344')

  await page.getByRole('button', { name: '收起对话列表' }).click()
  await expect(history).toHaveCount(0)
  expect(await width(page, '.tm-chat-list-collapsed')).toBeLessThan(60)
  await page.reload()
  await expect(page.getByRole('complementary', { name: '对话列表已收起' })).toBeVisible()
  await page.getByRole('button', { name: '展开对话列表' }).click()
  await expect(history).toBeVisible()
  expect(await width(page, '.tm-chat-list')).toBe(344)
  expect(unexpected).toEqual([])
})

test('evidence pane collapses, resizes, and keeps a separate width for the recall chain', async ({ page }) => {
  const unexpected = await mockChat(page)
  await page.goto('/chat/chat-1')
  const pane = page.getByRole('complementary', { name: '回答依据' })
  await expect(pane.locator('.evidence-card')).toHaveCount(2)
  expect(await width(page, '.evidence-pane')).toBe(400)

  const handle = page.getByRole('separator', { name: '拖动调整右侧面板宽度' })
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + 300)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 - 80, box.y + 300, { steps: 5 })
  await page.mouse.up()
  expect(await width(page, '.evidence-pane')).toBe(480)

  await pane.getByRole('tab', { name: /召回链路/ }).click()
  await expect(pane.getByRole('tab', { name: /召回链路/ })).toHaveAttribute('aria-selected', 'true')
  expect(await width(page, '.evidence-pane')).toBe(640)
  await expect(pane.locator('.trace-stage').first()).toBeVisible()
  // Each candidate carries a short excerpt of its chunk.
  await expect(pane.getByRole('columnheader', { name: '内容' })).toBeVisible()
  await expect(pane.locator('.trace-excerpt').first()).toHaveText('chunk-1 的正文摘录')
  await pane.getByRole('tab', { name: /引用/ }).click()
  expect(await width(page, '.evidence-pane')).toBe(480)

  await pane.getByRole('button', { name: '收起右侧面板' }).click()
  await expect(pane).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('complementary', { name: '右侧面板已收起' })).toBeVisible()
  await page.getByRole('button', { name: '展开右侧面板' }).click()
  await expect(pane.locator('.evidence-card')).toHaveCount(2)
  expect(await width(page, '.evidence-pane')).toBe(480)
  expect(unexpected).toEqual([])
})

test('answer citation markers select the matching evidence card and back', async ({ page }) => {
  const unexpected = await mockChat(page)
  await page.goto('/chat/chat-1')
  const pane = page.getByRole('complementary', { name: '回答依据' })
  const cards = pane.locator('.evidence-card')
  await expect(cards).toHaveCount(2)
  await expect(pane.getByRole('tab', { name: /引用/ })).toContainText('2')
  // Memories are for MCP agents only; answers never reference them.
  await expect(pane.getByRole('tab')).toHaveText([/^引用/, '召回链路'])
  await expect(pane.getByRole('region', { name: '召回但未引用' })).toContainText('加班调休')

  // Markers sit after the sentence they support, not in a row at the end of the answer.
  await expect(page.locator('.assistant-bubble').first().locator('.markdown .tm-cite')).toHaveCount(2)
  await expect(page.locator('.assistant-bubble').first().locator('.answer-cites')).toHaveCount(0)
  await expect(page.locator('.assistant-bubble').first()).not.toContainText('[^')
  const marker2 = page.getByRole('button', { name: '引用 2：handbook.docx 第 7 页' })
  await marker2.click()
  await expect(page.locator('.answer-claim[data-active]')).toHaveText('病假需提交医院证明')
  await expect(marker2).toHaveAttribute('aria-pressed', 'true')
  await expect(cards.nth(1)).toHaveAttribute('aria-current', 'true')
  await expect(cards.nth(0)).not.toHaveAttribute('aria-current', 'true')
  await expect(cards.nth(1)).toContainText('病假需提交医院证明')
  await expect(cards.nth(1).getByRole('link', { name: '打开原文第 7 页' })).toHaveAttribute('href', '/knowledge/kb-1/documents/doc-2?page=7&chunk=chunk-2&from=%2Fchat%2Fchat-1')

  await pane.getByRole('button', { name: '选中引用 1' }).click()
  await expect(cards.nth(0)).toHaveAttribute('aria-current', 'true')
  await expect(page.getByRole('button', { name: '引用 1：leave-policy.pdf 第 3 页' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.answer-claim[data-active]')).toHaveText('年假按入职年限计算')
  await expect(marker2).toHaveAttribute('aria-pressed', 'false')

  // The marker opens the citations tab even from the recall chain.
  await pane.getByRole('tab', { name: /召回链路/ }).click()
  await marker2.click()
  await expect(pane.getByRole('tab', { name: /引用/ })).toHaveAttribute('aria-selected', 'true')
  await expect(cards.nth(1)).toHaveAttribute('aria-current', 'true')
  expect(unexpected).toEqual([])
})

test('copying an answer drops the inline citation markers', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { document.documentElement.dataset.copiedText = text } } })
  })
  const unexpected = await mockChat(page)
  await page.goto('/chat/chat-1')
  await page.locator('.message-assistant').first().getByRole('button', { name: '复制回答', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-copied-text', '年假按入职年限计算；病假需提交医院证明。')
  expect(unexpected).toEqual([])
})

test('messages are polled only while an answer is still being generated', async ({ page }) => {
  const done = { messages: 0 }
  await mockChat(page, messages, done)
  await page.goto('/chat/chat-1')
  await expect(page.locator('.evidence-card')).toHaveCount(2)
  // Development StrictMode may fetch twice on mount; after that nothing may follow.
  const loaded = done.messages
  await page.waitForTimeout(4500)
  expect(done.messages).toBe(loaded)

  const running = { messages: 0 }
  await page.unrouteAll()
  await mockChat(page, [messages[0], { ...messages[1], content: '', status: 'processing', stage: 'generating', citations: [], contexts: [] }], running)
  await page.reload()
  await expect(page.locator('.pending-answer')).toBeVisible()
  await expect.poll(() => running.messages, { timeout: 7000 }).toBeGreaterThanOrEqual(3)
})

test('the pane explains the first question by default and switches through the question picker', async ({ page }) => {
  const unexpected = await mockChat(page)
  await page.goto('/chat/chat-1')
  const pane = page.getByRole('complementary', { name: '回答依据' })
  const picker = pane.getByRole('button', { name: /^选择问题/ })
  await expect(picker).toContainText('问题 1')
  await expect(picker).toContainText('年假和病假怎么请？')
  await expect(pane.locator('.evidence-card')).toHaveCount(2)

  await picker.click()
  const list = page.getByRole('listbox', { name: '选择问题' })
  await expect(list.getByRole('option')).toHaveCount(2)
  await expect(list.getByRole('option', { selected: true })).toContainText('问题 1')
  // The list is as wide as the pane and long questions are cut with an ellipsis.
  const paneBox = (await pane.boundingBox())!
  const listBox = (await page.locator('.evidence-question-pop').boundingBox())!
  expect(Math.abs(listBox.width - paneBox.width)).toBeLessThanOrEqual(2)
  const long = list.getByRole('option').nth(1).locator('.evidence-question-text')
  expect(await long.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(list).toHaveCount(0)
  await expect(picker).toContainText('问题 2')
  await expect(pane.locator('.evidence-card')).toHaveCount(1)
  await expect(pane.locator('.evidence-card')).toContainText('handbook.docx')
  // No scrollbar inside the pane header.
  expect(await pane.locator('.evidence-tabs').evaluate(element => ['visible', 'hidden', 'clip'].includes(getComputedStyle(element).overflowY))).toBe(true)
  expect(unexpected).toEqual([])
})

test('a citation marker reopens a collapsed pane on that answer and citation', async ({ page }) => {
  const unexpected = await mockChat(page)
  await page.goto('/chat/chat-1')
  await page.getByRole('button', { name: '收起右侧面板' }).click()
  await expect(page.getByRole('complementary', { name: '右侧面板已收起' })).toBeVisible()
  // The second answer has no inline marker, so its citation sits at the answer's top-right.
  const bubble = page.locator('.assistant-bubble').nth(1)
  const corner = bubble.locator('.answer-cites')
  const bubbleBox = (await bubble.boundingBox())!
  const cornerBox = (await corner.boundingBox())!
  expect(cornerBox.y - bubbleBox.y).toBeLessThan(24)
  expect(bubbleBox.x + bubbleBox.width - (cornerBox.x + cornerBox.width)).toBeLessThan(24)
  await corner.getByRole('button', { name: /^引用 1：handbook.docx/ }).click()
  const pane = page.getByRole('complementary', { name: '回答依据' })
  await expect(pane).toBeVisible()
  await expect(pane.getByRole('button', { name: /^选择问题/ })).toContainText('问题 2')
  await expect(pane.locator('.evidence-card').first()).toHaveAttribute('aria-current', 'true')
  expect(unexpected).toEqual([])
})
