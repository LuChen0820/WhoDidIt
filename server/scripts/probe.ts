import { readFileSync } from 'node:fs'
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

/* ---------- 5. 负分时的进度条宽度 ---------- */
line('负分时前端进度条宽度（复刻 app.js 当前算法）')
{
  const db = await open(); await migrate(db)
  const { groupId, members } = await L.createGroup(db, { name: 'p', ownerName: '陈昊', memberNames: ['林嘉', '王磊'] })
  for (const d of ['2026-09-06', '2026-09-13', '2026-09-20', '2026-09-27']) {
    const mid = await L.createMeeting(db, members['陈昊'], { groupId, heldOn: d })
    await L.recordAttendance(db, members['陈昊'], { groupId, meetingId: mid, targetUserId: members['林嘉'], kind: 'absence_recorded' })
  }
  const led = await L.computeLedger(db, groupId)
  const r = led.find((x) => x.user_id === members['林嘉'])!
  // 与 viewLedger 保持一致：正分按正分总和归一，扣分单独一条
  const total = led.reduce((s, x) => s + Math.max(0, x.points), 0) || 1
  const parts = [['交付', r.delivered], ['出勤', r.attendance], ['逾期', r.overdue], ['仲裁', r.adjustment]]
    .filter(([, v]) => v !== 0)
  const pos = parts.filter(([, v]) => v > 0)
  const neg = parts.filter(([, v]) => v < 0)
  const negTotal = neg.reduce((s, [, v]) => s + Math.abs(v), 0)
  const widths = [...pos.map(([l, v]) => [l, (v / total) * 100]), ...neg.map(([l, v]) => [l, (Math.abs(v) / negTotal) * 100])]
  const worst = Math.max(...widths.map(([, w]) => w), 0)
  console.log(`林嘉 出勤 ${r.attendance} → 得分段 ${pos.length} 个 / 扣分单独一条 ${neg.length} 个，最宽 ${worst.toFixed(0)}%`)
  if (worst > 100.01) { console.log('仍会溢出容器'); leaked++ }
  else console.log('不溢出，且扣分与得分视觉分离（不再用 abs() 混画）')
  if (r.pct > 0) { console.log('负分却得到正占比，归一化有问题'); leaked++ }
}

/* ---------- 6. 枚举与代码是否对得上 ---------- */
line('schema 声明的事件类型是否都能被代码产生')
{
  const db = await open(); await migrate(db)
  const types = String((await q<any>(db, `select enum_range(null::event_type) as t`))[0].t)
    .replace(/[{}]/g, '').split(',')
  // 直接扫源码，而不是维护一份手写清单 —— 上一版就是靠臆测写了个不存在的 blocked 状态
  const src = readFileSync(new URL('../src/ledger.ts', import.meta.url), 'utf8')
  const orphan = types.filter((t) => !src.includes(`'${t}'`))
  if (orphan.length) {
    console.log('代码里永远不会产生的事件类型：', orphan.join(', '))
    leaked++
  } else {
    console.log(`${types.length} 个事件类型全部有真实代码路径`)
  }
}

/* ---------- 7. 文字对比度：直接从 app.css / app.js 解析真实色值 ---------- */
line('WCAG AA 对比度（解析实际文件，不是手写清单）')
{
  const css = readFileSync(new URL('../web/app.css', import.meta.url), 'utf8')
  const js = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8')
  // 色值可能是 3 位（#fff）也可能是 6 位，统一展开成 6 位
  const hex = (v: string) => (v.length === 4 ? '#' + [...v.slice(1)].map((c) => c + c).join('') : v)
  const tok = (name: string) => {
    const m = new RegExp(`--${name}:(#[0-9a-f]{3,6})\\b`, 'i').exec(css)
    return m ? hex(m[1]) : undefined
  }
  const palette: string[] = (/const PALETTE = \[([^\]]+)\]/.exec(js)?.[1] ?? '')
    .match(/#[0-9a-f]{6}/gi) ?? []

  const lum = (h: string) => {
    const c = h.replace('#', '').match(/../g)!.map((x) => parseInt(x, 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  }
  const cr = (a: string, b: string) => {
    const l1 = lum(a), l2 = lum(b)
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
  }

  const checks: [string, string, string][] = [
    ['正文', tok('ink')!, tok('card')!],
    ['次要文字 / 页脚 / 空态', tok('sub')!, tok('bg')!],
    ['次要文字（卡片上）', tok('sub')!, tok('card')!],
    ['次要文字（看板列底）', tok('sub')!, '#eff1f6'],
    ['导航选中态文字', tok('brand')!, tok('brand-soft')!],
    ['正向标签', '#15803d', '#e7f7ee'],
    ['负向标签', '#b91c1c', '#fdecec'],
    ['警告标签', '#92400e', '#fef3c7'],
  ]
  palette.forEach((p, i) => checks.push([`头像/进度条 色板#${i + 1} 上的白字`, '#ffffff', p]))

  const fails = checks.filter(([, a, b]) => cr(a, b) < 4.5)
  checks.forEach(([n, a, b]) => {
    const r = cr(a, b)
    if (r < 4.5) console.log(`  ✗ ${r.toFixed(2)}:1  ${n}  (${a} on ${b})`)
  })
  console.log(fails.length === 0
    ? `  ✓ ${checks.length} 组全部 ≥ 4.5:1`
    : `  ${fails.length} 组不达标`)
  if (fails.length) leaked++

  // 字号下限：投影仪上 <12px 的正文不可读。单字徽标（头像、计数）豁免。
  const small = [...css.matchAll(/([^{}\n]+)\{[^}]*font-size:\s*(\d+(?:\.\d+)?)px/g)]
    .filter(([, sel, px]) => parseFloat(px) < 12 && !/\.mini|\.dot|col-h b/.test(sel))
    .map(([, sel, px]) => `${sel.trim().split('\n').pop()} ${px}px`)
  if (small.length) { console.log('  ✗ 低于 12px 的正文：\n    ' + small.join('\n    ')); leaked++ }
  else console.log('  ✓ 正文字号均 ≥ 12px（单字徽标豁免）')
}

console.log(`\n${leaked === 0 ? '✓ 已知攻击面全部已封堵，视觉可达性达标' : `✗ 仍有 ${leaked} 处问题`}`)
