# 《谁在干活》产品级技术方案 v1.0

> 定位：从可点击原型升级为**真实可用、有真实用户在跑**的系统。
> 使用者：本人所在小组（W1 起 dogfooding），W3 起 2–3 个隔壁组。
> 部署：学生 VPS 自建。后端 Node + Postgres，前端 Vue 3 PWA。

---

## 0. 一句话架构

**一条只追加的事件流，派生出一份可重放的贡献账本。**
所有分数都不是被"写"出来的，是被"算"出来的——这是"可复核"这个卖点唯一的技术底座。

```
浏览器 (Vue3 PWA)
   │  HTTPS + 短期 JWT
   ▼
Node 20 / Fastify  ──►  Postgres 16   (events 表只 INSERT)
   │                        │
   │ 服务端生成时间戳+HMAC   │ 触发器/物化视图
   ▼                        ▼
 Caddy (TLS, 反代, 静态)  ledger (派生账本, 可全量重算)
```

---

## ⚠️ 1. 关键路径警告：备案比写代码慢

**域名解析到中国大陆服务器必须完成 ICP 备案，通常 7–20 天，且需要你先有域名 + 云厂商实名。** 这不在你的代码控制范围内，但它决定你能不能用 HTTPS 给同学用。

| 时段 | 方案 | 说明 |
|---|---|---|
| W1–W2 | **VPS 公网 IP + 端口直连（HTTP）** | 立刻可跑，仅限课程内使用。写进文档：「生产化需备案域名 + TLS」 |
| 并行 | 申请备案（若学校/学院有已备案域名，挂子域名最快，常可 3–5 天） | **W1 第一天就去问，这是最长的等待项** |
| W3+ | 已备案域名 + Caddy 自动签发 Let's Encrypt | 正式给同学用 |

**不要用 IP 硬撑到答辩**：没有 HTTPS，PWA 装不上、剪贴板与通知 API 受限、同学看到"不安全"红字会直接关掉——而"同学真的在用"是你整个方案最有价值的那一条。

**次优兜底**：若备案彻底走不通，退到「校园网内网 IP 访问」或改用海外节点（牺牲速度换 HTTPS）。这两个都比没有 HTTPS 好。

---

## 2. 技术栈（定死，不再讨论）

| 层 | 选型 | 理由 |
|---|---|---|
| 运行时 | Node 20 LTS + TypeScript | 类型对事件流的 union type 帮助很大 |
| API | Fastify | 比 Express 快，schema 校验内置（JSON Schema 直接生成 OpenAPI） |
| 数据库 | PostgreSQL 16 | **必须**：需要 `jsonb`、生成列、行级安全、触发器 |
| ORM | Drizzle | 轻量、SQL 可控、迁移文件可读（不要 Prisma，事件流要精细控制） |
| 鉴权 | 自建 session + JWT（15 分钟短时） | 不接第三方 OAuth，校园场景没有可信 IdP |
| 前端 | Vue 3 + Vite + Pinia + Tailwind | 原型的视觉与交互可近乎直接迁移 |
| 实时更新 | SSE（`text/event-stream`） | 比 WebSocket 简单，单向推送够用，Caddy 需 `flush` 配置 |
| 部署 | Docker Compose + Caddy | 一条 `docker compose up -d` 完成，备份面小 |
| 备份 | 每日 `pg_dump` + 异地拉取 | 见 §9 |

**不做**：Kubernetes、微服务、Redis（单机 Postgres 完全够 20 人）、消息队列。

---

## 3. 数据库 Schema

```sql
create type member_role  as enum ('owner','member','auditor');
create type task_status  as enum ('todo','doing','review','done','blocked','closed');
create type event_type   as enum (
  'group_created','member_joined',
  'task_created','task_weighted','dispatched','claimed','declined','no_response',
  'submitted','review_accepted','review_rejected','split','reassigned',
  'dispute_opened','dispute_decided','absence_recorded','checkin'
);

/* ---------- 身份 ---------- */
create table users (
  id            uuid primary key default gen_random_uuid(),
  display_name  text not null,
  pwd_hash      text not null,                 -- argon2id
  created_at    timestamptz not null default now()
);

-- 学号只存哈希，用于同组去重与身份绑定，不可反查
create table user_identities (
  user_id   uuid primary key references users(id),
  code_hash text not null                      -- sha256(salt + 学号后四位 + 姓名)
);

create table groups (
  id uuid primary key default gen_random_uuid(),
  name text not null, course text, owner_id uuid not null references users(id),
  created_at timestamptz not null default now()
);

create table memberships (
  group_id uuid references groups(id), user_id uuid references users(id),
  role member_role not null default 'member',
  joined_at timestamptz not null default now(), active bool not null default true,
  primary key (group_id, user_id)
);

-- 一次性邀请链接：绑定「姓名 + 学号后四位」，杜绝自称他人
create table invites (
  token uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id),
  invitee_name text not null, code4 char(4) not null,
  role member_role not null default 'member',
  used_at timestamptz, expires_at timestamptz not null default now() + interval '7 days'
);

/* ---------- 任务 ---------- */
create table tasks (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id),
  parent_id uuid references tasks(id),
  title text not null,
  points numeric(5,2) not null check (points > 0 and points <= 10),
  assignee_id uuid references users(id),
  status task_status not null default 'todo',
  blocked_by uuid references tasks(id),
  due_date date,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 反自环：不能阻塞自己
  constraint no_self_block check (blocked_by is null or blocked_by <> id)
);
create index on tasks (group_id, status);
create index on tasks (parent_id);

/* ---------- 事件流（只追加） ---------- */
create table events (
  seq          bigserial primary key,
  group_id     uuid not null references groups(id),
  actor_id     uuid not null references users(id),
  task_id      uuid references tasks(id),
  type         event_type not null,
  payload      jsonb not null default '{}',
  server_time  timestamptz not null default now(),   -- 客户端时间一律不信
  sig          bytea not null                        -- HMAC-SHA256(seq|actor|task|type|server_time|payload)
);
create index on events (group_id, server_time);
create index on events (task_id);
create index on events (actor_id, server_time);

-- 只追加：物理剥夺改删权限
revoke UPDATE, DELETE, TRUNCATE on events from public;
create or replace function block_event_mutation() returns trigger language plpgsql as $$
  begin raise exception 'events is append-only'; end $$;
create trigger events_immutable before update or delete on events
  for each row execute function block_event_mutation();
```

---

## 4. 权限矩阵（服务端强校验，不靠前端）

| 动作 | owner | member | auditor(教师) |
|---|---|---|---|
| 建任务 / 定权重 | ✓ | ✗ |  |
| 指派任务给他人 | ✓ | ✗ |  |
| 认领任务 | ✓ | ✓ | ✗ |
| **拒绝指派** | ✗ | ✓（留痕） | ✗ |
| 提交产出 | ✓ | ✓（仅自己的） | ✗ |
| **验收他人任务** | ✓ | ✓ | ✗ |
| **验收自己任务** | **✗** | **✗** | ✗ |
| 裁决异议 | ✓ | ✗ | ✓（终裁） |
| 记缺席 | ✓ | ✗ |  |
| 看结算单 / 导出 | ✓ | ✓ | ✓ |

**两条必须写在服务端、且要单测覆盖的不变量：**
```
1. review_accepted 事件的 actor_id  必须 !=  task.assignee_id
2. 任何写事件的请求，actor_id  只取自 session，永不取自请求体
```
第 2 条是整个可信体系的命门——如果客户端能声明"我是陈昊"，事件流就一文不值。

---

## 5. 账本派生规则（本产品的算法核心）

```
score(user) =
    Σ tasks.points            其中 task.is_leaf = true 且 assignee = user 且被他人 review_accepted
  + Σ attendance_score        签到 +0.5 − 缺席 ×1.5
  + Σ adjustment_delta        仲裁带来的转移分

不计入总分、单独展示的指标：
    review_bonus              验收他人产出的动作数 × 0.5（每周上限 9）
```

> **为什么验收奖不计分（实现后才发现的设计缺陷）**
> 第一版把验收奖计入了总分，真实场景跑出来组长一个人做了 7 次验收，3.5 分验收奖占到他总分的 37%。
> 也就是说：**谁掌握验收权，谁就在给自己打分**——这和"不互评是为了避免人情分"的初衷直接冲突。
> 所以验收奖改为只记录、只展示，不进排名。管理成本值得被看见，但不该被换算成权重，
> 否则组长既是裁判又是选手。这条已固化为测试：`验收奖不计入总分：组长验收三次，一分未得`。

### 三条不可动摇的规则

**① 只有叶子任务计分（防拆包刷分）**
```sql
create table task_leaf as
select t.id, not exists (select 1 from tasks c where c.parent_id = t.id) as is_leaf
from tasks t;
-- 或用生成列 + 触发器在插入子任务时把父任务 is_leaf 置 false
```
父任务的分数 = 子任务求和，**只在视图层展示，不进账本**。否则拆一次包凭空造一倍分，"不互评、只认事实"这条主张立刻作废。

**② 修正用追加，不用覆盖**
仲裁产生一条 `dispute_decided` 事件 + 一条 `adjustment`，原始 `events` 一行都不动。被翻案的痕迹永远可见——这是结算单合法性的来源。

**③ 全量可重放**
`ledger` 表只是缓存。任何时候 `truncate ledger` 后从 `events` 重算，必须得到逐字节相同的结果。**这条要写成测试，不是口头承诺。**

### 反作弊上限
| 攻击 | 防线 |
|---|---|
| 刷空提交 | 分数只在他人验收后产生 |
| 串谋互验 | 单人每周验收动作上限 18 次；A↔B 互验占比 > 70% 进风险面板 |
| 改本地时间 | `server_time` 服务端生成 |
| 认领后挂名不干 | `no_response`（48h 无提交）自动收回认领位并留痕 |
| 拆任务造分 | 规则 ①，DB 层约束 |

> 答辩用句：**"我们不追求不可作弊，我们让作弊成本高于好好干活。"**

---

## 6. API 表面（REST，全部要求 JWT）

```
POST   /auth/register            姓名 + 学号后四位 + 密码
POST   /auth/login               → 15min JWT + refresh cookie
POST   /invites/:token/accept    消费一次性邀请
POST   /groups                   建组
POST   /groups/:id/tasks         建任务（owner）
PATCH  /tasks/:id/claim          认领
PATCH  /tasks/:id/dispatch       指派（owner）
PATCH  /tasks/:id/decline        拒绝（member，留痕）
POST   /tasks/:id/submit         提交产出（含 links[]）
POST   /tasks/:id/accept         验收（服务端校验 actor != assignee）
POST   /tasks/:id/split          拆包，points 均分到子任务
POST   /groups/:id/disputes      发起异议
POST   /disputes/:id/decide      裁决（owner/auditor）→ 写 adjustment
GET    /groups/:id/ledger        当前结算
GET    /groups/:id/events?since= 事件流（供前端 SSE 与导出）
GET    /groups/:id/report.pdf    教师版文书
GET    /groups/:id/export.csv    原始事件流 + ledger_hash
POST   /internal/recompute       重放校验（运维用，需 admin token）
```

**SSE**：`GET /groups/:id/stream`，任何写事件后向该组所有连接广播 `{type, seq}`，前端收到即拉增量。**不做乐观更新**——账本以服务端为准，宁可慢半拍也不能显示一个假数字。

---

## 7. 可复核性：导出与校验码

```
ledger_hash = sha256( concat(events ordered by seq:
                seq | actor_id | task_id | type | server_time_iso | canonical_json(payload)) )
```
- 放进 CSV 头部注释、PDF 页脚、教师版文书三处。
- 任何人（包括老师）可下载 CSV，用附带的 30 行校验脚本重算哈希，比对一致 ⇒ **证明这份结算单事后没被改过**。
- 成本约 20 行代码，是"可复核"从口号变成可验证事实的唯一一步。**答辩必演示。**

---

## 8. W1 任务分解（自己组真的用起来）

- [ ] **D1** 买 VPS（2C2G 学生机）+ 问学院有没有可挂子域名的已备案域名 ← **今天做，备案是最长等待项**
- [ ] **D1** Docker Compose 起 Postgres + Caddy，IP:80 能开
- [ ] **D2** 迁移脚本跑通 §3 全部 schema；`events` append-only 约束与触发器验证
- [ ] **D2** 注册 / 登录 / 一次性邀请链接，绑定姓名+学号后四位
- [ ] **D3** 任务 CRUD + 认领 / 提交 / 验收，每次写一条事件
- [ ] **D4** 账本派生 + `ledger` 表 + 重放测试（truncate 后重算结果一致）
- [ ] **D5** 前端迁移原型：看板 + 抽屉 + 结算单，接真 API
- [ ] **D5** **周会上真的用它派一次活**，手机能打开

W1 结束判据：**不是"代码写完了"，是"这周的任务全部记在系统里，而不是记在群里"。**

---

## 9. 运维底线（单人系统最容易死的地方）

- **每日备份**：cron `pg_dump` → gzip → scp 到自己电脑 / 网盘。**没有备份的 dogfooding 系统，一次删库就永久失去真实数据，也就失去了答辩最硬的那张牌。**
- 磁盘水位告警（VPS 通常 40–60G，日志会涨）
- `docker compose logs` + 一个 `/healthz` 端点
- 迁移前强制备份；所有迁移可回滚

---

## 10. 明确不做（写进答辩的范围裁剪）

原生 App、实时协同编辑、微信 bot 消息推送、多校区/多租户、成绩系统对接、AI 自动判分、复杂 RBAC 自定义角色。

> 理由统一成一句：**这些都不影响"贡献能否被追溯与翻案"这一条主张成立。**

---

## 11. 风险清单（按致死度排序）

| 风险 | 致死度 | 应对 |
|---|---|---|
| **同学根本不记录** | ★★★★★ | 30 秒录入原则；周日晚 AI 起草、人只确认；W1 判据就是"有没有真的用" |
| **备案阻塞导致无 HTTPS** | ★★★★ | §1 并行申请；兜底走内网或海外节点 |
| 单点故障，VPS 挂了没人管 | ★★★ | 每日备份 + 可 30 分钟重建；README 写清恢复步骤 |
| 被同学认为"监视工具"而抵触 | ★★★★ | 默认组内可见、不排名公示；扣分只挂客观逾期/缺席；**公开全部算法** |
| 权重由组长定 → 组长仍是权力中心 | ★★★ | 权重可申诉；异议终裁权给教师；权重变更记录进事件流 |
| 只有 1 个组的数据，结论以偏概全 | ★★ | 诚实标注样本量；本产品不做统计推断，只做事实归集 |

---

## 12. 与原型阶段的说法差异（答辩过渡句）

> "原型阶段我以为难点是多用户同步。真开始做才发现，同步是最容易的部分——**真正的墙是没人会去记录，以及身份必须可信**。所以我这一版把 80% 的精力放在了录入成本和事件不可篡改上，这两件事原型里都看不见。"

这句话本身就是从"学生作业"到"工程判断"的分界线。
