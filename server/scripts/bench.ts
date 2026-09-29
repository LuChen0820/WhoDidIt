import { open, migrate, q } from '../src/db.ts'
import * as L from '../src/ledger.ts'

const db = await open()
await migrate(db)

const { groupId, members } = await L.createGroup(db, {
  name: '压测', ownerName: '陈昊', memberNames: ['林嘉', '王磊', '赵悦', '周子睿'],
})
const id = (n: string) => (members as any)[n]

// 造约 200 条事件
for (let i = 0; i < 40; i++) {
  const who = ['林嘉', '王磊', '赵悦', '周子睿'][i % 4]
  const t = await L.createTask(db, id('陈昊'), { groupId, title: `任务 ${i}`, points: 1 + (i % 5) })
  await L.claimTask(db, id(who), t)
  await L.submitTask(db, id(who), t)
  await L.acceptTask(db, id('陈昊'), t)
}
const n = (await q<any>(db, `select count(*)::int c from events`))[0].c
console.log(`事件数 ${n}\n`)

async function time(label: string, fn: () => any, runs = 7) {
  const ms: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    await fn()
    ms.push(performance.now() - t0)
  }
  ms.sort((a, b) => a - b)
  console.log(`${label.padEnd(34)} 中位 ${ms[(runs / 2) | 0].toFixed(1).padStart(6)}ms   最快 ${ms[0].toFixed(1)}ms`)
}

await time('computeLedger（重算账本）', () => L.computeLedger(db, groupId))
await time('readLedger（只读派生表）', () => L.readLedger(db, groupId))
await time('eventsHash（全表指纹）', () => L.eventsHash(db, groupId))
await time('board 的 tasks 查询', () =>
  q(db, `select id,title,points,status,assignee_id from tasks where group_id=$1`, [groupId]))

await time('一次完整写操作（提交+验收）', async () => {
  const t = await L.createTask(db, id('陈昊'), { groupId, title: 'x', points: 2 })
  await L.claimTask(db, id('林嘉'), t)
  await L.submitTask(db, id('林嘉'), t)
  await L.acceptTask(db, id('陈昊'), t)
})
