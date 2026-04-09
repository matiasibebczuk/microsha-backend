-- Persist staff groups, memberships, and trip-group assignments in Supabase.
-- This avoids losing group context when local file storage is reset.
-- Compatible with existing databases where public.staff_groups.id might be integer.

do $$
declare
  staff_groups_id_type text;
begin
  -- 1) Ensure staff_groups exists.
  if to_regclass('public.staff_groups') is null then
    create table public.staff_groups (
      id text primary key,
      name text not null unique,
      password_hash text not null,
      created_by text,
      created_at timestamptz not null default now()
    );
  end if;

  -- 2) Ensure required columns exist (for old schemas).
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'staff_groups' and column_name = 'name'
  ) then
    alter table public.staff_groups add column name text;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'staff_groups' and column_name = 'password_hash'
  ) then
    alter table public.staff_groups add column password_hash text;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'staff_groups' and column_name = 'created_by'
  ) then
    alter table public.staff_groups add column created_by text;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'staff_groups' and column_name = 'created_at'
  ) then
    alter table public.staff_groups add column created_at timestamptz;
    update public.staff_groups set created_at = now() where created_at is null;
    alter table public.staff_groups alter column created_at set default now();
  end if;

  -- 3) Detect id type from existing staff_groups.
  select format_type(a.atttypid, a.atttypmod)
    into staff_groups_id_type
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'staff_groups'
    and a.attname = 'id'
    and a.attnum > 0
    and not a.attisdropped;

  if staff_groups_id_type is null then
    raise exception 'public.staff_groups.id not found';
  end if;

  -- 4) Create memberships/trip_groups with compatible FK type.
  execute format(
    'create table if not exists public.staff_group_memberships (
       user_id text primary key,
       role text not null,
       group_id %s not null references public.staff_groups(id) on delete cascade,
       updated_at timestamptz not null default now()
     )',
    staff_groups_id_type
  );

  execute format(
    'create table if not exists public.trip_groups (
       trip_id bigint primary key references public.trips(id) on delete cascade,
       group_id %s not null references public.staff_groups(id) on delete cascade,
       updated_at timestamptz not null default now()
     )',
    staff_groups_id_type
  );
end
$$;

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
