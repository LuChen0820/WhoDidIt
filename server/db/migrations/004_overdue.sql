-- 谁在干活 · 004_overdue
-- 补上立项书承诺、但一直没实现的第三类客观依据：逾期记录。
--
-- 关键设计：逾期是「事件」，不是「查询结果」。
-- 如果每次读看板时用 today > due_date 现算，那么一个人迟交 3 天后终于交付，
-- 他的历史就会随「你什么时候问」而改变 —— 账本不再可重放。
-- 所以迟交天数只能在任务终结的那一刻（被验收 或 被关闭）写进事件流，写一次。

alter type event_type add value if not exists 'overdue_recorded';

-- @split
-- 上面那行必须单独一个事务：Postgres 禁止在同一事务里「使用」刚新增的枚举值，
-- 而下面的索引定义正好引用了它。迁移器按 -- @split 切段执行。

-- 一个任务只允许有一条逾期事实，和出勤一样靠数据库兜底
create unique index overdue_once_per_task on events (task_id)
  where type = 'overdue_recorded';

-- 账本多一个独立列：逾期扣分不能和出勤混在一起，否则看不出是被什么扣的
alter table ledger add column overdue numeric(8,2) not null default 0;

comment on column ledger.overdue is '迟交扣分：−0.5 × 迟交自然日数，单任务最多扣 7 天';

-- 001 里定义的视图列是写死的。CREATE OR REPLACE VIEW 只允许在末尾追加列、
-- 不允许改名或换序，所以这里必须先 drop 再建。
drop view if exists ledger_pct;
create view ledger_pct as
select group_id, user_id, delivered, review_bonus, attendance, overdue, adjustment,
       points, computed_at,
       case when total = 0 then 0 else points / total * 100 end as pct
from (
  select *, sum(case when points > 0 then points else 0 end) over (partition by group_id) as total
  from ledger
) s;
