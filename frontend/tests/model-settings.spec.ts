import { expect, test, type Page } from '@playwright/test'
import { ADMIN_ACCOUNT } from './support/accounts'
import type { ModelProfile, ModelProfileInput } from '../src/lib/configuration'
import type { Message, Settings } from '../src/lib/types'

// Synthetic fixtures only. Every /api request is intercepted; no real model is called.
const stamp = '2026-09-29T10:00:00Z'
const profileFixture = (id: string, name: string, isDefault = false): ModelProfile => ({ id, name, model: `test-model-${id}`, protocol: 'openai_chat', base_url: 'https://models.example.test/v1', api_key_set: true, is_default: isDefault, enabled: true, max_tokens: 4096, timeout_seconds: 120, json_mode: true, updated_at: stamp })
const settingsFixture = (): Settings => ({
  chat: { model: 'test-model-1', base_url: 'https://models.example.test/v1', configured: true, profile_id: '1', protocol: 'openai_chat' },
  embedding: { model: 'test-embedding', base_url: 'https://embedding.example.test/v1', configured: true, dimensions: 1024 },
  rerank: { model: 'test-rerank', base_url: 'https://rerank.example.test/v1', configured: true, protocol: 'dashscope' },
  mineru: { base_url: 'http://mineru.example.test:8000' }, milvus: { uri: 'http://milvus.example.test:19530', collection: 'rag_workbench_fixture' },
  storage: { backend: 'PostgreSQL + Milvus', local_only: true }, editable: true,
})
interface Call { method: string; path: string; body: Record<string, unknown> }
async function mockApi(page: Page) {
  let profiles = [profileFixture('1', '默认测试模型', true), profileFixture('2', '备用测试模型'), { ...profileFixture('3', '已停用测试模型'), enabled: false }]
  let settings = settingsFixture()
  const messages: Message[] = []
  const calls: Call[] = []
  const unexpected: string[] = []
  let rejectNextSave = false
  let rejectNextProbe = false
  let revision = 0
  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api', '')
    const method = request.method()
    if (path === '/auth/me') return route.fulfill({ json: ADMIN_ACCOUNT })
    if (path === '/admin/reviews/count') return route.fulfill({ json: { total: 0 } })
    const body = request.postData() ? request.postDataJSON() as Record<string, unknown> : {}
    calls.push({ method, path, body })
    const fulfill = (json: unknown, status = 200) => route.fulfill({ status, json })
    if (path === '/model-profiles' && method === 'GET') return fulfill(profiles)
    if (path === '/settings' && method === 'GET') return fulfill(settings)
    if (path === '/settings/check') return fulfill({ checks: [{ name: 'PostgreSQL', status: 'ok', detail: 'Mock connectivity only' }] })
    if (/^\/model-profiles\/[^/]+\/test$/.test(path) || /^\/settings\/test\//.test(path)) {
      if (rejectNextProbe) { rejectNextProbe = false; return fulfill({ detail: '测试服务暂时不可用，请检查配置。' }, 502) }
      return fulfill({ success: true, detail: '模拟连接验证通过', latency_ms: 12, usage: { total_tokens: 3 }, model: 'fixture', protocol: 'openai_chat' })
    }
    if (path === '/model-profiles' && method === 'POST') {
      const input = body as unknown as ModelProfileInput
      const { api_key, ...publicInput } = input
      if (input.is_default) profiles = profiles.map(profile => ({ ...profile, is_default: false }))
      const created: ModelProfile = { ...publicInput, id: '4', api_key_set: !!api_key, updated_at: `${stamp}-${++revision}` }
      profiles.push(created)
      return fulfill(created, 201)
    }
    if (/^\/model-profiles\/[^/]+$/.test(path)) {
      const id = path.split('/')[2]
      if (method === 'DELETE') { profiles = profiles.filter(profile => profile.id !== id); return route.fulfill({ status: 204 }) }
      if (method === 'PATCH') {
        if (rejectNextSave) { rejectNextSave = false; return fulfill({ detail: '无法保存模型配置，请重试。' }, 503) }
        const { api_key, ...publicInput } = body
        if (body.is_default) profiles = profiles.map(profile => ({ ...profile, is_default: false }))
        profiles = profiles.map(profile => profile.id === id ? { ...profile, ...publicInput, ...(api_key !== undefined ? { api_key_set: !!api_key } : {}), updated_at: `${stamp}-${++revision}` } : profile)
        return fulfill(profiles.find(profile => profile.id === id))
      }
    }
    if (path === '/settings' && method === 'PATCH') {
      for (const service of ['embedding', 'rerank', 'mineru', 'milvus'] as const) {
        if (!body[service]) continue
        const { api_key, ...publicInput } = body[service] as Record<string, unknown>
        settings = { ...settings, [service]: { ...settings[service], ...publicInput, ...(api_key !== undefined ? { configured: !!api_key } : {}) } }
      }
      return fulfill(settings)
    }
    if (path === '/knowledge-bases') return fulfill([{ id: 'kb-1', name: '测试知识库', description: '', ready_count: 1, document_count: 1, chunk_count: 2, chunk_size: 800, chunk_overlap: 100, embedding_model: 'test-embedding', version: 1, created_at: stamp }])
    if (path === '/conversations') return fulfill(method === 'POST' ? { id: 'conversation-1', title: String(body.title), knowledge_base_id: 'kb-1', created_at: stamp } : [{ id: 'conversation-1', title: '测试对话历史', knowledge_base_id: 'kb-1', created_at: stamp }])
    if (path === '/conversations/conversation-1/messages') {
      if (method === 'POST') {
        const profile = profiles.find(item => item.id === body.model_profile_id)!
        const common = { conversation_id: 'conversation-1', status: 'completed', stage: 'completed', error: null, method: 'hybrid_rerank' as const, timing: { generation_ms: 12 }, usage: { total_tokens: 3 }, contexts: [], citations: [], created_at: stamp }
        messages.push({ ...common, id: 'user-1', role: 'user', content: String(body.content) }, { ...common, id: 'assistant-1', role: 'assistant', content: '这是隔离测试中的模拟回答。', model_profile_id: profile.id, model_snapshot: { id: profile.id, name: profile.name, model: profile.model, protocol: profile.protocol } })
        return fulfill(messages.at(-1))
      }
      return fulfill(messages)
    }
    unexpected.push(`${method} ${path}`)
    return fulfill({ detail: `Unmocked API: ${method} ${path}` }, 404)
  })
  return { calls, unexpected, failSave: () => { rejectNextSave = true }, failProbe: () => { rejectNextProbe = true } }
}
async function choose(page: Page, label: string, option: string): Promise<void> {
  await page.getByRole('combobox', { name: label, exact: true }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}
const changes = (calls: Call[], path: string) => calls.filter(call => call.method === 'PATCH' && call.path === path)
const probes = (calls: Call[]) => calls.filter(call => call.path.includes('/test'))

test('create and edit all protocols; retain, replace, and explicitly clear write-only keys', async ({ page }) => {
  const mock = await mockApi(page)
  await page.goto('/settings')
  await page.getByRole('button', { name: '添加模型', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: '添加模型', exact: true })
  await dialog.getByLabel('显示名称').fill('新建测试模型')
  await dialog.getByLabel('服务地址').fill('https://created.example.test/v1')
  await dialog.getByLabel('模型 ID').fill('fixture-model')
  await dialog.getByLabel('API Key', { exact: true }).fill('fixture-only-not-a-real-key')
  const maxTokens = dialog.getByLabel('最大输出 tokens')
  const timeout = dialog.getByLabel('超时（秒）')
  await expect(maxTokens).toHaveAttribute('min', '16')
  await expect(maxTokens).toHaveAttribute('max', '65536')
  await expect(timeout).toHaveAttribute('min', '5')
  await expect(timeout).toHaveAttribute('max', '600')
  for (const [field, invalid, reset] of [[maxTokens, '15', '4096'], [maxTokens, '65537', '4096'], [timeout, '4', '120'], [timeout, '601', '120']] as const) {
    await field.fill(invalid)
    await dialog.getByRole('button', { name: '保存模型' }).click()
    expect(await field.evaluate(element => (element as HTMLInputElement).validity.valid)).toBe(false)
    expect(mock.calls.filter(call => call.method === 'POST' && call.path === '/model-profiles')).toHaveLength(0)
    await field.fill(reset)
  }
  await maxTokens.fill('16')
  await timeout.fill('600')
  await dialog.getByRole('button', { name: '保存模型' }).click()
  await expect(dialog).toBeHidden()
  const create = mock.calls.find(call => call.method === 'POST' && call.path === '/model-profiles')!
  expect(create.body).toMatchObject({ protocol: 'openai_chat', api_key: 'fixture-only-not-a-real-key', enabled: true, max_tokens: 16, timeout_seconds: 600 })
  const row = page.getByRole('article', { name: '新建测试模型', exact: true })
  await expect(row).toBeVisible()
  expect(probes(mock.calls)).toHaveLength(0)
  await row.getByRole('button', { name: '编辑', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '编辑模型', exact: true })
  await expect(dialog.getByLabel('API Key', { exact: true })).toHaveValue('')
  await expect(dialog.getByLabel('API Key', { exact: true })).toHaveAttribute('type', 'password')
  await expect(dialog.getByLabel('API Key', { exact: true })).toHaveAccessibleDescription('只写字段，不会回显；留空保留已保存的密钥。')
  await choose(page, 'API 协议', 'OpenAI Responses')
  await dialog.getByLabel('模型 ID').fill('fixture-responses')
  await dialog.getByRole('button', { name: '保存模型' }).click()
  await expect(dialog).toBeHidden()
  expect(changes(mock.calls, '/model-profiles/4').at(-1)?.body).toMatchObject({ protocol: 'openai_responses', model: 'fixture-responses' })
  expect(changes(mock.calls, '/model-profiles/4').at(-1)?.body).not.toHaveProperty('api_key')
  await row.getByRole('button', { name: '编辑', exact: true }).click()
  await choose(page, 'API 协议', 'Anthropic Messages')
  await expect(dialog.getByRole('checkbox', { name: '使用 JSON 输出模式' })).toHaveCount(0)
  await expect(dialog.getByText('当前 Anthropic 适配不使用原生 JSON 模式参数，通过提示词要求 JSON 输出并在本地校验。')).toBeVisible()
  await dialog.getByLabel('API Key', { exact: true }).fill('fixture-replacement-key')
  await dialog.getByRole('button', { name: '保存模型' }).click()
  await expect(dialog).toBeHidden()
  expect(changes(mock.calls, '/model-profiles/4').at(-1)?.body).toMatchObject({ protocol: 'anthropic', api_key: 'fixture-replacement-key' })
  await row.getByRole('button', { name: '编辑', exact: true }).click()
  await dialog.getByLabel('清除已保存的密钥').check()
  await expect(dialog.getByLabel('API Key', { exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: '保存模型' }).click()
  await expect(dialog).toBeHidden()
  expect(changes(mock.calls, '/model-profiles/4').at(-1)?.body.api_key).toBe('')
  await expect(row.getByText('已启用 · 未配置密钥')).toBeVisible()
  expect(probes(mock.calls)).toHaveLength(0)
  expect(mock.unexpected).toEqual([])
})

test('default, enable and delete model controls respect lifecycle constraints', async ({ page }) => {
  const mock = await mockApi(page)
  await page.goto('/settings')
  const defaultRow = page.getByRole('article', { name: '默认测试模型', exact: true })
  const backup = page.getByRole('article', { name: '备用测试模型', exact: true })
  await expect(defaultRow.getByRole('button', { name: '删除 默认测试模型' })).toBeDisabled()
  await backup.getByRole('button', { name: '设为默认' }).click()
  await expect(backup.getByText('默认', { exact: true })).toBeVisible()
  expect(changes(mock.calls, '/model-profiles/2').at(-1)?.body).toEqual({ is_default: true })
  await backup.getByRole('button', { name: '编辑', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '编辑模型' })
  await expect(dialog.getByRole('checkbox', { name: /^启用模型/ })).toBeDisabled()
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await defaultRow.getByRole('button', { name: '编辑', exact: true }).click()
  await dialog.getByRole('checkbox', { name: /^启用模型/ }).uncheck()
  await dialog.getByRole('button', { name: '保存模型' }).click()
  await expect(dialog).toBeHidden()
  await expect(defaultRow.getByText('已停用 · 密钥已保存')).toBeVisible()
  await expect(defaultRow.getByRole('button', { name: '设为默认' })).toBeDisabled()
  await defaultRow.getByRole('button', { name: '删除 默认测试模型' }).click()
  await page.getByRole('dialog', { name: '删除模型配置' }).getByRole('button', { name: '确认删除' }).click()
  await expect(defaultRow).toBeHidden()
  expect(mock.calls.some(call => call.method === 'DELETE' && call.path === '/model-profiles/1')).toBe(true)
  expect(mock.unexpected).toEqual([])
})

test('service edits save before testing; paid probes require a separate explicit confirmation', async ({ page }, testInfo) => {
  const mock = await mockApi(page)
  await page.goto('/settings')
  await page.locator('.service-editor > summary').filter({ hasText: 'Embedding' }).click()
  const embedding = page.getByRole('form', { name: 'Embedding 配置' })
  await expect(embedding.getByText(/可能使已有知识库索引不兼容/)).toBeVisible()
  await embedding.getByLabel('模型 ID').fill('new-fixture-embedding')
  await embedding.getByLabel('服务地址').fill('https://embedding-new.example.test/v1')
  await embedding.getByLabel('向量维度').fill('768')
  await expect(embedding.getByRole('button', { name: '测试模型' })).toBeDisabled()
  await embedding.getByRole('button', { name: '保存配置' }).click()
  await expect(embedding.getByRole('button', { name: '测试模型' })).toBeEnabled()
  const embeddingPatch = changes(mock.calls, '/settings').at(-1)?.body.embedding
  expect(embeddingPatch).toEqual({ model: 'new-fixture-embedding', base_url: 'https://embedding-new.example.test/v1', dimensions: 768 })
  await embedding.getByRole('button', { name: '测试模型' }).click()
  let confirmation = page.getByRole('dialog', { name: '确认模型测试' })
  await expect(confirmation.getByText(/^使用已保存的「Embedding」配置发送一次短请求，可能产生模型调用费用。/)).toBeVisible()
  expect(probes(mock.calls)).toHaveLength(0)
  await confirmation.getByRole('button', { name: '取消', exact: true }).click()
  expect(probes(mock.calls)).toHaveLength(0)
  await embedding.getByRole('button', { name: '测试模型' }).click()
  await confirmation.getByRole('button', { name: '确认并测试（可能计费）' }).click()
  await expect(embedding.getByText('模拟连接验证通过')).toBeVisible()
  expect(probes(mock.calls)).toEqual([expect.objectContaining({ path: '/settings/test/embedding', body: { confirm: true } })])
  await embedding.getByLabel('API Key', { exact: true }).fill('fixture-embedding-key')
  await embedding.getByRole('button', { name: '保存配置' }).click()
  await expect(embedding.getByLabel('API Key', { exact: true })).toHaveValue('')
  expect(changes(mock.calls, '/settings').at(-1)?.body.embedding).toHaveProperty('api_key', 'fixture-embedding-key')
  await embedding.getByLabel('清除已保存的密钥').check()
  await embedding.getByRole('button', { name: '保存配置' }).click()
  await expect(embedding.getByLabel('清除已保存的密钥')).not.toBeChecked()
  expect(changes(mock.calls, '/settings').at(-1)?.body.embedding).toHaveProperty('api_key', '')

  await page.locator('.service-editor > summary').filter({ hasText: 'Rerank' }).click()
  const rerank = page.getByRole('form', { name: 'Rerank 配置' })
  await rerank.getByLabel('模型 ID').fill('new-fixture-rerank')
  await choose(page, '重排序协议', 'Standard')
  await rerank.getByRole('button', { name: '保存配置' }).click()
  await expect(rerank.getByRole('button', { name: '保存配置' })).toBeDisabled()
  expect(changes(mock.calls, '/settings').at(-1)?.body.rerank).toMatchObject({ model: 'new-fixture-rerank', protocol: 'standard' })
  expect(changes(mock.calls, '/settings').at(-1)?.body.rerank).not.toHaveProperty('api_key')
  await rerank.getByRole('button', { name: '测试模型' }).click()
  confirmation = page.getByRole('dialog', { name: '确认模型测试' })
  expect(probes(mock.calls)).toHaveLength(1)
  await confirmation.getByRole('button', { name: '确认并测试（可能计费）' }).click()
  await expect(rerank.getByText('模拟连接验证通过')).toBeVisible()
  expect(probes(mock.calls).at(-1)).toMatchObject({ path: '/settings/test/rerank', body: { confirm: true } })

  await page.locator('.service-editor > summary').filter({ hasText: 'MinerU' }).click()
  const mineru = page.getByRole('form', { name: 'MinerU 配置' })
  await mineru.getByLabel('服务地址').fill('http://mineru-new.example.test:9000')
  await mineru.getByRole('button', { name: '保存配置' }).click()
  await expect(mineru.getByRole('button', { name: '测试连接' })).toBeEnabled()
  await mineru.getByRole('button', { name: '测试连接' }).click()
  await expect(mineru.getByText('模拟连接验证通过')).toBeVisible()
  expect(probes(mock.calls).at(-1)).toMatchObject({ path: '/settings/test/mineru', body: { confirm: false } })
  expect(changes(mock.calls, '/settings').at(-1)?.body).toEqual({ mineru: { base_url: 'http://mineru-new.example.test:9000' } })

  await page.locator('.service-editor > summary').filter({ hasText: 'Milvus' }).click()
  const milvus = page.getByRole('form', { name: 'Milvus 配置' })
  await milvus.getByLabel('连接 URI').fill('http://milvus-new.example.test:19530')
  await milvus.getByLabel('Collection').fill('rag_workbench_new_fixture')
  await milvus.getByRole('button', { name: '保存配置' }).click()
  await expect(milvus.getByRole('button', { name: '测试连接' })).toBeEnabled()
  expect(changes(mock.calls, '/settings').at(-1)?.body).toEqual({ milvus: { uri: 'http://milvus-new.example.test:19530', collection: 'rag_workbench_new_fixture' } })
  await milvus.getByRole('button', { name: '测试连接' }).click()
  await expect(milvus.getByText('模拟连接验证通过')).toBeVisible()
  const postgres = page.locator('section').filter({ has: page.getByRole('heading', { name: 'PostgreSQL', exact: true }) })
  await expect(postgres.getByText(/不支持在浏览器中热切换/)).toBeVisible()
  await expect(postgres.locator('input')).toHaveCount(0)
  await postgres.getByRole('button', { name: '测试连接' }).click()
  await expect(postgres.getByText('模拟连接验证通过')).toBeVisible()
  expect(probes(mock.calls).at(-1)).toMatchObject({ path: '/settings/test/postgres', body: { confirm: false } })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.screenshot({ path: testInfo.outputPath('settings-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('settings-mobile.png'), fullPage: true })
  expect(mock.unexpected).toEqual([])
})

test('model save and probe errors remain actionable and never auto-trigger a paid retry', async ({ page }) => {
  const mock = await mockApi(page)
  await page.goto('/settings')
  const row = page.getByRole('article', { name: '备用测试模型', exact: true })
  await row.getByRole('button', { name: '编辑', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '编辑模型' })
  await editor.getByLabel('模型 ID').fill('fixture-updated')
  mock.failSave()
  await editor.getByRole('button', { name: '保存模型' }).click()
  await expect(editor.getByRole('alert')).toContainText('无法保存模型配置')
  await expect(editor.getByLabel('模型 ID')).toHaveValue('fixture-updated')
  await editor.getByRole('button', { name: '保存模型' }).click()
  await expect(editor).toBeHidden()
  expect(probes(mock.calls)).toHaveLength(0)
  await row.getByRole('button', { name: '测试模型', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: '确认模型测试' })
  expect(probes(mock.calls)).toHaveLength(0)
  mock.failProbe()
  await confirmation.getByRole('button', { name: '确认并测试（可能计费）' }).click()
  await expect(confirmation.getByRole('alert')).toContainText('测试服务暂时不可用')
  expect(probes(mock.calls)).toHaveLength(1)
  await confirmation.getByRole('button', { name: '取消', exact: true }).click()
  await expect(row.getByRole('alert')).toContainText('测试服务暂时不可用')
  expect(probes(mock.calls)).toHaveLength(1)
  expect(mock.unexpected).toEqual([])
})

test('chat sends chosen enabled model ID from a keyboard chooser, preserving layout', async ({ page }, testInfo) => {
  const mock = await mockApi(page)
  await page.goto('/chat/conversation-1')
  const chooser = page.getByRole('combobox', { name: '选择对话模型' })
  await expect(chooser).toContainText('默认测试模型')
  await chooser.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('option', { name: '已停用测试模型' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(chooser).toBeFocused()
  await choose(page, '选择对话模型', '备用测试模型')
  await expect(chooser).toContainText('备用测试模型')
  expect(await chooser.evaluate(element => getComputedStyle(element).borderWidth)).toBe('1px')
  await expect(page.locator('.chat-heading-group').getByRole('combobox', { name: '选择知识库' })).toBeVisible()
  await expect(page.locator('.composer-footer').getByRole('combobox', { name: '选择对话模型' })).toBeVisible()
  await expect(page.locator('.primary-nav')).toBeVisible()
  await expect(page.locator('.rail-history')).toBeVisible()
  await page.getByLabel('输入问题').fill('仅用于隔离测试的问题')
  await page.getByRole('button', { name: '发送问题' }).click()
  await expect(page.getByText('这是隔离测试中的模拟回答。')).toBeVisible()
  const send = mock.calls.find(call => call.method === 'POST' && call.path.endsWith('/messages'))!
  expect(send.body).toMatchObject({ model_profile_id: '2', content: '仅用于隔离测试的问题' })
  expect(send.body).not.toHaveProperty('base_url')
  expect(send.body).not.toHaveProperty('api_key')
  expect(probes(mock.calls)).toHaveLength(0)
  await expect(page.locator('.message-user .user-content')).toHaveCSS('background-color', 'rgb(228, 237, 255)')
  await expect(page.locator('.assistant-bubble')).toHaveCSS('background-color', 'rgb(245, 246, 249)')
  await expect(page.getByLabel('引用来源，0 条')).toBeVisible()
  const debug = page.locator('.message-assistant .debug-details')
  await expect(debug.getByText('本轮模型：备用测试模型', { exact: true })).toBeHidden()
  await debug.locator('summary').click()
  await expect(debug.getByText('本轮模型：备用测试模型', { exact: true })).toBeVisible()
  await expect(debug.getByText('模型 ID：test-model-2', { exact: true })).toBeVisible()
  await expect(debug.getByText('协议：openai_chat', { exact: true })).toBeVisible()
  await choose(page, '选择对话模型', '默认测试模型')
  await expect(debug.getByText('本轮模型：备用测试模型', { exact: true })).toBeVisible()
  await debug.locator('summary').click()
  await expect(debug.getByText('本轮模型：备用测试模型', { exact: true })).toBeHidden()
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.screenshot({ path: testInfo.outputPath('chat-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('chat-mobile.png'), fullPage: true })
  expect(mock.unexpected).toEqual([])
})

test('model dropdown keeps long names on a single line without viewport overflow', async ({ page }) => {
  const mock = await mockApi(page)
  const name = 'deepseek-v4-flash-0731'
  const extraLongName = `${name}-${'long-model-name-'.repeat(8)}`
  await page.route('**/api/model-profiles', route => route.fulfill({ json: [profileFixture('1', name, true), profileFixture('2', extraLongName)] }))
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 })
    await page.goto('/chat')
    const chooser = page.getByRole('combobox', { name: '选择对话模型' })
    await expect(chooser).toContainText(name)
    await chooser.click()
    for (const label of [name, extraLongName]) {
      const option = page.getByRole('option', { name: label, exact: true })
      const text = option.locator(':scope > span:last-child')
      await expect(text).toHaveCSS('white-space', 'nowrap')
      const dimensions = await text.evaluate(element => ({ height: element.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(element).lineHeight), visible: element.clientWidth, full: element.scrollWidth }))
      expect(dimensions.height).toBeLessThanOrEqual(dimensions.lineHeight + 1)
      if (label === name) expect(dimensions.full).toBeLessThanOrEqual(dimensions.visible + 1)
      else expect(dimensions.full).toBeGreaterThan(dimensions.visible)
    }
    const menu = await page.getByRole('listbox').boundingBox()
    expect(menu!.x).toBeGreaterThanOrEqual(0)
    expect(menu!.x + menu!.width).toBeLessThanOrEqual(width)
    await page.getByRole('option', { name, exact: true }).click()
    await expect(chooser).toContainText(name)
    await expect(page.getByRole('listbox')).toBeHidden()
  }
  expect(probes(mock.calls)).toHaveLength(0)
  expect(mock.unexpected).toEqual([])
})
