import test from 'node:test'
import assert from 'node:assert/strict'
import { open, migrate, q } from '../src/db.ts'
import { buildApp } from '../src/http/app.ts'
import { COOKIE } from '../src/auth.ts'

async function client() {
  const db = await open()
  await migrate(db)
  const app = buildApp(db)
  await app.ready()

  const call = async (method: string, url: string, opts: any = {}) => {
    const res = await app.inject({
      method,
      url,
      payload: opts.payload,
      headers: opts.cookie ? { cookie: `${COOKIE}=${opts.cookie}` } : {},
    })
    let body: any = res.body
    try {
      body = res.json()
    } catch {}
    return { status: res.statusCode, body, cookie: sessionOf(res) }
  }
  return { db, call }
}

function sessionOf(res: any): string | undefined {
  const raw = res.headers['set-cookie']
  if (!raw) return undefined
  const c = Array.isArray(raw) ? raw[0] : String(raw)
  const m = /wd_session=([^;]+)/.exec(c)
  return m?.[1]
}

async function newGroup(ownerName = '陈昊') {
  const { db, call } = await client()
  const r = await call('POST', '/api/groups', { payload: { name: '校园二手书平台', ownerName } })
  return { db, call, cookie: r.cookie!, groupId: r.body.groupId, ownerId: r.body.userId }
}

async function inviteAndJoin(ctx: any, name: string, code4 = '1234') {
  const inv = await ctx.call('POST', '/api/invites', {
    cookie: ctx.cookie,
    payload: { name, code4 },
  })
  assert.equal(inv.status, 200, JSON.stringify(inv.body))
  const join = await ctx.call('POST', '/api/join', { payload: { token: inv.body.token, name, code4 } })
  assert.equal(join.status, 200, JSON.stringify(join.body))
  return { cookie: join.cookie!, userId: join.body.userId }
}

/* ---------------- 身份 ---------------- */

test('建组即拿到 session，/api/session 能认出自己', async () => {
  const ctx = await newGroup()
  const r = await ctx.call('GET', '/api/session', { cookie: ctx.cookie })
  assert.equal(r.status, 200)
  assert.equal(r.body.role, 'owner')
  assert.equal(r.body.groupName, '校园二手书平台')
})

test('未登录访问受保护接口返回 401', async () => {
  const { call } = await client()
  const r = await call('GET', '/api/board')
  assert.equal(r.status, 401)
})

test('邀请链接要求姓名与学号后四位都对得上', async () => {
  const ctx = await newGroup()
  const inv = await ctx.call('POST', '/api/invites', {
    cookie: ctx.cookie,
    payload: { name: '林嘉', code4: '1234' },
  })
  const wrong = await ctx.call('POST', '/api/join', {
    payload: { token: inv.body.token, name: '林嘉', code4: '9999' },
  })
  assert.equal(wrong.status, 400)
  assert.match(wrong.body.error, /学号/)

  const right = await ctx.call('POST', '/api/join', {
    payload: { token: inv.body.token, name: '林嘉', code4: '1234' },
  })
  assert.equal(right.status, 200)

  const reused = await ctx.call('POST', '/api/join', {
    payload: { token: inv.body.token, name: '林嘉', code4: '1234' },
  })
  assert.equal(reused.status, 400, '一次性链接用过即废')
})

/** 同一个库里建两个组，用来验证组间隔离 */
async function twoGroups() {
  const { db, call } = await client()
  const a = await call('POST', '/api/groups', { payload: { name: 'A 组项目', ownerName: '陈昊' } })
  const b = await call('POST', '/api/groups', { payload: { name: 'B 组项目', ownerName: '王老师' } })
  return {
    db,
    call,
    a: { cookie: a.cookie!, groupId: a.body.groupId, userId: a.body.userId },
    b: { cookie: b.cookie!, groupId: b.body.groupId, userId: b.body.userId },
  }
}

test('两个组互不可见：B 组动不了 A 组的任务', async () => {
  const c = await twoGroups()
  const t = await c.call('POST', '/api/tasks', {
    cookie: c.a.cookie,
    payload: { title: 'A 组的任务', points: 2 },
  })
  assert.equal(t.status, 200)

  const accept = await c.call('POST', `/api/tasks/${t.body.id}/accept`, { cookie: c.b.cookie })
  assert.equal(accept.status, 403, '跨组改数据必须被拒绝')

  const evidence = await c.call('GET', `/api/tasks/${t.body.id}/evidence`, { cookie: c.b.cookie })
  assert.equal(evidence.status, 403, '跨组连痕迹都看不到')

  const board = await c.call('GET', '/api/board', { cookie: c.b.cookie })
  assert.equal(board.status, 200)
  assert.equal(board.body.tasks.length, 0, 'B 组看板里不该出现 A 组的任务')
})

/* ---------------- 命门：身份不可伪造 ---------------- */

test('请求体里塞 actorId 无效，事件只记在 session 持有者名下', async () => {
  const ctx = await newGroup()
  const lin = await inviteAndJoin(ctx, '林嘉')
  const t = await ctx.call('POST', '/api/tasks', {
    cookie: ctx.cookie,
    payload: { title: '需求访谈', points: 3, assigneeId: lin.userId },
  })
  assert.equal(t.status, 200, JSON.stringify(t.body))

  // 林嘉提交，但谎称 actorId 是组长
  const s = await ctx.call('POST', `/api/tasks/${t.body.id}/submit`, {
    cookie: lin.cookie,
    payload: { links: ['https://example.com/1'], actorId: ctx.ownerId },
  })
  assert.equal(s.status, 200, JSON.stringify(s.body))

  // 组长验收，但谎称 actorId 是林嘉
  const a = await ctx.call('POST', `/api/tasks/${t.body.id}/accept`, {
    cookie: ctx.cookie,
    payload: { actorId: lin.userId },
  })
  assert.equal(a.status, 200)

  const evs = await q<any>(
    ctx.db,
    `select type, actor_id from events where task_id=$1 order by seq`,
    [t.body.id]
  )
  const byType = Object.fromEntries(evs.map((e: any) => [e.type, e.actor_id]))
  assert.equal(byType['submitted'], lin.userId, '提交事件记在真正提交的人名下')
  assert.equal(byType['review_accepted'], ctx.ownerId, '验收事件记在组长名下，不是请求体声称的林嘉')
})

test('组员不能自己建任务定分值', async () => {
  const ctx = await newGroup()
  const lin = await inviteAndJoin(ctx, '林嘉')
  const r = await ctx.call('POST', '/api/tasks', {
    cookie: lin.cookie,
    payload: { title: '给自己准备的活', points: 20 },
  })
  assert.equal(r.status, 400)
  assert.match(r.body.error, /只有组长/)
})

test('javascript: 链接在接口层就被拒', async () => {
  const ctx = await newGroup()
  const lin = await inviteAndJoin(ctx, '林嘉')
  const t = await ctx.call('POST', '/api/tasks', {
    cookie: ctx.cookie,
    payload: { title: '搜索页', points: 3, assigneeId: lin.userId },
  })
  const r = await ctx.call('POST', `/api/tasks/${t.body.id}/submit`, {
    cookie: lin.cookie,
    payload: { links: ['javascript:alert(document.cookie)'] },
  })
  assert.equal(r.status, 400)
  assert.match(r.body.error, /http\/https/)
})

test('组员不能替别人验收，也不能自验自计', async () => {
  const ctx = await newGroup()
  const lin = await inviteAndJoin(ctx, '林嘉')
  const t = await ctx.call('POST', '/api/tasks', {
    cookie: ctx.cookie,
    payload: { title: '搜索页', points: 3, assigneeId: lin.userId },
  })
  await ctx.call('POST', `/api/tasks/${t.body.id}/submit`, { cookie: lin.cookie, payload: {} })

  const self = await ctx.call('POST', `/api/tasks/${t.body.id}/accept`, { cookie: lin.cookie })
  assert.equal(self.status, 400)
  assert.match(self.body.error, /不能验收自己负责的任务/)

  const ok = await ctx.call('POST', `/api/tasks/${t.body.id}/accept`, { cookie: ctx.cookie })
  assert.equal(ok.status, 200)
})

/* ---------------- 端到端闭环 ---------------- */

test('完整走一遍：建组 → 邀请 → 派活 → 提交 → 验收 → 结算', async () => {
  const ctx = await newGroup()
  const lin = await inviteAndJoin(ctx, '林嘉')
  const wang = await inviteAndJoin(ctx, '王磊')

  for (const [who, title, pts] of [
    [lin, '需求访谈', 3],
    [lin, '搜索页', 4],
    [wang, '库存表', 2],
  ] as const) {
    const t = await ctx.call('POST', '/api/tasks', {
      cookie: ctx.cookie,
      payload: { title, points: pts, assigneeId: who.userId },
    })
    const s = await ctx.call('POST', `/api/tasks/${t.body.id}/submit`, {
      cookie: who.cookie,
      payload: { links: ['https://example.com/' + title] },
    })
    assert.equal(s.status, 200, JSON.stringify(s.body))
    const a = await ctx.call('POST', `/api/tasks/${t.body.id}/accept`, { cookie: ctx.cookie })
    assert.equal(a.status, 200, JSON.stringify(a.body))
  }

  const m = await ctx.call('POST', '/api/meetings', {
    cookie: ctx.cookie,
    payload: { heldOn: '2026-09-20', note: '第 7 周例会' },
  })
  assert.equal(m.status, 200, JSON.stringify(m.body))
  const att = await ctx.call('POST', '/api/attendance', {
    cookie: ctx.cookie,
    payload: { meetingId: m.body.id, targetUserId: wang.userId, kind: 'absence_recorded' },
  })
  assert.equal(att.status, 200, JSON.stringify(att.body))

  const led = await ctx.call('GET', '/api/ledger', { cookie: ctx.cookie })
  assert.equal(led.status, 200)
  const row = (n: string) => led.body.rows.find((r: any) => r.name === n)

  assert.equal(row('林嘉').points, 7)
  assert.equal(row('王磊').points, 0.5, '交付 2 − 缺席 1.5')
  assert.equal(row('陈昊').points, 0, '组长验收 3 次，验收奖不计入总分')
  assert.equal(row('陈昊').review_bonus, 1.5, '但动作仍然被记录并可展示')

  const sum = led.body.rows.reduce((s: number, r: any) => s + r.pct, 0)
  assert.equal(Math.round(sum * 10) / 10, 100)
})

test('仲裁后事件流指纹变化，但 CSV 与接口给出的指纹一致', async () => {
  const ctx = await newGroup()
  const lin = await inviteAndJoin(ctx, '林嘉')
  const wang = await inviteAndJoin(ctx, '王磊')

  const t = await ctx.call('POST', '/api/tasks', {
    cookie: ctx.cookie,
    payload: { title: '订单联调', points: 3.2, assigneeId: lin.userId },
  })
  await ctx.call('POST', `/api/tasks/${t.body.id}/submit`, { cookie: lin.cookie, payload: {} })
  await ctx.call('POST', `/api/tasks/${t.body.id}/accept`, { cookie: ctx.cookie })

  const before = await ctx.call('GET', '/api/ledger', { cookie: ctx.cookie })

  const d = await ctx.call('POST', '/api/disputes', {
    cookie: ctx.cookie,
    payload: { fromUserId: lin.userId, toUserId: wang.userId, delta: 3.2, note: '实际执行人为王磊' },
  })
  assert.equal(d.status, 200, JSON.stringify(d.body))

  const after = await ctx.call('GET', '/api/ledger', { cookie: ctx.cookie })
  assert.notEqual(before.body.hash, after.body.hash)
  assert.equal(after.body.eventCount, before.body.eventCount + 1, '仲裁是追加，不是改写')
  // 林嘉原本被误记的 3.2 分被转走，净值归零而不是变成负数
  assert.equal(after.body.rows.find((r: any) => r.name === '王磊').points, 3.2)
  assert.equal(after.body.rows.find((r: any) => r.name === '林嘉').points, 0)
  assert.equal(after.body.rows.find((r: any) => r.name === '林嘉').adjustment, -3.2)
  assert.equal(after.body.rows.find((r: any) => r.name === '王磊').pct, 100)

  const csv = await ctx.call('GET', '/api/export/events.csv', { cookie: ctx.cookie })
  assert.equal(csv.status, 200)
  assert.ok(
    (csv.body as string).includes(`ledger_hash=${after.body.hash}`),
    'CSV 头部必须带上与接口一致的指纹'
  )

  const rep = await ctx.call('GET', '/api/export/report.txt', { cookie: ctx.cookie })
  assert.ok((rep.body as string).includes('归属异议记录'))
  assert.ok((rep.body as string).includes('实际执行人为王磊'))
})

test('表单留空的截止日期不会让服务端崩掉', async () => {
  const ctx = await newGroup()
  const r = await ctx.call('POST', '/api/tasks', {
    cookie: ctx.cookie,
    payload: { title: '空日期任务', points: 2, dueDate: '', parentId: '', assigneeId: '' },
  })
  assert.equal(r.status, 200, JSON.stringify(r.body))
})

test('贡献分越界被拒', async () => {
  const ctx = await newGroup()
  const bad = await ctx.call('POST', '/api/tasks', { cookie: ctx.cookie, payload: { title: 'x', points: 0 } })
  assert.equal(bad.status, 400)
  const tooBig = await ctx.call('POST', '/api/tasks', { cookie: ctx.cookie, payload: { title: 'x', points: 99 } })
  assert.equal(tooBig.status, 400)
})

test('组员不能派活、不能裁决、不能记勤', async () => {
  const ctx = await newGroup()
  const lin = await inviteAndJoin(ctx, '林嘉')
  const wang = await inviteAndJoin(ctx, '王磊')
  const t = await ctx.call('POST', '/api/tasks', {
    cookie: ctx.cookie,
    payload: { title: '待定', points: 1 },
  })

  const d = await ctx.call('POST', `/api/tasks/${t.body.id}/dispatch`, {
    cookie: lin.cookie,
    payload: { toUserId: wang.userId },
  })
  assert.equal(d.status, 400)
  assert.match(d.body.error, /只有组长/)

  const disp = await ctx.call('POST', '/api/disputes', {
    cookie: lin.cookie,
    payload: { fromUserId: wang.userId, toUserId: lin.userId, delta: 1 },
  })
  assert.equal(disp.status, 400)

  const att = await ctx.call('POST', '/api/attendance', {
    cookie: lin.cookie,
    payload: { targetUserId: wang.userId, kind: 'checkin' },
  })
  assert.equal(att.status, 400)

  const mt = await ctx.call('POST', '/api/meetings', {
    cookie: lin.cookie,
    payload: { heldOn: '2026-09-20' },
  })
  assert.equal(mt.status, 400)
  assert.match(mt.body.error, /只有组长/)
})

test('出勤必须挂会议，且一人一会只记一次', async () => {
  const ctx = await newGroup()
  const lin = await inviteAndJoin(ctx, '林嘉')

  const noMeeting = await ctx.call('POST', '/api/attendance', {
    cookie: ctx.cookie,
    payload: { targetUserId: lin.userId, kind: 'checkin' },
  })
  assert.equal(noMeeting.status, 400)
  assert.match(noMeeting.body.error, /一场具体的会议/)

  const m = await ctx.call('POST', '/api/meetings', {
    cookie: ctx.cookie,
    payload: { heldOn: '2026-09-20', note: '第 7 周例会' },
  })
  assert.equal(m.status, 200, JSON.stringify(m.body))

  const first = await ctx.call('POST', '/api/attendance', {
    cookie: ctx.cookie,
    payload: { meetingId: m.body.id, targetUserId: lin.userId, kind: 'checkin' },
  })
  assert.equal(first.status, 200)

  const again = await ctx.call('POST', '/api/attendance', {
    cookie: ctx.cookie,
    payload: { meetingId: m.body.id, targetUserId: lin.userId, kind: 'checkin' },
  })
  assert.equal(again.status, 400)
  assert.match(again.body.error, /已经记录过/)

  const dupMeeting = await ctx.call('POST', '/api/meetings', {
    cookie: ctx.cookie,
    payload: { heldOn: '2026-09-20' },
  })
  assert.equal(dupMeeting.status, 400)
  assert.match(dupMeeting.body.error, /一天只能有一场/)

  const board = await ctx.call('GET', '/api/board', { cookie: ctx.cookie })
  assert.equal(board.body.meetings[0].present, 1)
})
