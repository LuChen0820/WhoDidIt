import { createHash } from 'node:crypto'
import { q, one, type Db } from './db.ts'

export class DomainError extends Error {}

/* ---------------------------------------------------------------- 事件写入 */

/**
 * 唯一的事件入口。actorId 必须由调用方（session 解析结果）给出，
 * 永远不要从请求体里取 —— 这条是整个可信体系的命门。
 */
export async function append(
  db: Db,
  ev: {
    groupId: string
    actorId: string
    taskId?: string | null
    meetingId?: string | null
    subjectId?: string | null
    type: string
    payload?: any
  }
) {
  await requireMember(db, ev.groupId, ev.actorId)
  const rows = await q<{ seq: string }>(
    db,
    `insert into events(group_id, actor_id, task_id, meeting_id, subject_id, type, payload)
     values ($1,$2,$3,$4,$5,$6::event_type,$7::jsonb) returning seq`,
    [
      ev.groupId,
      ev.actorId,
      ev.taskId ?? null,
      ev.meetingId ?? null,
      ev.subjectId ?? null,
      ev.type,
      JSON.stringify(ev.payload ?? {}),
    ]
  )
  return rows[0].seq
}

/** 只允许 http/https。组员提交的产出链接会渲染成 <a href>，
 *  不过滤协议就等于把 javascript: 执行权交给了提交者。 */
export function safeUrl(raw: unknown): string | null {
  const s = String(raw ?? '').trim()
  if (!s) return null
  return /^https?:\/\//i.test(s) ? s : null
}

export async function requireMember(db: Db, groupId: string, userId: string) {
  const m = await q(
    db,
    `select role, active from memberships where group_id=$1 and user_id=$2`,
    [groupId, userId]
  )
  if (m.length === 0) throw new DomainError(`用户 ${userId} 不属于该小组`)
  if (!(m[0] as any).active) throw new DomainError(`用户 ${userId} 已退出小组，不能写入痕迹`)
}

/* ---------------------------------------------------------------- 建组 */

export async function createGroup(
  db: Db,
  opts: { name: string; course?: string; ownerName: string; memberNames?: string[] }
) {
  const owner = await one<{ id: string }>(
    db,
    `insert into users(display_name) values ($1) returning id`,
    [opts.ownerName]
  )
  await q(db, `insert into user_identities(user_id, code_hash) values ($1,$2)`, [
    owner.id,
    hash(`${opts.ownerName}:${owner.id}`),
  ])
  const group = await one<{ id: string }>(
    db,
    `insert into groups(name, course, owner_id) values ($1,$2,$3) returning id`,
    [opts.name, opts.course ?? null, owner.id]
  )
  await q(db, `insert into memberships(group_id, user_id, role) values ($1,$2,'owner')`, [
    group.id,
    owner.id,
  ])
  await append(db, {
    groupId: group.id,
    actorId: owner.id,
    type: 'group_created',
    payload: { name: opts.name },
  })

  const members: Record<string, string> = { [opts.ownerName]: owner.id }
  for (const name of opts.memberNames ?? []) members[name] = await addMember(db, group.id, name)
  return { groupId: group.id, ownerId: owner.id, members }
}

/**
 * 消费一次性邀请链接 → 建用户并绑定身份。
 * 无密码设计下，「姓名 + 学号后四位」就是组长与组员之间的共享凭证：
 * 两者必须与邀请记录一致，否则链接落到别人手机上就等于身份被冒领。
 */
export async function acceptInvite(db: Db, token: string, claim: { name: string; code4: string }) {
  const inv = await q<any>(
    db,
    `select * from invites where token=$1 and used_at is null and expires_at > now()`,
    [token]
  )
  if (inv.length === 0) throw new DomainError('邀请链接无效、已使用或已过期')
  const i = inv[0]
  if (claim.name.trim() !== i.invitee_name || claim.code4 !== i.code4)
    throw new DomainError('姓名或学号后四位与邀请记录不符，无法加入')
  const userId = await addMember(db, i.group_id, i.invitee_name, i.role)
  await q(db, `update invites set used_at = now() where token=$1`, [token])
  return { groupId: i.group_id, userId }
}

async function addMember(db: Db, groupId: string, name: string, role = 'member') {
  const u = await one<{ id: string }>(db, `insert into users(display_name) values ($1) returning id`, [
    name,
  ])
  await q(db, `insert into user_identities(user_id, code_hash) values ($1,$2)`, [
    u.id,
    hash(`${name}:${u.id}`),
  ])
  await q(
    db,
    `insert into memberships(group_id, user_id, role) values ($1,$2,$3)
     on conflict (group_id, user_id) do nothing`,
    [groupId, u.id, role]
  )
  await append(db, { groupId, actorId: u.id, type: 'member_joined', payload: { name } })
  return u.id
}

export async function createInvite(db: Db, groupId: string, ownerId: string, name: string, code4: string) {
  if (!/^\d{4}$/.test(code4)) throw new DomainError('学号后四位必须是 4 位数字')
  const r = await one<{ token: string }>(
    db,
    `insert into invites(group_id, invitee_name, code4, created_by)
     values ($1,$2,$3,$4) returning token`,
    [groupId, name, code4, ownerId]
  )
  return r.token
}

/* ---------------------------------------------------------------- 任务 */

/** 只有组长能建任务并定分值。派活要组长权限而定价不要，等于把定价权发给想省钱的人。 */
export async function createTask(
  db: Db,
  actorId: string,
  opts: { groupId: string; title: string; points: number; parentId?: string | null; dueDate?: string | null }
) {
  await requireOwner(db, opts.groupId, actorId)
  const title = String(opts.title).trim()
  if (!title) throw new DomainError('任务标题不能为空')
  const t = await one<{ id: string }>(
    db,
    `insert into tasks(group_id, parent_id, title, points, due_date, created_by)
     values ($1,$2,$3,$4,$5,$6) returning id`,
    [opts.groupId, opts.parentId ?? null, title, opts.points, opts.dueDate ?? null, actorId]
  )
  await append(db, {
    groupId: opts.groupId,
    actorId,
    taskId: t.id,
    type: 'task_created',
    payload: { title, points: opts.points, parent: opts.parentId ?? null },
  })
  return t.id
}

export async function claimTask(db: Db, actorId: string, taskId: string) {
  const t = await task(db, taskId)
  if (t.assignee_id) throw new DomainError(`任务已被 ${t.assignee_id} 认领`)
  if (t.status !== 'todo') throw new DomainError(`任务当前是 ${t.status}，不能认领`)
  await q(db, `update tasks set assignee_id=$2, status='doing' where id=$1`, [taskId, actorId])
  await append(db, {
    groupId: t.group_id,
    actorId,
    taskId,
    type: 'claimed',
    payload: { title: t.title, points: Number(t.points) },
  })
}

/** 组长派活；被指派人可拒绝 */
export async function dispatchTask(db: Db, ownerId: string, taskId: string, toUserId: string) {
  const t = await task(db, taskId)
  await requireOwner(db, t.group_id, ownerId)
  if (t.assignee_id) throw new DomainError('该任务已有负责人')
  await q(db, `update tasks set assignee_id=$2, status='doing' where id=$1`, [taskId, toUserId])
  await append(db, {
    groupId: t.group_id,
    actorId: ownerId,
    taskId,
    type: 'dispatched',
    payload: { to: toUserId, points: Number(t.points) },
  })
}

export async function declineTask(db: Db, actorId: string, taskId: string, reason?: string) {
  const t = await task(db, taskId)
  if (t.assignee_id !== actorId) throw new DomainError('只有被指派人可以拒绝')
  await q(db, `update tasks set assignee_id=null, status='todo' where id=$1`, [taskId])
  await append(db, {
    groupId: t.group_id,
    actorId,
    taskId,
    type: 'declined',
    payload: { reason: reason ?? null },
  })
}

export async function submitTask(db: Db, actorId: string, taskId: string, links: string[] = []) {
  const t = await task(db, taskId)
  if (t.assignee_id !== actorId) throw new DomainError('只有负责人可以提交')
  if (t.status !== 'doing') throw new DomainError(`任务当前是 ${t.status}，不能提交`)
  const clean = links.map((l) => safeUrl(l)).filter((l): l is string => !!l)
  if (clean.length !== links.length)
    throw new DomainError('产出链接必须是 http/https 地址，不接受其他协议')
  await q(db, `update tasks set status='review' where id=$1`, [taskId])
  await append(db, {
    groupId: t.group_id,
    actorId,
    taskId,
    type: 'submitted',
    payload: { links: clean },
  })
}

/** 验收 —— 两条不变量在这里：不能自验自计，同一任务只记一次逾期 */
export async function acceptTask(db: Db, actorId: string, taskId: string) {
  const t = await task(db, taskId)
  if (!t.assignee_id) throw new DomainError('任务还没有负责人，无法验收')
  if (t.assignee_id === actorId)
    throw new DomainError('不能验收自己负责的任务：贡献分必须由他人的验收动作产生')
  if (t.status !== 'review') throw new DomainError(`任务当前是 ${t.status}，只有待验收的任务能验收`)
  await requireMember(db, t.group_id, actorId)

  await q(db, `update tasks set status='done' where id=$1`, [taskId])
  await append(db, {
    groupId: t.group_id,
    actorId,
    taskId,
    type: 'review_accepted',
    payload: { assignee: t.assignee_id, points: Number(t.points), title: t.title },
  })
  // 迟交天数在任务终结的这一刻成为事实，之后不再随「今天」变化
  const late = await daysLate(db, t.due_date)
  if (late > 0)
    await append(db, {
      groupId: t.group_id,
      actorId,
      taskId,
      type: 'overdue_recorded',
      payload: { days_late: late, due_date: String(t.due_date).slice(0, 10) },
    })
}

/** 驳回：产出不合格，退回负责人重做。
 *  没有这一步，「验收」就只有通过一条路，不合格的东西会永远挂在待验收。 */
export async function rejectTask(db: Db, actorId: string, taskId: string, reason: string) {
  const t = await task(db, taskId)
  if (!t.assignee_id) throw new DomainError('任务还没有负责人，无从驳回')
  if (t.assignee_id === actorId) throw new DomainError('不能驳回自己负责的任务')
  if (t.status !== 'review') throw new DomainError(`任务当前是 ${t.status}，只有待验收的任务能驳回`)
  const why = String(reason ?? '').trim()
  if (!why) throw new DomainError('驳回必须写明理由，否则等于凭空把人打回去')
  await requireMember(db, t.group_id, actorId)

  await q(db, `update tasks set status='doing' where id=$1`, [taskId])
  await append(db, {
    groupId: t.group_id,
    actorId,
    taskId,
    type: 'review_rejected',
    payload: { assignee: t.assignee_id, reason: why, points: Number(t.points) },
  })
}

/** 关闭一个已到期却始终没交付的任务：扣逾期分，但不给任何交付分 */
export async function closeOverdueTask(db: Db, actorId: string, taskId: string, reason?: string) {
  const t = await task(db, taskId)
  await requireOwner(db, t.group_id, actorId)
  if (t.status === 'done' || t.status === 'closed') throw new DomainError('这个任务已经结束了')
  if (!t.due_date) throw new DomainError('没有截止日期的任务不能按逾期关闭')
  const late = await daysLate(db, t.due_date)
  if (late <= 0) throw new DomainError('这个任务还没到期，不能按逾期关闭')
  if (!t.assignee_id) throw new DomainError('无人认领的任务没有可扣分的对象，请直接改派')

  await q(db, `update tasks set status='closed' where id=$1`, [taskId])
  await append(db, {
    groupId: t.group_id,
    actorId,
    taskId,
    type: 'overdue_recorded',
    payload: {
      days_late: late,
      due_date: String(t.due_date).slice(0, 10),
      closed: true,
      reason: reason ?? null,
    },
  })
}

/** 迟交自然日数。用数据库时钟 + 中国时区，避免客户端改表和服务器 UTC 偏差 */
async function daysLate(db: Db, dueDate: unknown): Promise<number> {
  if (!dueDate) return 0
  const r = await q<any>(
    db,
    `select greatest(0, ((now() at time zone 'Asia/Shanghai')::date - $1::date)) as d`,
    [dueDate]
  )
  return Number(r[0]?.d ?? 0)
}

/** 拆包：父任务转为汇总节点（不计分），子任务平分权重 */
export async function splitTask(db: Db, actorId: string, taskId: string, titles?: string[]) {
  const t = await task(db, taskId)
  await requireOwner(db, t.group_id, actorId)
  if (t.has_children) throw new DomainError('该任务已经拆过了')
  const parts = titles?.length ? titles : [`${t.title} · 上半`, `${t.title} · 下半`]
  const each = Math.round((t.points / parts.length) * 100) / 100
  const ids: string[] = []
  for (const title of parts) {
    ids.push(await createTask(db, actorId, { groupId: t.group_id, title, points: each, parentId: t.id }))
  }
  await q(db, `update tasks set status='closed', assignee_id=null where id=$1`, [taskId])
  await append(db, {
    groupId: t.group_id,
    actorId,
    taskId,
    type: 'split',
    payload: { parts: ids.length, each },
  })
  return ids
}

async function task(db: Db, id: string) {
  const rows = await q<any>(db, `select * from tasks where id=$1`, [id])
  if (rows.length === 0) throw new DomainError('任务不存在')
  return rows[0]
}

async function requireOwner(db: Db, groupId: string, userId: string) {
  const r = await q<any>(db, `select role from memberships where group_id=$1 and user_id=$2`, [
    groupId,
    userId,
  ])
  if (r.length === 0 || r[0].role !== 'owner') throw new DomainError('该动作只有组长可以执行')
}

/* ---------------------------------------------------------------- 出勤与仲裁 */

export async function createMeeting(
  db: Db,
  actorId: string,
  opts: { groupId: string; heldOn: string; note?: string }
) {
  await requireOwner(db, opts.groupId, actorId)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(opts.heldOn)))
    throw new DomainError('会议日期格式必须是 YYYY-MM-DD')
  try {
    const r = await one<{ id: string }>(
      db,
      `insert into meetings(group_id, held_on, note, created_by) values ($1,$2,$3,$4) returning id`,
      [opts.groupId, opts.heldOn, opts.note ?? null, actorId]
    )
    return r.id
  } catch (e: any) {
    if (/duplicate key/i.test(String(e?.message)))
      throw new DomainError('这一天已经记过会议了，一天只能有一场')
    throw e
  }
}

export async function listMeetings(db: Db, groupId: string) {
  return q<any>(
    db,
    `select m.id, m.held_on, m.note,
            (select count(*) from events e where e.meeting_id = m.id and e.type='checkin')::int as present,
            (select count(*) from events e where e.meeting_id = m.id and e.type='absence_recorded')::int as absent
       from meetings m where m.group_id=$1 order by m.held_on desc`,
    [groupId]
  )
}

export async function recordAttendance(
  db: Db,
  actorId: string,
  opts: { groupId: string; meetingId: string; targetUserId: string; kind: 'checkin' | 'absence_recorded' }
) {
  await requireOwner(db, opts.groupId, actorId)
  try {
    await append(db, {
      groupId: opts.groupId,
      actorId,
      meetingId: opts.meetingId,
      subjectId: opts.targetUserId,
      type: opts.kind,
      payload: {},
    })
  } catch (e: any) {
    if (/duplicate key|attendance_one_per/i.test(String(e?.message)))
      throw new DomainError('这场会议已经记录过 TA 的出勤了。要改账请走仲裁，改动会留下可审计的记录。')
    throw e
  }
}

/** 仲裁：原始痕迹一行不改，调整作为新事件追加 */
export async function decideDispute(
  db: Db,
  actorId: string,
  opts: { groupId: string; fromUserId: string; toUserId: string; delta: number; note?: string }
) {
  await requireOwner(db, opts.groupId, actorId)
  if (!(opts.delta > 0)) throw new DomainError('delta 必须是正数')
  await append(db, {
    groupId: opts.groupId,
    actorId,
    type: 'dispute_decided',
    payload: { from: opts.fromUserId, to: opts.toUserId, delta: opts.delta, note: opts.note ?? null },
  })
}

/* ---------------------------------------------------------------- 账本派生 */

const REBUILD = `
with leaf_accept as (
  select e.group_id, e.seq, t.assignee_id as user_id, t.points
  from events e join tasks t on t.id = e.task_id
  where e.type = 'review_accepted'
    and t.has_children = false
    and t.assignee_id is not null
    and e.actor_id <> t.assignee_id
    -- 同一任务只有第一次验收计分，重复验收不造分
    and not exists (
      select 1 from events e2
      where e2.task_id = e.task_id and e2.type = 'review_accepted' and e2.seq < e.seq)
),
delivered as (select group_id, user_id, sum(points) v from leaf_accept group by 1,2),
rb_week as (
  select group_id, actor_id as user_id,
         -- 按中国时区切周：服务器多为 UTC，直接切会把周日晚上交的活算进下一周
         date_trunc('week', server_time at time zone 'Asia/Shanghai') wk,
         count(*) * 0.5 v
  from events where type = 'review_accepted' group by 1,2,3
),
review_bonus as (select group_id, user_id, sum(least(v, 9.0)) v from rb_week group by 1,2),
attendance as (
  select group_id,
         subject_id as user_id,
         sum(case when type='checkin' then 0.5 when type='absence_recorded' then -1.5 else 0 end) v
  from events where type in ('checkin','absence_recorded') group by 1,2
),
overdue as (
  select e.group_id, t.assignee_id as user_id,
         sum(-0.5 * least(greatest((e.payload->>'days_late')::int, 1), 7)) v
  from events e join tasks t on t.id = e.task_id
  where e.type = 'overdue_recorded' and t.assignee_id is not null
  group by 1,2
),
adj_rows as (
  select group_id, (payload->>'to')::uuid as user_id, (payload->>'delta')::numeric as v
    from events where type='dispute_decided'
  union all
  select group_id, (payload->>'from')::uuid, -(payload->>'delta')::numeric
    from events where type='dispute_decided'
),
adjustment as (select group_id, user_id, sum(v) v from adj_rows group by 1,2)
insert into ledger(group_id, user_id, delivered, review_bonus, attendance, overdue, adjustment, points)
select m.group_id, m.user_id,
       coalesce(d.v,0), coalesce(r.v,0), coalesce(a.v,0), coalesce(o.v,0), coalesce(j.v,0),
       -- 验收奖不计入总分：组长既派活又验收，若计入等于让裁判同时当选手
       coalesce(d.v,0) + coalesce(a.v,0) + coalesce(o.v,0) + coalesce(j.v,0)
from memberships m
left join delivered      d on d.group_id = m.group_id and d.user_id = m.user_id
left join review_bonus   r on r.group_id = m.group_id and r.user_id = m.user_id
left join attendance     a on a.group_id = m.group_id and a.user_id = m.user_id
left join overdue        o on o.group_id = m.group_id and o.user_id = m.user_id
left join adjustment     j on j.group_id = m.group_id and j.user_id = m.user_id
where m.active and m.group_id = $1`

export async function computeLedger(db: Db, groupId: string) {
  await q(db, `delete from ledger where group_id=$1`, [groupId])
  await q(db, REBUILD, [groupId])
  return readLedger(db, groupId)
}

export type LedgerRow = {
  user_id: string
  delivered: number
  review_bonus: number
  attendance: number
  overdue: number
  adjustment: number
  points: number
  pct: number
}

export async function readLedger(db: Db, groupId: string): Promise<LedgerRow[]> {
  const rows = await q<any>(
    db,
    `select user_id, delivered, review_bonus, attendance, overdue, adjustment, points, pct
       from ledger_pct where group_id=$1 order by points desc`,
    [groupId]
  )
  return rows.map((r) => ({
    user_id: r.user_id,
    delivered: +r.delivered,
    review_bonus: +r.review_bonus,
    attendance: +r.attendance,
    overdue: +r.overdue,
    adjustment: +r.adjustment,
    points: +r.points,
    pct: +(+r.pct).toFixed(4),
  }))
}

/** 全量事件指纹：任何人可下载 CSV 自行重算比对 */
export async function eventsHash(db: Db, groupId: string) {
  const rows = await q<any>(
    db,
    `select seq, actor_id, coalesce(task_id::text,'') as task_id, type,
            server_time, payload::text as payload
       from events where group_id=$1 order by seq`,
    [groupId]
  )
  const canon = rows
    .map((r) =>
      [r.seq, r.actor_id, r.task_id, r.type, new Date(r.server_time).toISOString(), r.payload].join('|')
    )
    .join('\n')
  return { hash: createHash('sha256').update(canon).digest('hex'), count: rows.length }
}

export const hash = (s: string) => createHash('sha256').update(s).digest('hex')
