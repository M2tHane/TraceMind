// Capture README screenshots from a running TraceMind filled by scripts/seed_demo.py.
//   node scripts/readme-screenshots.mjs   (reads demo passwords from ../data/demo-accounts.txt)
import { readFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'

const BASE = 'http://127.0.0.1:5174'
const OUT = resolve(import.meta.dirname, '../../docs/readme')
const passwords = Object.fromEntries((await readFile(resolve(import.meta.dirname, '../../data/demo-accounts.txt'), 'utf8'))
  .trim().split('\n').map(line => line.split('\t')))

const browser = await chromium.launch({ channel: 'chrome' })
await mkdir(OUT, { recursive: true })

async function session(username) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'zh-CN' })
  const page = await context.newPage()
  const login = await page.request.post(`${BASE}/api/auth/login`, { data: { username, password: passwords[username] } })
  if (!login.ok()) throw new Error(`${username}: ${await login.text()}`)
  const api = async path => (await page.request.get(`${BASE}/api${path}`)).json()
  return { page, api, context }
}

async function shot(page, name, { full = false } = {}) {
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(600)
  await page.screenshot({ path: resolve(OUT, `${name}.png`), fullPage: full })
  console.log('saved', name)
}

// Signed out: login page.
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'zh-CN' })
  const page = await context.newPage()
  await page.goto(`${BASE}/`)
  await page.locator('form[aria-label="登录表单"]').waitFor()
  await shot(page, 'login')
  await context.close()
}

// Employee 李娜: chat with citations and recall trace, libraries, memory, account.
{
  const { page, api, context } = await session('lina')
  const conversations = await api('/conversations')
  const leave = conversations.find(item => item.title.includes('年假'))
  await page.goto(`${BASE}/chat/${leave.id}`)
  await page.locator('.message-assistant .markdown').first().waitFor()
  await page.locator('.evidence-card').first().waitFor()
  await shot(page, 'chat')
  await page.getByRole('tab', { name: '召回链路' }).click()
  await page.locator('.trace-stage').first().waitFor()
  await shot(page, 'trace')
  await page.goto(`${BASE}/knowledge`)
  await shot(page, 'knowledge')
  const handbook = (await api('/knowledge-bases')).find(kb => kb.name === '员工手册')
  await page.goto(`${BASE}/knowledge/${handbook.id}`)
  await shot(page, 'upload-review')
  await page.goto(`${BASE}/memory`)
  await shot(page, 'memory')
  await page.goto(`${BASE}/account/tokens`)
  await shot(page, 'account')
  await context.close()
}

// Administrator 张伟: approvals, accounts, logs, documents, evaluation and tuning.
{
  const { page, api, context } = await session('zhangwei')
  for (const [path, name] of [['/admin/reviews', 'reviews'], ['/admin/users', 'users'], ['/admin/query-logs', 'query-logs'], ['/admin/mcp-logs', 'mcp-logs']]) {
    await page.goto(`${BASE}${path}`)
    await shot(page, name)
  }
  const papers = (await api('/knowledge-bases')).find(kb => kb.name === '论文精读库')
  const docs = await api(`/knowledge-bases/${papers.id}/documents`)
  const lora = docs.find(doc => doc.filename === 'lora.pdf')
  await page.goto(`${BASE}/knowledge/${papers.id}/documents/${lora.id}`)
  await page.locator('.document-original .pdf-viewer[data-pdf-state="ready"]').waitFor({ timeout: 30000 })
  await page.getByRole('tab', { name: /^分块/ }).click()
  await shot(page, 'document')
  const tuning = (await api('/tuning-runs')).find(run => run.knowledge_base_id === papers.id)
  await page.goto(`${BASE}/evaluation/tuning/${tuning.id}`)
  await shot(page, 'tuning')
  const run = (await api('/runs')).find(item => item.knowledge_base_id === papers.id)
  await page.goto(`${BASE}/evaluation/runs/${run.id}`)
  await shot(page, 'evaluation')
  await context.close()
}
await browser.close()
