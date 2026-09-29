import test from 'node:test'
import assert from 'node:assert/strict'
import { open, migrate, q } from '../src/db.ts'
import {
  createGroup,
  createTask,
  claimTask,
  dispatchTask,
  declineTask,
  submitTask,
  acceptTask,
  rejectTask,
  splitTask,
  createMeeting,
  closeOverdueTask,
  recordAttendance,
  decideDispute,
  computeLedger,
  eventsHash,
  safeUrl,
  append,
  DomainError,
} from '../src/ledger.ts'

async function setup() {
  const db = await open()
  await migrate(db)
  const g = await createGroup(db, {
    name: '校园二手书平台',
    course: '软件工程',
    ownerName: '陈昊',
    memberNames: ['林嘉', '王磊', '赵悦', '周子睿'],
  })
  return { db, ...g }
}

/** 出勤必须挂会议，所以测试里也要先有会 */
async function meeting(db: any, owner: string, groupId: string, heldOn = '2026-09-20') {
  return createMeeting(db, owner, { groupId, heldOn })
}

const byName = (members: Record<string, string>, n: string) => members[n]
const find = (rows: any[], id: string) => rows.find((r) => r.user_id === id)

/* ============================ 1. 事件流不可篡改 ============================ */

test('events 是只追加的：UPDATE / DELETE / TRUNCATE 全部被拒绝', async () => {
  const { db, groupId, ownerId } = await setup()
  await q(db, `insert into events(group_id, actor_id, type) values ($1,$2,'member_joined')`, [groupId, ownerId])

  await assert.rejects(() => q(db, `update events set type='split'`), /append-only/)
  await assert.rejects(() => q(db, `delete from events`), /append-only/)
  await assert.rejects(() => q(db, `truncate events`), /append-only/)

  const n = await q<any>(db, `select count(*)::int c from events`)
  assert.ok(n[0].c >= 1, '事件仍然存在')
})

test('server_time 由数据库生成，客户端传的时间一律被丢弃', async () => {
  const { db, groupId, ownerId } = await setup()
  await q(
    db,
    `insert into events(group_id, actor_id, type, server_time)
     values ($1,$2,'member_joined', timestamp '2001-09-11 08:46:00+00')`,
    [groupId, ownerId]
  )
  const r = await q<any>(
    db,
    `select server_time from events where type='member_joined' order by seq desc limit 1`
  )
  const year = new Date(r[0].server_time).getFullYear()
  assert.ok(year >= 2024, `时间戳应被服务端覆盖，实际年份 ${year}`)
})

test('非组员不能写入痕迹', async () => {
  const { db, groupId } = await setup()
  const stranger = await q<any>(db, `insert into users(display_name) values ('外人') returning id`)
  await assert.rejects(
    () => append(db, { groupId, actorId: stranger[0].id, type: 'checkin' }),
    /不属于该小组/
  )
})

/* ============================ 2. 自验自计被禁止 ============================ */

test('不能验收自己负责的任务，也不能由外人验收', async () => {
  const { db, groupId, members } = await setup()
  const chen = byName(members, '陈昊')
  const lin = byName(members, '林嘉')
  const t = await createTask(db, chen, { groupId, title: '搜索页', points: 3 })
  await claimTask(db, lin, t)
  await submitTask(db, lin, t)
  await assert.rejects(() => acceptTask(db, lin, t), /不能验收自己负责的任务/)

  const stranger = await q<any>(db, `insert into users(display_name) values ('外人') returning id`)
  await assert.rejects(() => acceptTask(db, stranger[0].id, t), /不属于该小组/)
})

test('重复验收不会造分：同一任务只有第一次验收计分', async () => {
  const { db, groupId, members } = await setup()
  const chen = byName(members, '陈昊')
  const lin = byName(members, '林嘉')
  const t = await createTask(db, chen, { groupId, title: '鉴权接口', points: 4 })
  await claimTask(db, lin, t)
  await submitTask(db, lin, t)
  await acceptTask(db, chen, t)

  const before = await computeLedger(db, groupId)
  // 绕过状态机硬塞第二条验收事件，验证派生逻辑本身能去重
  await append(db, {
    groupId,
    actorId: byName(members, '赵悦'),
    taskId: t,
    type: 'review_accepted',
    payload: { assignee: lin, points: 4, title: '鉴权接口' },
  })
  const after = await computeLedger(db, groupId)
  assert.equal(find(after, lin).delivered, find(before, lin).delivered, '重复验收不应增加分数')
})

test('驳回：退回重做、必须写理由、重做后只计一次分', async () => {
  const { db, groupId, members } = await setup()
  const chen = byName(members, '陈昊')
  const lin = byName(members, '林嘉')
  const t = await createTask(db, chen, { groupId, title: '搜索页', points: 4 })
  await claimTask(db, lin, t)
  await submitTask(db, lin, t)

  await assert.rejects(() => rejectTask(db, chen, t, '   '), /理由/)
  await rejectTask(db, chen, t, '缺少空状态和错误提示')

  const st = await q<any>(db, `select status from tasks where id=$1`, [t])
  assert.equal(st[0].status, 'doing', '驳回后退回进行中')
  assert.equal(find(await computeLedger(db, groupId), lin).points, 0, '驳回本身不给分')

  await submitTask(db, lin, t)
  await acceptTask(db, chen, t)
  assert.equal(find(await computeLedger(db, groupId), lin).points, 4, '重做后正常计分，且只算一次')
})

/* ============================ 3. 只有叶子任务计分 ============================ */

test('拆包不会凭空造分：父任务转为汇总节点后不计分', async () => {
  const { db, groupId, members } = await setup()
  const chen = byName(members, '陈昊')
  const wang = byName(members, '王磊')
  const zhao = byName(members, '赵悦')

  const parent = await createTask(db, chen, { groupId, title: '支付联调', points: 8 })
  const kids = await splitTask(db, chen, parent)
  assert.equal(kids.length, 2)

  const p = await q<any>(db, `select has_children, status from tasks where id=$1`, [parent])
  assert.equal(p[0].has_children, true, '父任务应被标记为汇总节点')
  assert.equal(p[0].status, 'closed')

  // 拆包后父任务不能再被验收
  await assert.rejects(() => acceptTask(db, chen, parent), DomainError)

  for (const k of kids) {
    await claimTask(db, wang, k)
    await submitTask(db, wang, k)
    await acceptTask(db, zhao, k)
  }
  const led = await computeLedger(db, groupId)
  assert.equal(find(led, wang).delivered, 8, '两个子任务合计 8 分，不是 16 分')
})

test('未拆包的任务正常计分', async () => {
  const { db, groupId, members } = await setup()
  const lin = byName(members, '林嘉')
  const chen = byName(members, '陈昊')
  const t = await createTask(db, chen, { groupId, title: '需求访谈', points: 3.4 })
  await claimTask(db, lin, t)
  await submitTask(db, lin, t)
  await acceptTask(db, chen, t)
  const led = await computeLedger(db, groupId)
  assert.equal(find(led, lin).delivered, 3.4)
})

/* ============================ 3b. 逾期 ============================ */

const dateOffset = (days: number) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10)

test('迟交在验收那一刻记为逾期事实，且封顶 7 天', async () => {
  const { db, groupId, members } = await setup()
  const chen = byName(members, '陈昊')
  const lin = byName(members, '林嘉')
  const t = await createTask(db, chen, { groupId, title: '迟交的活', points: 4, dueDate: dateOffset(-30) })
  await claimTask(db, lin, t)
  await submitTask(db, lin, t)
  await acceptTask(db, chen, t)

  const led = await computeLedger(db, groupId)
  assert.equal(find(led, lin).overdue, -3.5, '30 天迟交也只扣 7 天 × 0.5')
  assert.equal(find(led, lin).points, 0.5, '交付 4 − 逾期 3.5')

  const n = await q<any>(db, `select count(*)::int c from events where task_id=$1 and type='overdue_recorded'`, [t])
  assert.equal(n[0].c, 1, '一个任务只有一条逾期事实')
})

test('按时交付不扣逾期分', async () => {
  const { db, groupId, members } = await setup()
  const chen = byName(members, '陈昊')
  const lin = byName(members, '林嘉')
  const t = await createTask(db, chen, { groupId, title: '准时的活', points: 4, dueDate: dateOffset(3) })
  await claimTask(db, lin, t)
  await submitTask(db, lin, t)
  await acceptTask(db, chen, t)
  const led = await computeLedger(db, groupId)
  assert.equal(find(led, lin).overdue, 0)
  assert.equal(find(led, lin).points, 4)
})

test('逾期未交付：关闭后扣分但不给交付分', async () => {
  const { db, groupId, members } = await setup()
  const chen = byName(members, '陈昊')
  const lin = byName(members, '林嘉')
  const t = await createTask(db, chen, { groupId, title: '一直没人做的活', points: 5, dueDate: dateOffset(-10) })
  await claimTask(db, lin, t)
  await closeOverdueTask(db, chen, t, '组员失联')

  const led = await computeLedger(db, groupId)
  assert.equal(find(led, lin).delivered, 0, '没交付就是没交付，关闭不补分')
  assert.equal(find(led, lin).overdue, -3.5)
  const st = await q<any>(db, `select status from tasks where id=$1`, [t])
  assert.equal(st[0].status, 'closed')
})

test('关闭逾期任务的三条限制', async () => {
  const { db, groupId, members } = await setup()
  const chen = byName(members, '陈昊')
  const lin = byName(members, '林嘉')

  const notYet = await createTask(db, chen, { groupId, title: '还没到期', points: 2, dueDate: dateOffset(5) })
  await claimTask(db, lin, notYet)
  await assert.rejects(() => closeOverdueTask(db, chen, notYet), /还没到期/)

  const nobody = await createTask(db, chen, { groupId, title: '没人认领', points: 2, dueDate: dateOffset(-10) })
  await assert.rejects(() => closeOverdueTask(db, chen, nobody), /无人认领/)

  await assert.rejects(() => closeOverdueTask(db, lin, nobody), /只有组长/)
})

test('逾期不能靠重复关闭记两次', async () => {
  const { db, groupId, members } = await setup()
  const chen = byName(members, '陈昊')
  const lin = byName(members, '林嘉')
  const t = await createTask(db, chen, { groupId, title: 'a', points: 2, dueDate: dateOffset(-10) })
  await claimTask(db, lin, t)
  await closeOverdueTask(db, chen, t)
  await assert.rejects(() => closeOverdueTask(db, chen, t), /已经结束了/)
  const n = await q<any>(db, `select count(*)::int c from events where task_id=$1 and type='overdue_recorded'`, [t])
  assert.equal(n[0].c, 1)
})

/* ============================ 4. 分发闭环 ============================ */

test('验收奖不计入总分：组长验收三次，一分未得', async () => {
  const { db, groupId, members } = await setup()
  const chen = byName(members, '陈昊')
  for (const n of ['林嘉', '王磊', '赵悦']) {
    const t = await createTask(db, chen, { groupId, title: `${n}的活`, points: 2 })
    await claimTask(db, byName(members, n), t)
    await submitTask(db, byName(members, n), t)
    await acceptTask(db, chen, t)
  }
  const led = await computeLedger(db, groupId)
  const chenRow = find(led, chen)

  assert.equal(chenRow.review_bonus, 1.5, '3 次验收 × 0.5，仍然被记录')
  assert.equal(chenRow.delivered, 0)
  assert.equal(chenRow.points, 0, '验收奖不得进入总分，否则组长既是裁判又是选手')
  assert.equal(chenRow.points, chenRow.delivered + chenRow.attendance + chenRow.adjustment)
})

test('指派 → 拒绝 会留痕，任务回到待认领', async () => {
  const { db, groupId, members } = await setup()
  const chen = byName(members, '陈昊')
  const zhou = byName(members, '周子睿')
  const t = await createTask(db, chen, { groupId, title: '部署与域名', points: 1.8 })

  await dispatchTask(db, chen, t, zhou)
  await declineTask(db, zhou, t, '这周有事')

  const task = await q<any>(db, `select assignee_id, status from tasks where id=$1`, [t])
  assert.equal(task[0].assignee_id, null)
  assert.equal(task[0].status, 'todo')

  const types = (await q<any>(db, `select type from events where task_id=$1 order by seq`, [t])).map(
    (r) => r.type
  )
  assert.deepEqual(types, ['task_created', 'dispatched', 'declined'], '拒绝必须留下痕迹')
})

test('只有组长能派活和裁决', async () => {
  const { db, groupId, members } = await setup()
  const chen = byName(members, '陈昊')
  const lin = byName(members, '林嘉')
  const t = await createTask(db, chen, { groupId, title: 'x', points: 1 })
  await assert.rejects(
    () => dispatchTask(db, lin, t, byName(members, '王磊')),
    /只有组长/
  )
})

/* ============================ 5. 仲裁用追加 ============================ */

test('仲裁转移分数：原始事件一条不改，总和不变', async () => {
  const { db, groupId, members } = await setup()
  const chen = byName(members, '陈昊')
  const wang = byName(members, '王磊')
  const zhao = byName(members, '赵悦')

  const t = await createTask(db, chen, { groupId, title: '订单模块前端联调', points: 3.2 })
  // 痕迹错挂在赵悦名下：由她认领并提交
  await claimTask(db, zhao, t)
  await submitTask(db, zhao, t)
  await acceptTask(db, chen, t)

  const before = await computeLedger(db, groupId)
  const h1 = await eventsHash(db, groupId)
  const total1 = before.reduce((s, r) => s + r.points, 0)

  await decideDispute(db, chen, {
    groupId,
    fromUserId: zhao,
    toUserId: wang,
    delta: 3.2,
    note: '实际执行人为王磊，赵悦仅执行合并',
  })
  const after = await computeLedger(db, groupId)

  assert.equal(find(after, wang).adjustment, 3.2)
  assert.equal(find(after, zhao).adjustment, -3.2)
  assert.equal(
    Math.round(after.reduce((s, r) => s + r.points, 0) * 100) / 100,
    Math.round(total1 * 100) / 100,
    '仲裁只转移分数，不创造分数'
  )

  const h2 = await eventsHash(db, groupId)
  assert.notEqual(h1.hash, h2.hash, '新增事件后指纹变化')
  const n1 = h1.count,
    n2 = h2.count
  assert.equal(n2, n1 + 1, '仲裁是追加一条事件，不是修改历史')
})

/* ============================ 6. 出勤 ============================ */

test('出勤挂到具体会议：一人一会只能记一次，跨会议才累加', async () => {
  const { db, groupId, members } = await setup()
  const chen = byName(members, '陈昊')
  const zhou = byName(members, '周子睿')
  const m1 = await meeting(db, chen, groupId, '2026-09-13')
  const m2 = await meeting(db, chen, groupId, '2026-09-20')

  await recordAttendance(db, chen, { groupId, meetingId: m1, targetUserId: zhou, kind: 'checkin' })
  await assert.rejects(
    () => recordAttendance(db, chen, { groupId, meetingId: m1, targetUserId: zhou, kind: 'checkin' }),
    /已经记录过/
  )
  await assert.rejects(
    () => recordAttendance(db, chen, { groupId, meetingId: m1, targetUserId: zhou, kind: 'absence_recorded' }),
    /已经记录过/,
    '改成缺席也不行——一场会一个人只有一个事实'
  )
  await recordAttendance(db, chen, { groupId, meetingId: m2, targetUserId: zhou, kind: 'absence_recorded' })

  const led = await computeLedger(db, groupId)
  assert.equal(find(led, zhou).attendance, -1, '第一场 +0.5，第二场 −1.5')
})

test('不挂会议就写不进出勤（堵住连点刷分）', async () => {
  const { db, groupId, members } = await setup()
  await assert.rejects(
    () =>
      append(db, {
        groupId,
        actorId: byName(members, '陈昊'),
        subjectId: byName(members, '周子睿'),
        type: 'checkin',
      }),
    /attendance_needs_target|violates check constraint/i
  )
})

test('同一天不能记两场会', async () => {
  const { db, groupId, members } = await setup()
  const chen = byName(members, '陈昊')
  await meeting(db, chen, groupId, '2026-09-20')
  await assert.rejects(() => meeting(db, chen, groupId, '2026-09-20'), /一天只能有一场/)
})

test('非组长不能建任务定分值', async () => {
  const { db, groupId, members } = await setup()
  await assert.rejects(
    () => createTask(db, byName(members, '林嘉'), { groupId, title: '给自己准备的活', points: 20 }),
    /只有组长/
  )
})

test('产出链接只接受 http/https', async () => {
  assert.equal(safeUrl('https://github.example/x'), 'https://github.example/x')
  assert.equal(safeUrl('http://a.b'), 'http://a.b')
  assert.equal(safeUrl('javascript:alert(1)'), null)
  assert.equal(safeUrl('JavaScript:alert(1)'), null)
  assert.equal(safeUrl('  javascript:alert(1)'), null)
  assert.equal(safeUrl('data:text/html,<script>alert(1)</script>'), null)

  const { db, groupId, members } = await setup()
  const chen = byName(members, '陈昊')
  const lin = byName(members, '林嘉')
  const t = await createTask(db, chen, { groupId, title: '搜索页', points: 3 })
  await claimTask(db, lin, t)
  await assert.rejects(
    () => submitTask(db, lin, t, ['javascript:alert(document.cookie)']),
    /http\/https/
  )
})

/* ============================ 7. 重放一致性（地基） ============================ */

test('账本可全量重放：删掉 ledger 重算，结果逐字节一致', async () => {
  const { db, groupId, members } = await setup()
  const names = ['林嘉', '王磊', '赵悦', '周子睿']
  const chen = byName(members, '陈昊')

  for (const [i, n] of names.entries()) {
    const u = byName(members, n)
    const t = await createTask(db, chen, { groupId, title: `任务${i}`, points: 2 + i })
    await claimTask(db, u, t)
    await submitTask(db, u, t)
    await acceptTask(db, chen, t)
  }
  const mid = await meeting(db, chen, groupId, '2026-09-20')
  await recordAttendance(db, chen, {
    groupId,
    meetingId: mid,
    targetUserId: byName(members, '周子睿'),
    kind: 'absence_recorded',
  })
  await decideDispute(db, chen, {
    groupId,
    fromUserId: byName(members, '赵悦'),
    toUserId: byName(members, '王磊'),
    delta: 1,
  })

  const first = await computeLedger(db, groupId)
  const hashA = (await eventsHash(db, groupId)).hash

  // 重放：清空派生表，只从 events 重建
  await q(db, `delete from ledger`)
  const second = await computeLedger(db, groupId)
  const hashB = (await eventsHash(db, groupId)).hash

  assert.deepEqual(second, first, '重放结果必须与首次计算完全一致')
  assert.equal(hashA, hashB, '事件指纹不重放派生表，不应变化')
})

test('占比全组归一化到 100%', async () => {
  const { db, groupId, members } = await setup()
  const chen = byName(members, '陈昊')
  for (const n of ['林嘉', '王磊']) {
    const t = await createTask(db, chen, { groupId, title: `${n}的活`, points: 5 })
    await claimTask(db, byName(members, n), t)
    await submitTask(db, byName(members, n), t)
    await acceptTask(db, chen, t)
  }
  const led = await computeLedger(db, groupId)
  const sum = led.reduce((s, r) => s + r.pct, 0)
  assert.equal(Math.round(sum * 10) / 10, 100, `占比合计应为 100，实际 ${sum}`)
})
