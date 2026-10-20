import { defineConfig } from '@playwright/test'

const PORT = Number(process.env.E2E_PORT ?? 8090)

export default defineConfig({
  testDir: './e2e',
  // 内存库在整个 server 进程内共享，测试之间用唯一组名隔离，故串行跑最稳
  fullyParallel: false,
  workers: 1,
  reporter: [
    ['list'],
    // 失败时必须留下可下载的东西。只有 list 的话，CI 里除了 exit code 1 什么都看不到
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['junit', { outputFile: 'test-results/junit.xml' }],
  ],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Linux 容器里 Chromium 的用户命名空间沙箱经常起不来，是 CI 上的高频失败原因
    launchOptions: { chromiumSandbox: false },
  },
  webServer: {
    command: 'node src/server.ts',
    env: { PORT: String(PORT), PGDATA: 'memory' },
    url: `http://127.0.0.1:${PORT}/`,
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
