alter table if exists public.users
  add column if not exists no_show_streak integer not null default 0,
  add column if not exists suspended_until timestamptz null,
  add column if not exists suspension_reason text null,
  add column if not exists suspension_origin text null,
  add column if not exists suspension_created_at timestamptz null;

create index if not exists idx_users_group_role on public.users(group_id, role);
create index if not exists idx_users_suspended_until on public.users(suspended_until);