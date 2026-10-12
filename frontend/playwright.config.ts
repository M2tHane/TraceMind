import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  timeout: 120000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: './.qa-results',
  use: { baseURL: 'http://127.0.0.1:5174', headless: true, channel: 'chrome', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
})
