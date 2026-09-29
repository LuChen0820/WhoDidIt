import { test, expect, type Page } from '@playwright/test'

/* 这些测试存在的理由：下面「导航」和「首屏无异常」两条防的 bug 都真实发生过 ——
   导航按钮缺 data-act（点了完全没反应）、app.js 里误写 TS 类型标注（浏览器整页白屏）。
   两者在 38 条单元测试 + 41 项 HTTP 冒烟全绿的情况下都溜过去了，因为它们不碰 DOM。 */

/** 只收真正的 JS 异常。/api/session 未登录返回 401 会打一条 "Failed to load resource"，那不是 bug。 */
function watchErrors(page: Page): string[] {
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text())
  })
  return errs
}

async function createGroup(page: Page, name: string, owner = '陈昊') {
  await page.goto('/')
  await page.fill('input[name=name]', name)
  await page.fill('input[name=course]', '软件工程')
  await page.fill('input[name=ownerName]', owner)
  await page.click('#entryPane .btn.p')
  await page.waitForSelector('#nav [data-v=board]')
}

/** 遮罩层 z-index 高于顶栏，抽屉开着时切 tab 会被拦截 —— 先关掉。
 *  用 Escape 而不是点遮罩：点法要和 hit-test 较劲，键盘路径是产品本来就支持的。 */
async function closeDrawer(page: Page) {
  if (await page.locator('#drawer.on').count()) {
    await page.keyboard.press('Escape')
    await expect(page.locator('#drawer')).not.toHaveClass(/(^| )on( |$)/)
  }
}

async function gotoTab(page: Page, v: string) {
  await closeDrawer(page)
  await page.click(`#nav [data-v=${v}]`)
  await page.waitForTimeout(120)
}

/** 通过邀请链接在另一个浏览器上下文里加入一名组员（cookie 与组长完全隔离） */
async function joinMember(owner: Page, name: string, code4: string) {
  const inv = await owner.request.post('/api/invites', { data: { name, code4 } })
  const { url } = await inv.json()
  // 用 page.url() 而不是 evaluate：evaluate 会撞上导航导致执行上下文被销毁
  const origin = new URL(owner.url()).origin
  const page = await owner.context().browser()!.newPage()
  await page.goto(origin + url)
  await page.fill('input[name=code4]', code4)
  await page.click('.entry .btn.p')
  await page.waitForSelector('#nav [data-v=board]')
  return page
}

async function idOf(page: Page, name: string) {
  const board = await (await page.request.get('/api/board')).json()
  return board.members.find((m: any) => m.name === name).user_id
}

/** 组长建组 + 拉进林嘉 + 派一个任务给她并提交完，返回双方页面与任务 id */
async function twoUsers(page: Page, project: string) {
  await createGroup(page, project)
  const member = await joinMember(page, '林嘉', '1234')
  const linId = await idOf(page, '林嘉')
  const t = await (
    await page.request.post('/api/tasks', {
      data: { title: '书籍搜索与筛选', points: 4, assigneeId: linId },
    })
  ).json()

  await member.reload()
  await member.click('.task:has-text("书籍搜索与筛选")')
  await member.fill('#link', 'https://figma.example/search')
  await member.click('[data-act=submit]')
  await member.waitForSelector('#drawer .kv:has-text("待验收")')
  // 收尾必须把抽屉关掉：遮罩层盖住整页，后续点击会被拦截
  await closeDrawer(member)
  // 组长这边的任务是用 API 建的，DOM 从没刷新过
  await page.reload()
  await page.waitForSelector('.task:has-text("书籍搜索与筛选")')
  return { owner: page, member, taskId: t.id }
}

/* ---------------- 首屏与导航 ---------------- */

test('首屏加载没有 JS 异常，入口表单可用', async ({ page }) => {
  const errs = watchErrors(page)
  await page.goto('/')
  await expect(page.locator('.entry h1')).toHaveText('谁在干活')
  await expect(page.locator('.tabs button')).toHaveCount(2)
  expect(errs, '首屏不应有任何未捕获异常').toEqual([])
})

test('建组后进入看板，组长身份与组名正确', async ({ page }) => {
  const errs = watchErrors(page)
  await createGroup(page, '校园二手书平台')
  await expect(page.locator('#whoName')).toContainText('陈昊（组长）')
  await expect(page.locator('#pjName')).toHaveText('校园二手书平台')
  await expect(page.locator('#app h1')).toHaveText('任务看板')
  expect(errs).toEqual([])
})

test('三个导航 tab 都能切换并渲染对应标题', async ({ page }) => {
  await createGroup(page, '导航回归项目')
  for (const [v, title] of [
    ['ledger', '贡献结算单'],
    ['team', '组员与会议'],
    ['board', '任务看板'],
  ] as [string, string][]) {
    await gotoTab(page, v)
    await expect(page.locator('#app h1'), `切到 ${v} 后标题应为「${title}」`).toHaveText(title)
    await expect(page.locator(`#nav [data-v=${v}]`)).toHaveClass(/\bon\b/)
  }
})

/* ---------------- 任务生命周期 ---------------- */

test('新建任务出现在待认领列', async ({ page }) => {
  await createGroup(page, '新建任务项目')
  await page.click('[data-act=newTask]')
  await page.fill('#drawer input[name=title]', '书籍搜索与筛选')
  await page.fill('#drawer input[name=points]', '3.5')
  await page.click('#drawer .btn.p')
  await expect(page.locator('#drawer')).not.toHaveClass(/on/)
  const todo = page.locator('.col').first()
  await expect(todo.locator('.task')).toHaveCount(1)
  await expect(todo.locator('.task .t')).toHaveText('书籍搜索与筛选')
})

test('跨用户：验收通过后占比真实重算，组长验收奖不计分', async ({ page }) => {
  const { owner } = await twoUsers(page, '跨用户项目')

  // 组长验收 —— 没有这一步，林嘉的交付分根本不会入账
  await owner.click('.task:has-text("书籍搜索与筛选")')
  await owner.click('[data-act=accept]')
  await owner.waitForSelector('.toast.on')
  await gotoTab(owner, 'ledger')

  const lin = owner.locator('.lrow', { hasText: '林嘉' })
  await expect(lin.locator('.pct')).toHaveText('100.0%')
  await expect(lin.locator('.chip', { hasText: '交付' })).toHaveText('交付 +4')

  const chen = owner.locator('.lrow', { hasText: '陈昊' })
  await expect(chen.locator('.pct')).toHaveText('—')
  await expect(chen.locator('.chip', { hasText: '验收他人' })).toHaveText('验收他人 0.5（不计分）')
})

test('验收之后遮罩必须一起关掉，否则整页点不动', async ({ page }) => {
  // 回归：accept / decline / split / 逾期关闭 四个处理器曾只关抽屉不关遮罩，
  // 用户验收完一次之后整个页面就再也点不了。HTTP 测试完全看不见这类问题。
  const { owner } = await twoUsers(page, '遮罩回归项目')
  await owner.click('.task:has-text("书籍搜索与筛选")')
  await owner.click('[data-act=accept]')
  await expect(owner.locator('#drawer')).not.toHaveClass(/\bon\b/)
  await expect(owner.locator('#mask')).not.toHaveClass(/\bon\b/)
  await owner.click('#nav [data-v=ledger]')
  await expect(owner.locator('#app h1')).toHaveText('贡献结算单')
})

test('负责人看不到验收按钮，组长看得到', async ({ page }) => {
  const { owner, member } = await twoUsers(page, '自验自计防线项目')

  await member.click('.task:has-text("书籍搜索与筛选")')
  await expect(member.locator('[data-act=accept]')).toHaveCount(0)
  await expect(member.locator('#drawer')).toContainText('不能验收自己负责的任务')

  await owner.click('.task:has-text("书籍搜索与筛选")')
  await expect(owner.locator('[data-act=accept]')).toHaveCount(1)
})

test('驳回退回重做，重做后只计一次分', async ({ page }) => {
  const { owner, member } = await twoUsers(page, '驳回流程项目')

  await owner.click('.task:has-text("书籍搜索与筛选")')
  await owner.fill('#rejWhy', '缺少空状态和错误提示')
  await owner.click('[data-act=reject]')
  await owner.waitForSelector('#drawer .kv:has-text("进行中")')

  await member.reload()
  await member.click('.task:has-text("书籍搜索与筛选")')
  await member.fill('#link', 'https://figma.example/search-v2')
  await member.click('[data-act=submit]')
  await member.waitForSelector('#drawer .kv:has-text("待验收")')

  await owner.reload()
  await owner.click('.task:has-text("书籍搜索与筛选")')
  await owner.click('[data-act=accept]')
  await gotoTab(owner, 'ledger')
  await expect(owner.locator('.lrow', { hasText: '林嘉' }).locator('.pct')).toHaveText('100.0%')
})

/* ---------------- 输入防线 ---------------- */

test('提交 javascript: 链接被拒并给出可读提示', async ({ page }) => {
  await createGroup(page, '链接白名单项目')
  const member = await joinMember(page, '王磊', '5678')
  const wangId = await idOf(page, '王磊')
  await page.request.post('/api/tasks', {
    data: { title: '部署与域名', points: 2, assigneeId: wangId },
  })

  await member.reload()
  await member.click('.task:has-text("部署与域名")')
  await member.fill('#link', 'javascript:alert(document.cookie)')
  await member.click('[data-act=submit]')
  await expect(member.locator('#toast')).toContainText('http/https', { timeout: 8000 })
})

test('净贡献为负的成员占比显示为 —，扣分单独一条', async ({ page }) => {
  await createGroup(page, '负分显示项目')
  await gotoTab(page, 'team')
  await page.fill('input[name=heldOn]', '2026-09-20')
  await page.click('[data-act=doMeeting] button')
  await page.waitForSelector('#meetingPick')

  await page.click('tr:has-text("陈昊") [data-k=absence_recorded]')
  await page.waitForSelector('.toast.on')

  await gotoTab(page, 'ledger')
  const chen = page.locator('.lrow', { hasText: '陈昊' })
  await expect(chen.locator('.pct')).toHaveText('—')
  await expect(chen.locator('.chip', { hasText: '出勤' })).toHaveText('出勤 -1.5')
})
