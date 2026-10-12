import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Conversation, Dataset, Document, KnowledgeBase, Run } from '../src/lib/types'

// Read-only integration smoke test: requires the running API and seeded real demo records.
// Never sends a question, starts an evaluation, uploads a document, or calls paid models.
async function expectNoPageOverflow(page: Page): Promise<void> {
  const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }))
  expect(layout.scroll, JSON.stringify(layout)).toBeLessThanOrEqual(layout.width + 1)
}

// Radix places/focuses its portalled options asynchronously. Visibility alone
// does not mean the next key will reach an option instead of the trigger.
async function chooseByKeyboard(page: Page): Promise<void> {
  const listbox = page.getByRole('listbox')
  const options = listbox.getByRole('option')
  await expect(listbox.locator('[role="option"]:focus')).toHaveCount(1)
  await page.keyboard.press('Home')
  await expect(options.first()).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(options.nth(await options.count() > 1 ? 1 : 0)).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(listbox).toBeHidden()
}

async function expectRenderedPdf(page: Page, selector: string): Promise<void> {
  await expect(page.locator(selector)).toHaveAttribute('data-pdf-state', 'ready', { timeout: 30000 })
  const canvas = page.locator(`${selector} canvas`)
  await expect(canvas).toBeAttached()
  await expect.poll(async () => canvas.evaluate(element => {
    const surface = element as HTMLCanvasElement
    const context = surface.getContext('2d')
    if (!context || !surface.width || !surface.height) return 0
    const pixels = context.getImageData(0, 0, surface.width, surface.height).data
    let darkPixels = 0
    for (let index = 0; index < pixels.length; index += 16) {
      if (pixels[index + 3] > 200 && pixels[index] < 180 && pixels[index + 1] < 180 && pixels[index + 2] < 180) darkPixels++
    }
    return darkPixels
  }), { timeout: 30000 }).toBeGreaterThan(50)
}

// Signs in as an administrator who owns the demo conversation (after the account migration: the first admin).
const QA_USERNAME = process.env.RAG_QA_USERNAME ?? ''
const QA_PASSWORD = process.env.RAG_QA_PASSWORD ?? ''

test('real workspace, citations, documents, evaluations and responsive layouts', async ({ page }) => {
  test.skip(!QA_USERNAME || !QA_PASSWORD, 'Set RAG_QA_USERNAME and RAG_QA_PASSWORD to run against the real workspace')
  const login = await page.request.post('/api/auth/login', { data: { username: QA_USERNAME, password: QA_PASSWORD } })
  expect(login.ok(), await login.text()).toBe(true)
  const request = page.request
  const screenshots = resolve(process.cwd(), '../docs/screenshots')
  await mkdir(screenshots, { recursive: true })
  const failures: string[] = []
  page.on('pageerror', error => failures.push(`page: ${error.message}`))
  page.on('console', message => { if (message.type() === 'error') failures.push(`console: ${message.text()}`) })
  page.on('response', response => { if (response.url().includes('/api/') && response.status() >= 400) failures.push(`api: ${response.status()} ${response.url()}`) })
  page.on('requestfailed', request => {
    const reason = request.failure()?.errorText ?? ''
    if (!reason.includes('ERR_ABORTED')) failures.push(`network: ${reason} ${request.url()}`)
  })
  const kbs = await (await request.get('/api/knowledge-bases')).json() as KnowledgeBase[]
  const conversations = await (await request.get('/api/conversations')).json() as Conversation[]
  const runs = await (await request.get('/api/runs')).json() as Run[]
  const datasets = await (await request.get('/api/datasets')).json() as Dataset[]
  expect(kbs.length).toBeGreaterThan(0)
  expect(conversations.length).toBeGreaterThan(0)
  // Prefer the bundled demo library this walkthrough was written against; newer libraries may hold other data.
  const kb = kbs.find(item => item.name === '入门演示' && item.ready_count > 0) ?? kbs.find(item => item.ready_count > 0)!
  const docs = await (await request.get(`/api/knowledge-bases/${kb.id}/documents`)).json() as Document[]
  const doc = docs.find(item => item.status === 'ready')!
  const conversation = conversations.find(item => item.knowledge_base_id === kb.id)!
  const run = runs.find(item => item.status === 'completed')!
  const dataset = datasets.find(item => item.question_count > 0)!
  expect(doc).toBeTruthy(); expect(conversation).toBeTruthy(); expect(run).toBeTruthy(); expect(dataset).toBeTruthy()
  const routes = [
    { path: `/chat/${conversation.id}`, heading: '知识问答', name: 'chat' },
    { path: '/knowledge', heading: '知识库', name: 'knowledge' },
    { path: `/knowledge/${kb.id}`, heading: kb.name, name: 'knowledge-detail' },
    { path: `/knowledge/${kb.id}/documents/${doc.id}`, heading: doc.filename, name: 'document' },
    { path: '/evaluation', heading: '批量评测', name: 'evaluations' },
    { path: `/evaluation/runs/${run.id}`, heading: run.name, name: 'run' },
    { path: `/evaluation/datasets/${dataset.id}`, heading: dataset.name, name: 'dataset' },
    { path: '/evaluation/retrieval', heading: '检索对比', name: 'debug' },
    { path: '/settings', heading: '环境与设置', name: 'settings' },
  ]
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: width < 500 ? 812 : 1000 })
    for (const route of routes) {
      await page.goto(route.path)
      await expect(page.getByRole('heading', { name: route.heading, exact: true }).first()).toBeVisible()
      await expect(page.locator('.error-state')).toHaveCount(0)
      // Radix uses an aria-hidden bubble select for native form serialization, never as its UI.
      await expect(page.locator('select:not([aria-hidden="true"])')).toHaveCount(0)
      await expect(page.locator('.page-header p')).toHaveCount(0)
      if (route.name === 'document') await expectRenderedPdf(page, '.document-original .pdf-viewer')
      await expectNoPageOverflow(page)
      if (width === 1440 || (width === 375 && ['chat', 'knowledge', 'run', 'settings'].includes(route.name))) {
        await page.screenshot({ path: resolve(screenshots, `${route.name}-${width}.png`), fullPage: true })
      }
    }
  }
  await page.goto(`/chat/${conversation.id}`)
  await expect(page.locator('.message-assistant .markdown')).toContainText('Milvus')
  await expect(page.locator('.message-user .user-content').first()).toHaveCSS('background-color', 'rgb(221, 232, 225)')
  await expect(page.locator('.assistant-bubble').first()).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  const userBubble = await page.locator('.message-user .user-content').first().boundingBox()
  const answerBubble = await page.locator('.assistant-bubble').first().boundingBox()
  expect(userBubble!.x).toBeGreaterThan(answerBubble!.x)
  await expect(page.locator('.chat-header').getByRole('button', { name: '新建对话' })).toHaveCount(0)
  await expect(page.locator('.chat-header').getByRole('link', { name: '检索调试' })).toHaveCount(0)
  await expect(page.locator('.message-assistant .citations-compact > summary')).toHaveAccessibleName(/引用来源，\d+ 条/)
  await page.locator('.message-assistant .message-support > .citations > summary').click()
  await expect(page.locator('.citation-item')).not.toHaveCount(0)
  await expect(page.locator('.excerpt p').first()).toBeVisible()
  await page.screenshot({ path: resolve(screenshots, 'chat-citation-preview-1440.png'), fullPage: true })
  await page.getByRole('button', { name: '展开全文', exact: true }).first().click()
  await expect(page.getByRole('button', { name: '收起', exact: true }).first()).toBeVisible()
  await page.screenshot({ path: resolve(screenshots, 'chat-citations-1440.png'), fullPage: true })
  await page.locator('.citation-source').first().click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expectRenderedPdf(page, '.dialog-drawer .pdf-viewer')
  await expect(page.locator('.dialog-drawer canvas')).toHaveAttribute('data-pdf-page', '1')
  await page.screenshot({ path: resolve(screenshots, 'citation-pdf-1440.png'), fullPage: true })
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.goto(`/knowledge/${kb.id}/documents/${doc.id}`)
  // Chunks are the default tab of the parsed pane; the parsed text is one tab over.
  await page.getByRole('tab', { name: '解析正文' }).click()
  await expect(page.locator('.document-parsed .markdown')).toContainText('Milvus')
  await page.getByRole('tab', { name: /^分块/ }).click()
  await expect(page.locator('.chunk-card')).not.toHaveCount(0)
  await page.locator('.chunk-card').first().click()
  await expectRenderedPdf(page, '.document-original .pdf-viewer')
  await expect(page.locator('.document-original canvas')).toHaveAttribute('data-pdf-page', '1')
  await page.screenshot({ path: resolve(screenshots, 'document-chunks-1440.png'), fullPage: true })
  await page.goto(`/evaluation/runs/${run.id}`)
  await page.getByRole('table', { name: '逐题结果' }).locator('tbody .ev-q').first().click()
  await expect(page.getByRole('dialog')).toContainText('参考答案')
  await expect(page.getByRole('dialog')).toContainText('Milvus')
  await page.screenshot({ path: resolve(screenshots, 'evaluation-inspection-1440.png'), fullPage: true })
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出 JSON' }).click()
  expect((await download).suggestedFilename()).toBe(`rag-run-${run.id}.json`)
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 })
    await page.goto(`/chat/${conversation.id}`)
    await expect(page.locator('.message-assistant .markdown')).toBeVisible()
    await expect(page.locator('.debug-details')).not.toHaveAttribute('open')
    const toggle = page.getByRole('button', { name: /^(展开|隐藏)对话历史$/ })
    if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click()
    const before = await page.locator('.chat-main').boundingBox()
    await toggle.click()
    await expect(page.getByRole('region', { name: '对话历史' })).toBeVisible()
    await expect(page.locator('.conversation-sidebar')).toHaveCount(0)
    await expect(page.locator('.rail-history').getByRole('button', { name: /收起|折叠/ })).toHaveCount(0)
    const expanded = await page.locator('.chat-main').boundingBox()
    if (width === 1440) expect(expanded!.width).toBeLessThan(before!.width)
    const navigationBox = await page.locator('.app-rail .primary-nav').boundingBox()
    const historyBox = await page.locator('.rail-history').boundingBox()
    expect(historyBox!.y).toBeGreaterThan(navigationBox!.y + navigationBox!.height)
    await page.screenshot({ path: resolve(screenshots, `chat-history-${width}.png`), fullPage: true })
    if (width < 1024) await page.keyboard.press('Escape')
    else await toggle.click()
    await expect(page.getByRole('region', { name: '对话历史' })).toBeHidden()
    const kbSelect = page.getByRole('combobox', { name: '选择知识库', exact: true })
    await kbSelect.focus(); await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('listbox')).toBeVisible()
    await chooseByKeyboard(page)
    await expect(page.getByRole('listbox')).toBeHidden()
    await expect(kbSelect).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('listbox')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(kbSelect).toBeFocused()
    await expectNoPageOverflow(page)
    await page.goto('/evaluation')
    await page.getByRole('button', { name: '新建评测', exact: true }).click()
    await expect(page.getByRole('dialog').getByRole('textbox', { name: '评测名称' })).toBeFocused()
    const runKb = page.getByRole('dialog').getByRole('button', { name: '知识库', exact: true })
    await runKb.focus(); await page.keyboard.press('Enter')
    await expect(page.getByRole('listbox')).toBeVisible()
    await chooseByKeyboard(page)
    await expect(runKb).toBeFocused()
    await expect(runKb).not.toHaveText('选择知识库')
    const runDataset = page.getByRole('dialog').getByRole('button', { name: '题集', exact: true })
    await runDataset.focus(); await page.keyboard.press('Enter')
    await expect(page.getByRole('listbox')).toBeVisible()
    await expectNoPageOverflow(page)
    await page.screenshot({ path: resolve(screenshots, `run-select-${width}.png`), fullPage: true })
    await chooseByKeyboard(page)
    await expect(runDataset).toBeFocused()
    await runDataset.press('Enter'); await expect(page.getByRole('listbox')).toBeVisible(); await page.keyboard.press('Escape')
    await expect(runDataset).toBeFocused()
    await page.getByRole('button', { name: '取消', exact: true }).click()
  }
  await page.goto('/chat')
  await expect(page.getByRole('heading', { name: '知识问答', exact: true })).toBeVisible()
  await expect(page.locator('.chat-welcome')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '新对话', exact: true })).toHaveCount(0)
  await page.goto('/evaluation')
  await page.getByRole('navigation', { name: '评测工作区', exact: true }).getByRole('link', { name: '检索对比', exact: true }).click()
  await expect(page).toHaveURL(/\/evaluation\/retrieval$/)
  await expect(page.getByRole('navigation', { name: '主要导航' }).getByRole('link', { name: '评测', exact: true })).toHaveAttribute('aria-current', 'page')
  await page.goto(`/debug?kb=${kb.id}`)
  await expect(page).toHaveURL(new RegExp(`/evaluation/retrieval\\?kb=${kb.id}$`))
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/settings')
  await page.getByRole('button', { name: '环境检查（不计费）' }).click()
  await expect(page.getByRole('heading', { name: '环境检查结果' })).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.error-state')).toHaveCount(0)
  await page.screenshot({ path: resolve(screenshots, 'settings-checked-1440.png'), fullPage: true })
  expect(failures).toEqual([])
})
