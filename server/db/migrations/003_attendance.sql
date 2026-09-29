-- 谁在干活 · 003_attendance
-- 修的是一个能摧毁可信度的洞：一次签到不对应任何一场具体的会议，
-- 所以组长连点 20 次「签到」就能把一个人刷到占比 100%。
--
-- 原则：每一个能加分的动作，都必须绑定一个具体的、不可重复的对象。
-- 这里把「对象」做成 meetings 表，并用数据库约束保证一人一会只有一条出勤事实。

create table meetings (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references groups(id) on delete cascade,
  held_on    date not null,
  note       text,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  -- 一天一场：重复建会直接被拒，而不是静默多出一场可刷分的会
  unique (group_id, held_on)
);

-- 事件表补上两个「对象」列：这条痕迹是关于哪场会、关于谁的
alter table events add column meeting_id uuid references meetings(id) on delete cascade;
alter table events add column subject_id uuid references users(id) on delete cascade;
create index on events (meeting_id);

-- 出勤类事件必须绑定会议和对象，否则不允许写入
alter table events add constraint attendance_needs_target check (
  type not in ('checkin','absence_recorded')
  or (meeting_id is not null and subject_id is not null)
);

-- 核心约束：一场会里一个人只能有一条出勤记录。
-- 想改错账不能靠再点一次，只能走仲裁（dispute_decided）——
-- 这样任何对已记账号的修改都留下一条可审计的记录。
create unique index attendance_one_per_person_per_meeting
  on events (meeting_id, subject_id)
  where type in ('checkin','absence_recorded');
