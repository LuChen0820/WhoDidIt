/* 谁在干活 · 零构建单页前端。所有用户输入一律经 esc() 转义后再插入 DOM。 */

const $ = (s) => document.querySelector(s)
const $$ = (s) => [...document.querySelectorAll(s)]
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/** 只放行 http/https。esc() 只转义引号，挡不住 javascript: 这种协议级攻击。 */
const safeHref = (u) => (/^https?:\/\//i.test(String(u ?? '').trim()) ? String(u).trim() : null)

/** 加深版调色板：白字对比度全部 ≥ 4.5:1（WCAG AA）。
 *  原来的 8 色里有 6 色白字不达标（最低 2.15:1）。
 *  同一批颜色也用于占比条和进度条，改一次三处受益。 */
const PALETTE = ['#4338ca', '#0369a1', '#047857', '#b45309', '#475569', '#be185d', '#6d28d9', '#0f766e']
const COLS = [['todo', '待认领'], ['doing', '进行中'], ['review', '待验收'], ['done', '已完成']]
const EVT = {
  task_created: '创建任务', claimed: '认领任务', dispatched: '被指派', declined: '拒绝接受指派',
  submitted: '提交产出', review_accepted: '验收通过', review_rejected: '验收驳回', split: '拆分为子任务',
  overdue_recorded: '记录逾期',
  reassigned: '改派', no_response: '超时未响应', task_weighted: '调整权重',
  dispute_decided: '仲裁调整', checkin: '例会签到', absence_recorded: '记为缺席',
  member_joined: '加入小组', group_created: '建立小组',
}

const S = { me: null, board: null, ledger: null, view: 'board', color: new Map() }

/** 非正分不显示占比：「−9.3%」不是占比，是负数除正数的副产品。
 *  这个人拖后腿的信息在红色扣分条和负分标签里已经说清楚了。 */
const pctText = (v) => (v > 0 ? v.toFixed(1) + '%' : '—')

/* ------------------------------------------------------------------ 网络层 */

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  let data
  try { data = JSON.parse(text) } catch { data = { error: text } }
  if (!r.ok) throw new Error(data.error || `请求失败 ${r.status}`)
  return data
}

async function refresh() {
  S.board = await api('GET', '/api/board')
  S.me = { ...(S.me ?? {}), ...S.board.me }
  S.ledger = S.board.ledger
  S.board.members.forEach((m, i) => { if (!S.color.has(m.user_id)) S.color.set(m.user_id, PALETTE[i % PALETTE.length]) })
  render()
}

/** 点击即反馈：按钮马上禁用并改文案，避免"没点上"的错觉和重复提交 */
function pending(el, text = '处理中…') {
  const prev = { disabled: el.disabled, label: el.textContent }
  el.disabled = true
  el.textContent = text
  el._restore = () => { el.disabled = prev.disabled; el.textContent = prev.label; delete el._restore }
  return el._restore
}

const c = (id) => S.color.get(id) ?? '#475569'
const nameOf = (id) => S.board?.members.find((m) => m.user_id === id)?.name ?? '—'
const roleOf = (id) => S.board?.members.find((m) => m.user_id === id)?.role ?? 'member'
const isOwner = () => S.me?.role === 'owner'

/** 关抽屉必须连遮罩一起关：只关抽屉会让整页点不动 */
function hideDrawer(){ $('#drawer').classList.remove('on'); $('#mask').classList.remove('on') }

function toast(msg) {
  const el = $('#toast')
  el.textContent = msg
  el.classList.add('on')
  clearTimeout(toast._t)
  toast._t = setTimeout(() => el.classList.remove('on'), 3200)
}

async function guard(fn, el) {
  const restore = el ? pending(el) : null
  try { await fn() } catch (e) { toast(e.message); if (restore) restore() }
}

/* ------------------------------------------------------------------ 入口 */

function viewEntry() {
  const q = new URLSearchParams(location.search)
  const token = q.get('token') ?? ''
  const preName = q.get('name') ?? ''
  return `
  <div class="entry">
    <h1>谁在干活</h1>
    <p class="note">小组作业贡献结算台。不互评、只认真实协作痕迹，每个百分比都能点开到原始时间线。</p>
    <div class="card pad">
      <div class="tabs">
        <button data-act="tab-entry" data-t="create" ${token ? '' : 'class="on"'}>我是组长，新建小组</button>
        <button data-act="tab-entry" data-t="join" ${token ? 'class="on"' : ''}>我有邀请链接</button>
      </div>
      <div id="entryPane"></div>
    </div>
    <p class="foot">无密码登录：组员凭「姓名 + 学号后四位」消费一次性邀请链接</p>
  </div>`
}

function entryPane(kind, token = '', preName = '') {
  if (kind === 'join') {
    return `<form data-act="doJoin">
      <div class="field"><label>邀请链接里的 token</label>
        <input name="token" value="${esc(token)}" placeholder="组长发给你的链接里那串字符" required></div>
      <div class="row2">
        <div class="field"><label>你的姓名</label><input name="name" value="${esc(preName)}" required></div>
        <div class="field"><label>学号后四位</label><input name="code4" inputmode="numeric" maxlength="4" pattern="\\d{4}" required></div>
      </div>
      <p class="note" style="margin-bottom:12px">两者必须与组长建组时填写的一致，否则无法加入。</p>
      <button class="btn p" style="width:100%;justify-content:center">加入小组</button>
    </form>`
  }
  return `<form data-act="doCreate">
    <div class="field"><label>项目名称</label><input name="name" placeholder="校园二手书平台" required></div>
    <div class="field"><label>课程</label><input name="course" placeholder="软件工程"></div>
    <div class="field"><label>你的姓名（组长）</label><input name="ownerName" required></div>
    <button class="btn p" style="width:100%;justify-content:center">创建小组</button>
  </form>`
}

/* ------------------------------------------------------------------ 看板 */

function viewBoard() {
  const { members, tasks } = S.board
  const total = members.reduce((s, m) => s + Math.max(0, m.pct), 0) || 1
  const strip = members.map((m) => `<i style="width:${(Math.max(0, m.pct) / total) * 100}%;background:${c(m.user_id)}"></i>`).join('')
  const leg = members.map((m) =>
    `<span><em style="background:${c(m.user_id)}"></em>${esc(m.name)} <b>${pctText(m.pct)}</b></span>`).join('')

  const cols = COLS.map(([k, label]) => {
    const list = tasks.filter((t) => (t.status === 'closed' ? 'done' : t.status) === k)
    return `<div class="col"><div class="col-h">${label}<b>${list.length}</b></div>
      ${list.map(taskCard).join('') || `<div style="font-size:12.5px;color:var(--sub);text-align:center;padding:14px">—</div>`}
    </div>`
  }).join('')

  return `
  <div class="h1row"><h1>任务看板</h1>
    <div style="display:flex;gap:8px">
      ${isOwner() ? '<button class="btn s" data-act="newTask">＋ 新建任务</button>' : ''}
      <button class="btn s p" data-act="tab" data-v="ledger">查看结算单 →</button>
    </div>
  </div>
  <p class="note">贡献分由系统依据真实协作痕迹自动累计。你只能认领、提交、验收别人的产出，<b>不能给自己发分</b>。</p>
  <div class="card pad" style="margin-bottom:18px">
    <div class="sec-title">实时贡献占比 <span class="hint">— 每次验收后自动重算</span></div>
    <div class="strip">${strip}</div>
    <div class="leg">${leg}</div>
  </div>
  <div class="board">${cols}</div>
  <p class="foot">点击任务卡查看证据链并完成认领 / 提交 / 验收</p>`
}

function taskCard(t) {
  const kids = S.board.tasks.filter((k) => k.parent_id === t.id)
  return `<div class="task" data-act="openTask" data-id="${t.id}">
    <div class="t">${esc(t.title)}</div>
    <div class="m">
      ${t.assignee_id
        ? `<span class="mini" style="background:${c(t.assignee_id)}">${esc(t.assignee_name?.[0] ?? '?')}</span>${esc(t.assignee_name)}`
        : '<span class="pill">未认领</span>'}
      <span class="pill">${t.points} 分</span>
      ${t.has_children ? `<span class="pill w">汇总节点 ${kids.filter((k) => k.status === 'done').length}/${kids.length}</span>` : ''}
      ${t.overdue_days ? `<span class="pill d">逾期 ${t.overdue_days} 天</span>` : ''}
      ${t.due_date ? `<span style="margin-left:auto">截止 ${esc(String(t.due_date).slice(5, 10))}</span>` : ''}
      <span class="pill">👁 ${t.evidence_count}</span>
    </div>
  </div>`
}

/* ------------------------------------------------------------------ 结算 */

function viewLedger() {
  const rows = [...S.ledger.rows]
  const total = rows.reduce((s, r) => s + Math.max(0, r.points), 0) || 1
  const body = rows.map((r) => {
    const parts = [['交付', r.delivered], ['出勤', r.attendance], ['逾期', r.overdue], ['仲裁', r.adjustment]].filter(([, v]) => v !== 0)
    const pos = parts.filter(([, v]) => v > 0)
    const neg = parts.filter(([, v]) => v < 0)
    const negTotal = neg.reduce((s, [, v]) => s + Math.abs(v), 0)
    // 得分条按正分总和归一，宽度即占比；扣分单独一条。
    // 混在一起用 abs() 会把 −6 画成 600% 的条，看起来像立了大功。
    const posBar = pos.map(([l, v]) =>
      `<i title="${l} +${v}" style="width:${(v / total) * 100}%;background:${c(r.user_id)}"></i>`).join('')
    const negBar = neg.length
      ? `<div class="bar" style="height:7px;margin-top:4px;background:#fdf1f1">${neg.map(([l, v]) =>
          `<i title="${l} ${v}" style="width:${(Math.abs(v) / negTotal) * 100}%;background:#dc2626"></i>`).join('')}</div>`
      : ''
    return `<div class="lrow">
      <div class="lname"><span class="mini" style="background:${c(r.user_id)}">${esc(r.name[0])}</span>
        <div>${esc(r.name)}<div style="font-size:12px;color:var(--sub);font-weight:400">${r.user_id === S.me.userId ? '（你）' : ''}${roleOf(r.user_id) === 'owner' ? ' 组长' : ''}</div></div></div>
      <div><div class="bar">${posBar}</div>
        ${negBar}
        <div class="sub-bar">${parts.map(([l, v]) =>
          `<span class="chip ${v < 0 ? 'neg' : 'pos'}">${l} ${v > 0 ? '+' : ''}${v}</span>`).join('')}
          <span class="chip">验收他人 ${r.review_bonus}（不计分）</span>
        </div>
      </div>
      <div class="pct" style="${r.points < 0 ? 'color:var(--bad)' : ''}">${pctText(r.pct)}</div>
    </div>`
  }).join('')

  return `
  <div class="h1row"><h1>贡献结算单</h1>
    <div style="display:flex;gap:8px">
      <a class="btn s" href="/api/export/report.txt" target="_blank">教师版说明</a>
      <a class="btn s" href="/api/export/events.csv">导出事件流 CSV</a>
    </div>
  </div>
  <p class="note">共 ${S.ledger.eventCount} 条可追溯痕迹。分数不是被写出来的，是从事件流算出来的。</p>
  <div class="grid2">
    <div class="card pad"><div class="sec-title">成员构成明细</div>${body}</div>
    <div>
      <div class="card pad" style="margin-bottom:16px">
        <div class="sec-title">可复核性</div>
        <p class="note" style="margin-bottom:10px">导出 CSV 后按 <code>seq|actor|task|type|server_time|payload</code> 顺序拼接取 sha256，应等于下面这个值。任何人重算一致，即证明这份结算单事后没被改过。</p>
        <code>${esc(S.ledger.hash)}</code>
      </div>
      ${isOwner() ? disputeForm() : `<div class="card pad"><div class="sec-title">归属异议</div>
        <p class="note">只有组长能裁决异议。如你认为某条归属有误，请把证据时间线发给组长。</p></div>`}
    </div>
  </div>`
}

function disputeForm() {
  const opts = S.board.members.map((m) => `<option value="${m.user_id}">${esc(m.name)}</option>`).join('')
  return `<div class="card pad"><div class="sec-title">裁决归属异议</div>
    <form data-act="doDispute">
      <div class="row2">
        <div class="field"><label>从（误记得分者）</label><select name="fromUserId">${opts}</select></div>
        <div class="field"><label>转给（实际执行人）</label><select name="toUserId">${opts}</select></div>
      </div>
      <div class="row2">
        <div class="field"><label>转移分数</label><input name="delta" type="number" step="0.1" min="0.1" value="1" required></div>
        <div class="field"><label>依据</label><input name="note" placeholder="09-17 凌晨四次提交均为王磊" required></div>
      </div>
      <button class="btn p">追加仲裁事件并重算</button>
      <p class="hint" style="margin-top:8px">原始痕迹一行不改，调整作为新事件追加，可重放复算。</p>
    </form></div>`
}

/* ------------------------------------------------------------------ 组员 */

function viewTeam() {
  const meetings = S.board.meetings ?? []
  const opts = meetings.map((m) => `<option value="${m.id}">${esc(m.held_on)}（到 ${m.present} / 缺 ${m.absent}）</option>`).join('')
  const rows = S.board.members.map((m) => `<tr>
      <td><span class="mini" style="background:${c(m.user_id)}">${esc(m.name[0])}</span> ${esc(m.name)}${m.user_id === S.me.userId ? ' （你）' : ''}</td>
      <td>${m.role === 'owner' ? '组长' : '组员'}</td>
      <td>${m.points.toFixed(1)}</td>
      <td style="${m.points < 0 ? 'color:var(--bad)' : ''}">${pctText(m.pct)}</td>
      <td>${isOwner() && meetings.length ? `<button class="btn s" data-act="attend" data-u="${m.user_id}" data-k="checkin">签到</button>
           <button class="btn s g" data-act="attend" data-u="${m.user_id}" data-k="absence_recorded">缺席</button>` : '—'}</td>
    </tr>`).join('')

  return `
  <h1>组员与会议</h1>
  <p class="note">出勤必须挂到一场具体的会议，<b>一人一会只能记一次</b>；记错了走仲裁改，改动会留下可审计记录。</p>
  <div class="grid2">
    <div class="card pad"><div class="sec-title">成员</div>
      ${meetings.length ? `<div class="field" style="max-width:280px"><label>当前会议</label>
        <select id="meetingPick">${opts}</select></div>` : ''}
      <table><tr><th>姓名</th><th>角色</th><th>分</th><th>占比</th><th>例会</th></tr>${rows}</table>
    </div>
    <div>
      ${isOwner() ? `<div class="card pad" style="margin-bottom:16px">
        <div class="sec-title">记一场会议</div>
        <form data-act="doMeeting">
          <div class="row2">
            <div class="field"><label>日期</label><input name="heldOn" type="date" required></div>
            <div class="field"><label>备注（可空）</label><input name="note" placeholder="第 7 周例会"></div>
          </div>
          <button class="btn p">创建会议</button>
        </form>
        <div class="sec-title" style="margin-top:18px">邀请组员</div>
        <form data-act="doInvite">
          <div class="row2">
            <div class="field"><label>姓名</label><input name="name" required></div>
            <div class="field"><label>学号后四位</label><input name="code4" maxlength="4" pattern="\\d{4}" required></div>
          </div>
          <button class="btn">生成一次性链接</button>
        </form>
        <div id="inviteOut"></div>
      </div>` : ''}
      <div class="card pad">
        <div class="sec-title">规则说明</div>
        <ul style="font-size:13px;color:var(--sub);padding-left:18px;line-height:2">
          <li>不自评、不互评，分数只来自客观痕迹</li>
          <li>验收人不能是负责人本人</li>
          <li>只有叶子任务计分，拆包不会造分</li>
          <li>验收他人不计分，避免组长既裁判又选手</li>
          <li>任务与分值由组长创建，避免自行定价</li>
          <li>签到挂会议，一人一会只记一次</li>
          <li>结算可申诉，仲裁用追加不改历史</li>
        </ul>
      </div>
    </div>
  </div>`
}

/* ------------------------------------------------------------------ 抽屉 */

let drawerTaskId = null

function evidenceHtml(ev) {
  if (!ev || !ev.length) return '<p class="note">暂无痕迹。认领后这里会自动记录。</p>'
  return `<div class="tl">${ev.map((e) => {
    const p = typeof e.payload === 'string' ? JSON.parse(e.payload) : (e.payload ?? {})
    const url = safeHref(p.links?.[0])
    const extra = url ? ` <a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`
      : (p.links?.length ? ` <span class="hint">${esc(p.links[0])}（协议不受支持，已禁用）</span>` : '')
    const pts = p.points ? `（${+p.points} 分）` : ''
    const gray = ['claimed', 'dispatched', 'task_created', 'declined', 'split'].includes(e.type)
    return `<div class="ev ${gray ? 'gray' : ''}"><div class="tm">${esc(new Date(e.server_time).toLocaleString('zh-CN'))}</div>
      <div class="tx"><b>${esc(e.actor)}</b> ${EVT[e.type] ?? esc(e.type)}${pts}${esc(p.note ? '：' + p.note : '')}${extra}</div></div>`
  }).join('')}</div>`
}

async function openTask(id) {
  const t = S.board.tasks.find((x) => x.id === id)
  if (!t) return
  drawerTaskId = id
  const kids = S.board.tasks.filter((k) => k.parent_id === id)
  $('#dTitle').textContent = `任务 · ${t.title}`
  // 先用手上已有的数据把抽屉画出来，痕迹列表留占位，随后异步补上
  $('#dBody').innerHTML = `
    <div class="kv">
      <span>负责人 <b>${t.assignee_name ? esc(t.assignee_name) : '未认领'}</b></span>
      <span>贡献分 <b>${+t.points}</b></span>
      <span>状态 <b>${(COLS.find((x) => x[0] === (t.status === 'closed' ? 'done' : t.status)) || [])[1] ?? t.status}</b></span>
      ${t.has_children ? `<span style="color:var(--warn)"><b>汇总节点，不计分</b></span>` : ''}
    </div>
    ${kids.length ? `<p class="note">子任务 ${kids.filter((k) => k.status === 'done').length}/${kids.length} 已完成：${kids.map((k) => esc(k.title)).join('、')}</p>` : ''}
    <div class="sec-title">证据链 <span class="hint">— 结算值的唯一依据</span></div>
    <div id="evSlot"><p class="note">读取痕迹中…</p></div>
    <div class="acts" style="margin-top:20px">${actionsFor(t)}</div>`
  $('#drawer').classList.add('on')
  $('#mask').classList.add('on')

  const ev = await guard2(() => api('GET', `/api/tasks/${id}/evidence`))
  if (drawerTaskId !== id) return          // 用户已经切到别的任务，丢掉这次结果
  const slot = $('#evSlot')
  if (slot) slot.outerHTML = evidenceHtml(ev)
}

async function guard2(fn) { try { return await fn() } catch (e) { toast(e.message); return null } }

function actionsFor(t) {
  const me = S.me.userId
  const out = []
  if (!t.assignee_id && t.status === 'todo') {
    out.push(`<button class="btn s p" data-act="claim" data-id="${t.id}">认领这个任务</button>`)
    if (isOwner()) {
      const opts = S.board.members.filter((m) => m.user_id !== me).map((m) => `<option value="${m.user_id}">${esc(m.name)}</option>`).join('')
      out.push(`<select id="pick" class="btn s" style="padding:6px 9px">${opts}</select>
                <button class="btn s" data-act="dispatch" data-id="${t.id}">指派给 TA</button>`)
    }
  }
  if (t.assignee_id === me && t.status === 'doing') {
    out.push(`<input id="link" class="btn s" style="padding:6px 9px;border:1px solid var(--line);border-radius:7px;min-width:170px" placeholder="产出链接（可留空）">`)
    out.push(`<button class="btn s p" data-act="submit" data-id="${t.id}">提交产出</button>`)
    out.push(`<button class="btn s g" data-act="decline" data-id="${t.id}">拒绝这个指派</button>`)
  }
  if (t.status === 'review' && t.assignee_id !== me) {
    out.push(`<button class="btn s p" data-act="accept" data-id="${t.id}">验收通过 → 计入结算</button>`)
    out.push(`<input id="rejWhy" style="padding:6px 9px;border:1px solid var(--line);border-radius:7px;min-width:150px" placeholder="驳回理由">`)
    out.push(`<button class="btn s d" data-act="reject" data-id="${t.id}">驳回重做</button>`)
  }
  if (t.status === 'review' && t.assignee_id === me) {
    out.push(`<span class="hint">不能验收自己负责的任务</span>`)
  }
  if (isOwner() && !t.has_children && t.status !== 'done' && t.status !== 'closed' && !t.parent_id) {
    out.push(`<button class="btn s" data-act="split" data-id="${t.id}">拆成两个子任务</button>`)
  }
  if (isOwner() && t.overdue_days && t.assignee_id && t.status !== 'done' && t.status !== 'closed') {
    out.push(`<button class="btn s d" data-act="closeOverdue" data-id="${t.id}">按逾期关闭（扣 ${(Math.min(t.overdue_days, 7) * 0.5).toFixed(1)} 分）</button>`)
  }
  return out.join('') || '<span class="hint">此任务当前没有你能执行的动作</span>'
}

function openTaskForm() {
  const opts = ['<option value="">— 留空，开放认领 —</option>']
    .concat(S.board.members.map((m) => `<option value="${m.user_id}">${esc(m.name)}</option>`)).join('')
  $('#dTitle').textContent = '新建任务'
  $('#dBody').innerHTML = `<form data-act="doCreateTask">
    <div class="field"><label>任务标题</label><input name="title" placeholder="结算单页面 UI" required></div>
    <div class="row2">
      <div class="field"><label>贡献分</label><input name="points" type="number" step="0.1" min="0.1" max="20" value="2.5" required></div>
      <div class="field"><label>截止日期</label><input name="dueDate" type="date"></div>
    </div>
    <div class="field"><label>负责人${isOwner() ? '' : '（只有组长能直接指派）'}</label>
      <select name="assigneeId" ${isOwner() ? '' : 'disabled'}>${opts}</select></div>
    <button class="btn p" style="width:100%;justify-content:center">创建任务</button>
  </form>`
  $('#drawer').classList.add('on')
  $('#mask').classList.add('on')
}

/* ------------------------------------------------------------------ 渲染 */

function render() {
  if (!S.me) {
    $('#topbar').hidden = true
    $('#app').innerHTML = viewEntry()
    const q = new URLSearchParams(location.search)
    const token = q.get('token') ?? ''
    $('#entryPane').innerHTML = entryPane(token ? 'join' : 'create', token, q.get('name') ?? '')
    return
  }
  $('#topbar').hidden = false
  $('#pjName').textContent = S.me.groupName ?? ''
  $('#whoName').textContent = `${nameOf(S.me.userId)}${isOwner() ? '（组长）' : ''}`
  $$('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.view))
  $('#app').innerHTML = S.view === 'board' ? viewBoard() : S.view === 'ledger' ? viewLedger() : viewTeam()
}

/* ------------------------------------------------------------------ 事件 */

const form = (el) => Object.fromEntries(new FormData(el.closest('form')).entries())

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]')
  if (!el || el.tagName === 'FORM') return
  const a = el.dataset.act
  const id = el.dataset.id

  if (a === 'tab') { S.view = el.dataset.v; render() }
  else if (a === 'tab-entry') {
    $$('.tabs button').forEach((b) => b.classList.toggle('on', b === el))
    $('#entryPane').innerHTML = entryPane(el.dataset.t, new URLSearchParams(location.search).get('token') ?? '')
  }
  else if (a === 'logout') guard(async () => { await api('POST', '/api/logout'); location.href = '/' })
  else if (a === 'openTask') guard(() => openTask(id))
  else if (a === 'closeDrawer') { hideDrawer() }
  else if (a === 'newTask') openTaskForm()
  else if (a === 'claim') guard(async () => { await api('POST', `/api/tasks/${id}/claim`); await refresh(); await openTask(id); toast('已认领，任务进入进行中') }, el)
  else if (a === 'dispatch') guard(async () => { await api('POST', `/api/tasks/${id}/dispatch`, { toUserId: $('#pick').value }); await refresh(); await openTask(id); toast('已指派') }, el)
  else if (a === 'submit') guard(async () => {
    const v = $('#link')?.value?.trim()
    await api('POST', `/api/tasks/${id}/submit`, { links: v ? [v] : [] })
    await refresh(); await openTask(id); toast('已提交，等待他人验收')
  }, el)
  else if (a === 'decline') guard(async () => {
    await api('POST', `/api/tasks/${id}/decline`, { reason: '本人退回' })
    await refresh(); hideDrawer(); toast('已退回待认领，这次拒绝已被记录')
  }, el)
  else if (a === 'accept') guard(async () => {
    const t = S.board.tasks.find((x) => x.id === id)
    await api('POST', `/api/tasks/${id}/accept`)
    await refresh(); hideDrawer()
    const m = S.board.members.find((x) => x.user_id === t?.assignee_id)
    toast(m ? `已验收 · ${m.name} 现为 ${pctText(m.pct)}` : '已验收，贡献分当场入账')
  }, el)
  else if (a === 'reject') guard(async () => {
    const why = document.querySelector('#rejWhy')?.value?.trim()
    if (!why) { toast('驳回必须写明理由'); return }
    await api('POST', `/api/tasks/${id}/reject`, { reason: why })
    await refresh(); await openTask(id); toast('已驳回，任务退回负责人重做')
  }, el)
  else if (a === 'split') guard(async () => {
    await api('POST', `/api/tasks/${id}/split`)
    await refresh(); hideDrawer()
    toast('已拆为两个子任务，父任务转为不计分的汇总节点')
  }, el)
  else if (a === 'closeOverdue') guard(async () => {
    const t = S.board.tasks.find((x) => x.id === id)
    await api('POST', `/api/tasks/${id}/close`, { reason: '逾期未交付' })
    await refresh(); hideDrawer()
    toast(`已按逾期关闭 · ${t?.assignee_name ?? ''} 扣 ${(Math.min(t?.overdue_days ?? 0, 7) * 0.5).toFixed(1)} 分`)
  }, el)
  else if (a === 'attend') guard(async () => {
    const meetingId = document.querySelector('#meetingPick')?.value
    if (!meetingId) { toast('请先创建一场会议'); return }
    await api('POST', '/api/attendance', { meetingId, targetUserId: el.dataset.u, kind: el.dataset.k })
    await refresh(); toast('已记录到这场会议')
  }, el)
})

document.addEventListener('submit', (e) => {
  const f = e.target.closest('[data-act]')
  if (!f) return
  e.preventDefault()
  const a = f.dataset.act
  const v = form(f)
  const btn = f.querySelector('button')

  if (a === 'doCreate') guard(async () => { await api('POST', '/api/groups', v); location.href = '/' }, btn)
  else if (a === 'doMeeting') guard(async () => {
    await api('POST', '/api/meetings', v); await refresh(); toast('会议已创建，可以去记出勤了')
  }, btn)
  else if (a === 'doJoin') guard(async () => { await api('POST', '/api/join', v); location.href = '/' }, btn)
  else if (a === 'doCreateTask') guard(async () => {
    await api('POST', '/api/tasks', { ...v, assigneeId: v.assigneeId || null })
    hideDrawer()
    await refresh(); toast('任务已创建')
  }, btn)
  else if (a === 'doDispute') guard(async () => { await api('POST', '/api/disputes', v); await refresh(); toast('仲裁已生效，结算单已重算') }, btn)
  else if (a === 'doInvite') guard(async () => {
    const r = await api('POST', '/api/invites', v)
    const url = `${location.origin}${r.url}`
    $('#inviteOut').innerHTML = `<p class="note" style="margin:12px 0 0">发给 TA，用过即废：<br><code>${esc(url)}</code><br>
      <a class="btn s" style="margin-top:8px" href="${esc(url)}">自己打开看看</a></p>`
    toast('邀请已生成')
  }, btn)
})

$('#mask').addEventListener('click', () => { hideDrawer() })
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideDrawer() } })

/* ------------------------------------------------------------------ 启动 */

;(async () => {
  try { S.me = await api('GET', '/api/session') } catch { S.me = null }
  if (S.me) { await refresh() } else { render() }
})()
