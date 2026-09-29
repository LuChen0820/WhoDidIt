import { randomBytes, createHash } from 'node:crypto'
import { q, type Db } from './db.ts'

export const COOKIE = 'wd_session'
const digest = (t: string) => createHash('sha256').update(t).digest('hex')

export type Principal = { userId: string; groupId: string; role: 'owner' | 'member' | 'auditor' }

export async function createSession(db: Db, userId: string, groupId: string) {
  const token = randomBytes(32).toString('base64url')
  await q(db, `insert into sessions(token_hash, user_id, group_id) values ($1,$2,$3)`, [
    digest(token),
    userId,
    groupId,
  ])
  return token
}

export async function resolveSession(db: Db, token?: string): Promise<Principal | null> {
  if (!token) return null
  const rows = await q<any>(
    db,
    `select s.user_id, s.group_id, m.role, m.active
       from sessions s
       join memberships m on m.group_id = s.group_id and m.user_id = s.user_id
      where s.token_hash = $1 and s.expires_at > now()`,
    [digest(token)]
  )
  if (rows.length === 0 || !rows[0].active) return null
  await q(db, `update sessions set last_seen = now() where token_hash = $1`, [digest(token)])
  return { userId: rows[0].user_id, groupId: rows[0].group_id, role: rows[0].role }
}

export async function destroySession(db: Db, token?: string) {
  if (token) await q(db, `delete from sessions where token_hash = $1`, [digest(token)])
}
