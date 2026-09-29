import { PGlite } from '@electric-sql/pglite'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIGRATION_DIR = path.join(HERE, '..', 'db', 'migrations')

export type Db = PGlite

/** 默认内存库（测试用）；传目录则持久化到磁盘 */
export function open(dataDir?: string): Db {
  return dataDir ? new PGlite(path.resolve(dataDir)) : new PGlite()
}

export async function migrate(db: Db): Promise<string[]> {
  await db.exec(
    `create table if not exists _migrations(
       name text primary key, applied_at timestamptz not null default now())`
  )
  const done = new Set(
    (await db.query<{ name: string }>('select name from _migrations')).rows.map((r) => r.name)
  )
  const files = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith('.sql')).sort()
  const applied: string[] = []
  for (const f of files) {
    if (done.has(f)) continue
    // `-- @split` 把文件切成多次执行。Postgres 不允许在同一个事务里
    // 「使用」刚 ALTER TYPE ADD VALUE 加进来的枚举值，逾期索引就撞上了这条。
    for (const chunk of (await readFile(path.join(MIGRATION_DIR, f), 'utf8')).split(/^\s*--\s*@split\s*$/m)) {
      if (chunk.trim()) await db.exec(chunk)
    }
    await db.query('insert into _migrations(name) values ($1)', [f])
    applied.push(f)
  }
  return applied
}

export async function q<T = Record<string, any>>(
  db: Db,
  sql: string,
  params: any[] = []
): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows
}

export async function one<T = Record<string, any>>(
  db: Db,
  sql: string,
  params: any[] = []
): Promise<T> {
  const rows = await q<T>(db, sql, params)
  if (rows.length !== 1) throw new Error(`expected 1 row, got ${rows.length}`)
  return rows[0]
}
