import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { COOKIE, createSession, resolveSession, destroySession, type Principal } from '../auth.ts'
import * as L from '../ledger.ts'
import { q, type Db } from '../db.ts'

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web')

/** PGlite 可能把 jsonb 交回字符串，统一成对象再取值 */
const jsonb = (v: any) => (typeof v === 'string' ? JSON.parse(v) : (v ?? {}))

export class HttpError extends Error {
  status: number
  constructor(status: number, msg: string) {
    super(msg)
    this.status = status
  }
}

const sessionCookie = (token: string) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 90}`

function cookieOf(req: any, name: string): string | undefined {
  const raw: string = req.headers.cookie ?? ''
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return undefined
}

export function buildApp(db: Db) {
  const app = Fastify({ logger: false })

  /** 身份只来自 session cookie。任何请求体里的 actorId / userId 字段一律不读。 */
  async function auth(req: any, groupId?: string): Promise<Principal> {
    const me = await resolveSession(db, cookieOf(req, COOKIE))
    if (!me) throw new HttpError(401, '未登录或登录已过期')
    if (groupId && groupId !== me.groupId) throw new HttpError(403, '你不属于这个小组')
    return me
  }

  async function groupOfTask(taskId: string) {
    const r = await q<any>(db, `select group_id from tasks where id=$1`, [taskId])
    if (r.length === 0) throw new HttpError(404, '任务不存在')
    return r[0].group_id
  }

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message })
    if (err instanceof L.DomainError) return reply.code(400).send({ error: err.message })
    console.error('[500] 未预期错误:', err)
    return reply.code(500).send({ error: '服务器内部错误' })
  })

  /* ---------------- 注册 / 登录 / 邀请 ---------------- */

  app.post('/api/groups', async (req, reply) => {
    const b: any = req.body ?? {}
    if (!b.name || !b.ownerName) throw new HttpError(400, '项目名称和组长姓名必填')
    const g = await L.createGroup(db, { name: b.name, course: b.course, ownerName: b.ownerName })
    const token = await createSession(db, g.ownerId, g.groupId)
    reply.header('set-cookie', sessionCookie(token))
    return { groupId: g.groupId, userId: g.ownerId, role: 'owner' }
  })

  app.post('/api/join', async (req, reply) => {
    const { token, name, code4 } = (req.body ?? {}) as any
    if (!token || !name || !code4) throw new HttpError(400, '邀请链接、姓名、学号后四位都必填')
    const r = await L.acceptInvite(db, token, { name, code4 })
    const sid = await createSession(db, r.userId, r.groupId)
    reply.header('set-cookie', sessionCookie(sid))
    return { groupId: r.groupId, userId: r.userId, role: 'member' }
  })

  app.get('/api/session', async (req) => {
    const me = await auth(req)
    const g = await q<any>(db, `select name, course from groups where id=$1`, [me.groupId])
    return { ...me, groupName: g[0]?.name, course: g[0]?.course }
  })

  app.post('/api/logout', async (req, reply) => {
    const t = cookieOf(req, COOKIE)
    await destroySession(db, t)
    reply.header('set-cookie', `${COOKIE}=; Path=/; Max-Age=0`)
    return { ok: true }
  })

  app.post('/api/invites', async (req) => {
    const me = await auth(req)
    const { name, code4 } = (req.body ?? {}) as any
    const token = await L.createInvite(db, me.groupId, me.userId, name, code4)
    return { token, url: `/join?token=${token}&name=${encodeURIComponent(name)}` }
  })

  /* ---------------- 看板数据 ---------------- */

  app.get('/api/board', async (req) => {
    const me = await auth(req)
    const members = await q<any>(
      db,
      `select m.user_id, u.display_name as name, m.role, m.active
         from memberships m join users u on u.id = m.user_id
        where m.group_id = $1 order by m.joined_at`,
      [me.groupId]
    )
    const tasks = await q<any>(
      db,
      `select id, parent_id, title, points::float8 as points, assignee_id, status, due_date, has_children,
              -- 未结束任务的逾期天数只是展示用的现值，不参与计分；
              -- 真正计入账本的逾期事实只在任务终结那一刻写一次
              case when t.status in ('todo','doing','review') and t.due_date is not null
                   then greatest(0, ((now() at time zone 'Asia/Shanghai')::date - t.due_date::date))
                   else null end::int as overdue_days,
              (select count(*) from events e where e.task_id = t.id)::int as evidence_count
         from tasks t where group_id = $1 order by created_at`,
      [me.groupId]
    )
    const ledger = await L.computeLedger(db, me.groupId)
    const meetings = await L.listMeetings(db, me.groupId)
    const nm = new Map(members.map((m) => [m.user_id, m.name]))
    const h = await L.eventsHash(db, me.groupId)
    return {
      me,
      meetings: meetings.map((m) => ({ ...m, held_on: String(m.held_on).slice(0, 10) })),
      members: members.map((m) => {
        const r = ledger.find((x) => x.user_id === m.user_id)
        return { ...m, points: r?.points ?? 0, pct: r?.pct ?? 0, delivered: r?.delivered ?? 0, attendance: r?.attendance ?? 0, overdue: r?.overdue ?? 0, adjustment: r?.adjustment ?? 0, review_bonus: r?.review_bonus ?? 0 }
      }),
      tasks: tasks.map((t) => ({ ...t, assignee_name: t.assignee_id ? nm.get(t.assignee_id) : null })),
      // 结算数据随看板一起返回：一次往返就够，前端不需要再打第二个请求
      ledger: { hash: h.hash, eventCount: h.count, rows: ledger.map((r) => ({ ...r, name: nm.get(r.user_id) })) },
    }
  })

  app.get('/api/tasks/:id/evidence', async (req) => {
    const groupId = await groupOfTask((req.params as any).id)
    await auth(req, groupId)
    const rows = await q<any>(
      db,
      `select e.seq, e.type, e.payload, e.server_time, u.display_name as actor
         from events e join users u on u.id = e.actor_id
        where e.task_id = $1 order by e.seq`,
      [(req.params as any).id]
    )
    return rows
  })

  /* ---------------- 任务生命周期 ---------------- */

  app.post('/api/tasks', async (req) => {
    const me = await auth(req)
    const b: any = req.body ?? {}
    if (!b.title) throw new HttpError(400, '任务标题必填')
    const points = Number(b.points)
    if (!(points > 0) || points > 20) throw new HttpError(400, '贡献分必须是 0–20 之间的正数')
    const id = await L.createTask(db, me.userId, {
      groupId: me.groupId,
      title: String(b.title).trim(),
      points,
      // 空字符串不是 null：表单留空必须归一成 null，否则 date 列会插入失败
      parentId: b.parentId || null,
      dueDate: b.dueDate || null,
    })
    if (b.assigneeId) await L.dispatchTask(db, me.userId, id, b.assigneeId)
    return { id }
  })

  // 注意：actorId 全部来自 me.userId（session），请求体里没有 actorId 这个入口
  app.post('/api/tasks/:id/claim', async (req) => {
    const me = await auth(req, await groupOfTask((req.params as any).id))
    await L.claimTask(db, me.userId, (req.params as any).id)
    return { ok: true }
  })

  app.post('/api/tasks/:id/dispatch', async (req) => {
    const me = await auth(req, await groupOfTask((req.params as any).id))
    const to = (req.body as any)?.toUserId
    if (!to) throw new HttpError(400, '缺少 toUserId')
    await L.dispatchTask(db, me.userId, (req.params as any).id, to)
    return { ok: true }
  })

  app.post('/api/tasks/:id/decline', async (req) => {
    const me = await auth(req, await groupOfTask((req.params as any).id))
    await L.declineTask(db, me.userId, (req.params as any).id, (req.body as any)?.reason)
    return { ok: true }
  })

  app.post('/api/tasks/:id/submit', async (req) => {
    const me = await auth(req, await groupOfTask((req.params as any).id))
    await L.submitTask(db, me.userId, (req.params as any).id, (req.body as any)?.links ?? [])
    return { ok: true }
  })

  app.post('/api/tasks/:id/accept', async (req) => {
    const me = await auth(req, await groupOfTask((req.params as any).id))
    await L.acceptTask(db, me.userId, (req.params as any).id)
    return { ok: true }
  })

  app.post('/api/tasks/:id/reject', async (req) => {
    const me = await auth(req, await groupOfTask((req.params as any).id))
    await L.rejectTask(db, me.userId, (req.params as any).id, (req.body as any)?.reason)
    return { ok: true }
  })

  app.post('/api/tasks/:id/close', async (req) => {
    const me = await auth(req, await groupOfTask((req.params as any).id))
    await L.closeOverdueTask(db, me.userId, (req.params as any).id, (req.body as any)?.reason)
    return { ok: true }
  })

  app.post('/api/tasks/:id/split', async (req) => {
    const me = await auth(req, await groupOfTask((req.params as any).id))
    const ids = await L.splitTask(db, me.userId, (req.params as any).id, (req.body as any)?.titles)
    return { ids }
  })

  /* ---------------- 出勤与仲裁 ---------------- */

  app.post('/api/meetings', async (req) => {
    const me = await auth(req)
    const b: any = req.body ?? {}
    const id = await L.createMeeting(db, me.userId, {
      groupId: me.groupId,
      heldOn: b.heldOn,
      note: b.note,
    })
    return { id }
  })

  app.post('/api/attendance', async (req) => {
    const me = await auth(req)
    const b: any = req.body ?? {}
    if (!b.meetingId) throw new HttpError(400, '出勤必须挂到一场具体的会议，否则可以反复刷分')
    const kind = b.kind === 'checkin' ? 'checkin' : 'absence_recorded'
    await L.recordAttendance(db, me.userId, {
      groupId: me.groupId,
      meetingId: b.meetingId,
      targetUserId: b.targetUserId,
      kind,
    })
    return { ok: true }
  })

  app.post('/api/disputes', async (req) => {
    const me = await auth(req)
    const b: any = req.body ?? {}
    await L.decideDispute(db, me.userId, {
      groupId: me.groupId,
      fromUserId: b.fromUserId,
      toUserId: b.toUserId,
      delta: Number(b.delta),
      note: b.note,
    })
    return { ok: true }
  })

  /* ---------------- 结算与导出 ---------------- */

  app.get('/api/ledger', async (req) => {
    const me = await auth(req)
    const ledger = await L.computeLedger(db, me.groupId)
    const names = await q<any>(
      db,
      `select m.user_id, u.display_name as name from memberships m join users u on u.id=m.user_id where m.group_id=$1`,
      [me.groupId]
    )
    const nm = new Map(names.map((r) => [r.user_id, r.name]))
    const h = await L.eventsHash(db, me.groupId)
    return {
      hash: h.hash,
      eventCount: h.count,
      rows: ledger.map((r) => ({ ...r, name: nm.get(r.user_id) })),
    }
  })

  app.get('/api/export/events.csv', async (req, reply) => {
    const me = await auth(req)
    const rows = await q<any>(
      db,
      `select e.seq, e.server_time, u.display_name as actor, e.type,
              coalesce(t.title,'') as task, e.payload::text as payload
         from events e
         join users u on u.id = e.actor_id
         left join tasks t on t.id = e.task_id
        where e.group_id = $1 order by e.seq`,
      [me.groupId]
    )
    const h = await L.eventsHash(db, me.groupId)
    const esc = (s: any) => `"${String(s ?? '').replaceAll('"', '""')}"`
    const body = [
      `# ledger_hash=${h.hash}`,
      `# 校验方法：按 seq 升序拼接 seq|actor|task|type|server_time|payload 后取 sha256`,
      'seq,server_time,actor,type,task,payload',
      ...rows.map((r) =>
        [r.seq, new Date(r.server_time).toISOString(), esc(r.actor), r.type, esc(r.task), esc(r.payload)].join(',')
      ),
    ].join('\n')
    reply.header('content-type', 'text/csv; charset=utf-8')
    reply.header('content-disposition', `attachment; filename="events-${me.groupId.slice(0, 8)}.csv"`)
    return body
  })

  app.get('/api/export/report.txt', async (req) => {
    const me = await auth(req)
    const led = await L.computeLedger(db, me.groupId)
    const names = await q<any>(
      db,
      `select m.user_id, u.display_name as name from memberships m join users u on u.id=m.user_id where m.group_id=$1`,
      [me.groupId]
    )
    const nm = new Map(names.map((r) => [r.user_id, r.name]))
    const h = await L.eventsHash(db, me.groupId)
    const disputes = await q<any>(
      db,
      `select e.server_time, e.payload from events e where e.group_id=$1 and e.type='dispute_decided' order by e.seq`,
      [me.groupId]
    )
    const g = await q<any>(db, `select name from groups where id=$1`, [me.groupId])
    return [
      `致 任课教师：`,
      ``,
      `小组《${g[0]?.name}》，共 ${led.length} 人，可追溯协作痕迹 ${h.count} 条。`,
      `贡献占比依据客观事实自动计算：任务交付与验收结果、例会签到与逾期记录。`,
      `不设自评与互评环节，避免人情分；验收他人产出的动作单独统计但不计入排名。`,
      ``,
      `结算结果：`,
      ...led.map((r) => `  ${nm.get(r.user_id)}  ${r.pct > 0 ? r.pct.toFixed(1) + '%' : '—'}  （交付 ${r.delivered}，出勤 ${r.attendance}，逾期 ${r.overdue}，仲裁 ${r.adjustment}，合计 ${r.points}）`),
      ``,
      disputes.length
        ? `归属异议记录：\n${disputes
            .map((d) => `  ${new Date(d.server_time).toISOString().slice(0, 16)}  ${jsonb(d.payload).note ?? ''}`)
            .join('\n')}`
        : `本期无归属异议。`,
      ``,
      `事件流指纹 ledger_hash = ${h.hash}`,
      `导出 events.csv 后可自行重算该指纹，以证明本结算单事后未被修改。`,
    ].join('\n')
  })

  /* ---------------- 前端（零构建单页应用）---------------- */
  app.register(fastifyStatic, { root: WEB_DIR, index: false, wildcard: false })
  app.get('/', (_req, reply) => reply.sendFile('index.html'))
  app.get('/join', (_req, reply) => reply.sendFile('index.html'))

  return app
}
