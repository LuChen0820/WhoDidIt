-- 谁在干活 · 002_sessions
-- 无密码登录：邀请链接 + 姓名 + 学号后四位 换取一个服务端 session
-- 库里只存 token 的 sha256，即使数据库泄露也无法反推可用 cookie

create table sessions (
  token_hash text primary key,
  user_id    uuid not null references users(id) on delete cascade,
  group_id   uuid not null references groups(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '90 days'
);
create index on sessions (user_id);
