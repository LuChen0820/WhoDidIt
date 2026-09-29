import { defineConfig } from '@playwright/test'

const PORT = Number(process.env.E2E_PORT ?? 8090)

export default defineConfig({
  testDir: './e2e',
  // 内存库在整个 server 进程内共享，测试之间用唯一组名隔离，故串行跑最稳
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'off', video: 'off' },
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
