import { open, migrate, q } from '../src/db.ts'
import * as L from '../src/ledger.ts'

const line = (s: string) => console.log(`\n${'='.repeat(4)} ${s}`)
let leaked = 0

/* ---------- 1. 链接协议白名单 ---------- */
line('证据链链接的协议白名单')
{
  const bad = ['javascript:alert(1)', 'JavaScript:alert(1)', '  javascript:alert(1)', 'data:text/html,<script>x</script>', 'vbscript:msgbox']
  const leaks = bad.filter((u) => L.safeUrl(u) !== null)
  console.log(leaks.length ? `仍可注入：${leaks.join(' , ')}` : '全部拦下：' + bad.join(', '))
  const good = ['https://github.example/x', 'http://a.b/c'].filter((u) => L.safeUrl(u) === null)
  console.log(good.length ? `误伤正常链接：${good.join(', ')}` : '正常 http/https 不受影响')
  if (leaks.length || good.length) leaked++
}

/* ---------- 2. 签到刷分 ---------- */
line('连点 20 次「签到」')
{
  const db = await open(); await migrate(db)
  const { groupId, members } = await L.createGroup(db, { name: 'p', ownerName: '陈昊', memberNames: ['林嘉'] })
  const chen = members['陈昊'], lin = members['林嘉']
  const mid = await L.createMeeting(db, chen, { groupId, heldOn: '2026-09-20' })
  let ok = 0, blocked = 0
  for (let i = 0; i < 20; i++) {
    try {
      await L.recordAttendance(db, chen, { groupId, meetingId: mid, targetUserId: lin, kind: 'checkin' })
      ok++
    } catch { blocked++ }
  }
  const led = await L.computeLedger(db, groupId)
  const r = led.find((x) => x.user_id === lin)!
  console.log(`成功 ${ok} 次、被数据库拒绝 ${blocked} 次 → 林嘉 出勤 ${r.attendance} 分，占比 ${r.pct.toFixed(1)}%`)
  if (ok > 1) { console.log('洞还在'); leaked++ } else console.log('已堵住：一人一会只有一条出勤事实')
}

/* ---------- 3. 组员自建高分任务 ---------- */
line('普通组员给自己建 20 分任务')
{
  const db = await open(); await migrate(db)
  const { groupId, members } = await L.createGroup(db, { name: 'p', ownerName: '陈昊', memberNames: ['林嘉', '王磊'] })
  try {
    const t = await L.createTask(db, members['林嘉'], { groupId, title: '我给自己准备的活', points: 20 })
    await L.claimTask(db, members['林嘉'], t)
    await L.submitTask(db, members['林嘉'], t)
    await L.acceptTask(db, members['王磊'], t)
    const led = await L.computeLedger(db, groupId)
    console.log('仍可创建 ← 洞还在：', led.map((r) => `${r.points}分`).join(' / '))
    leaked++
  } catch (e: any) {
    console.log('已被拒绝：', e.message)
  }
}

/* ---------- 4. 不挂会议的出勤写不进来 ---------- */
line('绕过接口直接写事件能否造出出勤')
{
  const db = await open(); await migrate(db)
  const { groupId, members } = await L.createGroup(db, { name: 'p', ownerName: '陈昊', memberNames: ['林嘉'] })
  try {
    await L.append(db, {
      groupId, actorId: members['陈昊'], subjectId: members['林嘉'], type: 'checkin',
    })
    console.log('写进去了 ← 约束没生效')
    leaked++
  } catch (e: any) {
    console.log('被数据库约束拒绝：', String(e.message).slice(0, 90))
  }
}

/* ---------- 5. 负分的进度条宽度（前端算法复刻） ---------- */
line('负分时前端进度条宽度')
{
  const db = await open(); await migrate(db)
  const { groupId, members } = await L.createGroup(db, { name: 'p', ownerName: '陈昊', memberNames: ['林嘉', '王磊'] })
  for (const d of ['2026-09-06', '2026-09-13', '2026-09-20', '2026-09-27']) {
    const mid = await L.createMeeting(db, members['陈昊'], { groupId, heldOn: d })
    await L.recordAttendance(db, members['陈昊'], { groupId, meetingId: mid, targetUserId: members['林嘉'], kind: 'absence_recorded' })
  }
  const led = await L.computeLedger(db, groupId)
  const r = led.find((x) => x.user_id === members['林嘉'])!
  const total = led.reduce((s, x) => s + Math.max(0, x.points), 0) || 1
  const w = (Math.abs(r.attendance) / total) * 100
  console.log(`林嘉 出勤 ${r.attendance} → 该段宽度 ${w.toFixed(0)}%${w > 100 ? '（溢出容器，且 abs() 让扣分看起来像得分）' : ''}`)
}

/* ---------- 6. 声明了但代码里永远不会产生的东西 ---------- */
line('schema 与实现的差距')
{
  const db = await open(); await migrate(db)
  const { groupId, members } = await L.createGroup(db, { name: 'p', ownerName: '陈昊', memberNames: ['林嘉'] })
  const chen = members['陈昊'], lin = members['林嘉']
  const t = await L.createTask(db, chen, { groupId, title: 'a', points: 3 })
  await L.dispatchTask(db, chen, t, lin)
  await L.submitTask(db, lin, t)
  await L.acceptTask(db, chen, t)
  const used = new Set((await q<any>(db, `select distinct type::text as t from events`)).map((r) => r.t))
  const never = ['task_weighted', 'no_response', 'review_rejected', 'reassigned', 'dispute_opened']
  console.log('事件类型零代码路径：', never.join(', '))
  console.log('tasks.blocked_by 存在但没有任何接口写入 —— 依赖阻塞未落地')
  console.log('member_role 含 auditor，但邀请接口不接受 role —— 教师只读账号建不出来')
}

console.log(`\n${leaked === 0 ? '✓ 已知攻击面全部已封堵' : `✗ 仍有 ${leaked} 处可被刷穿`}`)
