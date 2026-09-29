import { open, migrate, q } from './db.ts'
import {
  createGroup,
  createTask,
  claimTask,
  dispatchTask,
  declineTask,
  submitTask,
  acceptTask,
  splitTask,
  createMeeting,
  closeOverdueTask,
  recordAttendance,
  decideDispute,
  computeLedger,
  eventsHash,
} from './ledger.ts'

const db = await open()
await migrate(db)

const { groupId, members } = await createGroup(db, {
  name: '校园二手书平台',
  course: '软件工程 第 4 组',
  ownerName: '陈昊',
  memberNames: ['林嘉', '王磊', '赵悦', '周子睿'],
})
const id = (n: string) => (members as any)[n]
const owner = id('陈昊')

const plan: [string, string, number][] = [
  ['陈昊', '库存表结构设计', 2.8],
  ['陈昊', '登录与鉴权接口', 3.1],
  ['林嘉', '需求访谈：12 位二手书买家', 3.4],
  ['林嘉', '书籍搜索与筛选', 3.5],
  ['赵悦', '测试用例 40 条', 2.6],
  ['赵悦', '订单模块前端联调', 3.2],
  ['王磊', '支付接口联调', 3.0],
  ['周子睿', '部署与域名', 1.8],
]

for (const [who, title, points] of plan) {
  const t = await createTask(db, owner, { groupId, title, points })
  await claimTask(db, id(who), t)
  await submitTask(db, id(who), t)
  // 验收人轮换，且永远不是负责人自己
  const reviewer = who === '陈昊' ? id('林嘉') : owner
  await acceptTask(db, reviewer, t)
}

// 一次拒绝：组长派活，组员拒绝，痕迹留下
const extra = await createTask(db, owner, { groupId, title: '结算单页面 UI', points: 2.4 })
await dispatchTask(db, owner, extra, id('周子睿'))
await declineTask(db, id('周子睿'), extra, '这周有事')

// 一次拆包：父任务转为汇总节点，不计分
const big = await createTask(db, owner, { groupId, title: '推荐算法', points: 6 })
const kids = await splitTask(db, owner, big)
await claimTask(db, id('林嘉'), kids[0])
await submitTask(db, id('林嘉'), kids[0])
await acceptTask(db, owner, kids[0])

// 一次迟交：截止日 10 天前，最终还是交付了 → 扣满 7 天上限
const past = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10)
const late = await createTask(db, owner, { groupId, title: '导出与校验码', points: 3, dueDate: past(10) })
await claimTask(db, id('王磊'), late)
await submitTask(db, id('王磊'), late)
await acceptTask(db, owner, late)

// 一次逾期未交付：组长直接关闭，扣分但不给交付分
const dead = await createTask(db, owner, { groupId, title: '教师端只读页', points: 1.8, dueDate: past(20) })
await claimTask(db, id('周子睿'), dead)
await closeOverdueTask(db, owner, dead, '组员失联，改派给林嘉重做')

// 三次例会，出勤必须挂到具体哪一场
const weeks = ['2026-09-08', '2026-09-13', '2026-09-20']
for (const [i, d] of weeks.entries()) {
  const mid = await createMeeting(db, owner, { groupId, heldOn: d, note: `第 ${i + 4} 周例会` })
  await recordAttendance(db, owner, {
    groupId, meetingId: mid, targetUserId: id('周子睿'),
    kind: i === 2 ? 'absence_recorded' : 'checkin',
  })
  await recordAttendance(db, owner, {
    groupId, meetingId: mid, targetUserId: id('王磊'),
    kind: i === 0 ? 'absence_recorded' : 'checkin',
  })
}

const show = async (label: string) => {
  const led = await computeLedger(db, groupId)
  const names = await q<any>(db, `select id, display_name from users`)
  const nm = new Map(names.map((r) => [r.id, r.display_name]))
  const h = await eventsHash(db, groupId)
  console.log(`\n=== ${label} ===`)
  console.log('组员    交付  验收奖*  出勤   逾期    仲裁    合计    占比')
  console.log('        (*验收奖仅展示，不计入合计)')
  for (const r of led) {
    console.log(
      [
        String(nm.get(r.user_id)).padEnd(5),
        r.delivered.toFixed(1).padStart(5),
        r.review_bonus.toFixed(1).padStart(6),
        r.attendance.toFixed(1).padStart(6),
        r.overdue.toFixed(1).padStart(6),
        r.adjustment.toFixed(1).padStart(6),
        r.points.toFixed(1).padStart(7),
        (r.pct.toFixed(1) + '%').padStart(7),
      ].join(' ')
    )
  }
  console.log(`事件 ${h.count} 条 · 指纹 ${h.hash.slice(0, 16)}…`)
  return led
}

await show('仲裁前')

await decideDispute(db, owner, {
  groupId,
  fromUserId: id('赵悦'),
  toUserId: id('王磊'),
  delta: 3.2,
  note: '订单模块实际执行人为王磊，赵悦仅执行合并动作',
})
await show('仲裁后（原始事件一行未改，调整作为新事件追加）')
