-- Persist staff groups, memberships, and trip-group assignments in Supabase.
-- This avoids losing group context when local file storage is reset.

create table if not exists public.staff_groups (
  id text primary key,
  name text not null unique,
  password_hash text not null,
  created_by text,
  created_at timestamptz not null default now()
);

create table if not exists public.staff_group_memberships (
  user_id text primary key,
  role text not null,
  group_id text not null references public.staff_groups(id) on delete cascade,
  updated_at timestamptz not null default now()
);

create table if not exists public.trip_groups (
  trip_id bigint primary key references public.trips(id) on delete cascade,
  group_id text not null references public.staff_groups(id) on delete cascade,
  updated_at timestamptz not null default now()
);

create index if not exists idx_staff_group_memberships_group_id
  on public.staff_group_memberships(group_id);

create index if not exists idx_trip_groups_group_id
  on public.trip_groups(group_id);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_staff_group_memberships_updated_at on public.staff_group_memberships;
create trigger trg_staff_group_memberships_updated_at
before update on public.staff_group_memberships
for each row
execute function public.touch_updated_at();

drop trigger if exists trg_trip_groups_updated_at on public.trip_groups;
create trigger trg_trip_groups_updated_at
before update on public.trip_groups
for each row
execute function public.touch_updated_at();
