import { open, migrate } from './db.ts'
import { buildApp } from './http/app.ts'

// 默认落盘持久化（真实使用）；显式 PGDATA=memory 时用内存库（测试用）
const db = await open(process.env.PGDATA === 'memory' ? undefined : (process.env.PGDATA ?? './.pgdata'))
await migrate(db)

const app = buildApp(db)
const port = Number(process.env.PORT ?? 8787)
await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' })
console.log(`谁在干活 API 已启动 → http://${process.env.HOST ?? '127.0.0.1'}:${port}`)
