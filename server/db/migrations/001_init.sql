-- 谁在干活 · 001_init
-- 设计要点：
--   1. events 只追加，不可改不可删不可清空（触发器强制）
--   2. server_time 由数据库生成，客户端传什么都没用（触发器强制）
--   3. 只有叶子任务计分（has_children = false），拆包不会凭空造分
--   4. ledger 是纯派生表，任何时刻可以删掉从 events 重算出同样的结果
--   5. 验收奖不计入总分，只单独展示 —— 否则组长既派活又验收，等于裁判当选手

-- ============ 枚举 ============
create type member_role as enum ('owner','member','auditor');
create type task_status as enum ('todo','doing','review','done','closed');
create type event_type as enum (
  'group_created','member_joined',
  'task_created','task_weighted','dispatched','claimed','declined','no_response',
  'submitted','review_accepted','review_rejected','split','reassigned',
  'dispute_opened','dispute_decided','checkin','absence_recorded'
);

-- ============ 身份（无密码：一次性邀请链接即凭证）============
create table users (
  id           uuid primary key default gen_random_uuid(),
  display_name text not null,
  created_at   timestamptz not null default now()
);

-- 学号后四位只存哈希，用于同组去重与身份绑定，不可反查
create table user_identities (
  user_id   uuid primary key references users(id) on delete cascade,
  code_hash text not null
);

create table groups (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  course     text,
  owner_id   uuid not null references users(id),
  created_at timestamptz not null default now()
);

create table memberships (
  group_id  uuid not null references groups(id) on delete cascade,
  user_id   uuid not null references users(id) on delete cascade,
  role      member_role not null default 'member',
  active    boolean not null default true,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create table invites (
  token        uuid primary key default gen_random_uuid(),
  group_id     uuid not null references groups(id) on delete cascade,
  invitee_name text not null,
  code4        char(4) not null,
  role         member_role not null default 'member',
  created_by   uuid not null references users(id),
  used_at      timestamptz,
  expires_at   timestamptz not null default now() + interval '7 days'
);

-- ============ 任务 ============
create table tasks (
  id           uuid primary key default gen_random_uuid(),
  group_id     uuid not null references groups(id) on delete cascade,
  parent_id    uuid references tasks(id),
  title        text not null,
  points       numeric(6,2) not null check (points > 0 and points <= 20),
  assignee_id  uuid references users(id),
  status       task_status not null default 'todo',
  blocked_by   uuid references tasks(id),
  due_date     date,
  has_children boolean not null default false,   -- true = 汇总节点，不计分
  created_by   uuid not null references users(id),
  created_at   timestamptz not null default now(),
  constraint no_self_block check (blocked_by is null or blocked_by <> id)
);
create index on tasks (group_id, status);
create index on tasks (parent_id);

-- ============ 事件流（只追加）============
create table events (
  seq         bigserial primary key,
  group_id    uuid not null references groups(id) on delete cascade,
  actor_id    uuid not null references users(id),
  task_id     uuid references tasks(id),
  type        event_type not null,
  payload     jsonb not null default '{}'::jsonb,
  server_time timestamptz not null default now()
);
create index on events (group_id, seq);
create index on events (task_id);
create index on events (actor_id, server_time);

-- 触发器名按字母顺序执行：a_ 先固定时间戳，b_ 再校验签名所需的字段已就绪
create or replace function force_server_time() returns trigger language plpgsql as $$
begin
  new.server_time := now();          -- 客户端传的时间一律丢弃
  return new;
end $$;
create trigger events_a_server_time before insert on events
  for each row execute function force_server_time();

create or replace function block_event_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'events is append-only: % is forbidden', tg_op;
end $$;
create trigger events_b_no_update before update on events
  for each row execute function block_event_mutation();
create trigger events_c_no_delete before delete on events
  for each row execute function block_event_mutation();
create trigger events_d_no_truncate before truncate on events
  for each statement execute function block_event_mutation();

-- 插入子任务时，把父任务标成汇总节点（父任务从此不计分）
create or replace function mark_parent_as_branch() returns trigger language plpgsql as $$
begin
  if new.parent_id is not null then
    update tasks set has_children = true where id = new.parent_id;
  end if;
  return new;
end $$;
create trigger tasks_child_link after insert on tasks
  for each row execute function mark_parent_as_branch();

-- ============ 派生账本 ============
create table ledger (
  group_id    uuid not null references groups(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  delivered   numeric(8,2) not null default 0,
  review_bonus numeric(8,2) not null default 0,
  attendance  numeric(8,2) not null default 0,
  adjustment  numeric(8,2) not null default 0,
  points      numeric(8,2) not null default 0,
  computed_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
comment on column ledger.review_bonus is '验收他人产出的动作分：仅作独立指标展示，不计入 points';

-- 占比：以「正分总和」为分母归一化。
-- 仲裁或扣分可能把人打成 0 分甚至负分，若用全员总和当分母，
-- 正负一抵消就可能得到 0 或负数，占比会直接失真。
create view ledger_pct as
select group_id, user_id, delivered, review_bonus, attendance, adjustment,
       points, computed_at,
       case when total = 0 then 0 else points / total * 100 end as pct
from (
  select *, sum(case when points > 0 then points else 0 end) over (partition by group_id) as total
  from ledger
) s;
