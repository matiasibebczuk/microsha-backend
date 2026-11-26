-- Send scoped invalidation events to authenticated staff clients.
-- Event payloads contain no passenger data; clients re-fetch through the API.

create table if not exists public.microsha_sync_events (
  id bigint generated always as identity primary key,
  group_id text not null,
  module text not null check (
    module in ('trips', 'reservations', 'attendance', 'history', 'sanctions')
  ),
  scope_key text not null,
  trip_id bigint,
  source_table text not null,
  change_type text not null check (change_type in ('INSERT', 'UPDATE', 'DELETE')),
  created_at timestamptz not null default now()
);

create index if not exists idx_microsha_sync_events_scope_created
  on public.microsha_sync_events (scope_key, created_at desc);

alter table public.microsha_sync_events enable row level security;
revoke all on public.microsha_sync_events from anon, authenticated;
grant select on public.microsha_sync_events to authenticated;
grant all on public.microsha_sync_events to service_role;
grant usage, select on sequence public.microsha_sync_events_id_seq to service_role;

create or replace function public.can_read_microsha_sync_group(p_group_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.staff_group_memberships m
     where m.user_id = auth.uid()::text
       and m.group_id::text = p_group_id
  );
$$;

revoke all on function public.can_read_microsha_sync_group(text)
  from public, anon, authenticated;
grant execute on function public.can_read_microsha_sync_group(text)
  to authenticated;

drop policy if exists "staff read own group sync events"
  on public.microsha_sync_events;
create policy "staff read own group sync events"
  on public.microsha_sync_events
  for select
  to authenticated
  using (public.can_read_microsha_sync_group(group_id));

create or replace function public.emit_microsha_sync_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row jsonb;
  v_trip_id bigint;
  v_group_id text;
  v_module text;
  v_trip record;
  v_history_run_id bigint;
begin
  v_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;

  if tg_table_name = 'trips' then
    v_trip_id := nullif(v_row->>'id', '')::bigint;
    v_module := 'trips';
  elsif tg_table_name = 'trip_groups' then
    v_trip_id := nullif(v_row->>'trip_id', '')::bigint;
    v_group_id := nullif(v_row->>'group_id', '');
    v_module := 'trips';
    if tg_op = 'UPDATE' and old.group_id::text is distinct from v_group_id then
      insert into public.microsha_sync_events (
        group_id, module, scope_key, trip_id, source_table, change_type
      ) values (
        old.group_id::text,
        'trips',
        old.group_id::text || ':trips',
        v_trip_id,
        tg_table_name,
        tg_op
      );
    end if;
  elsif tg_table_name in ('trip_stops', 'trip_buses', 'trip_reinforcement_configs') then
    v_trip_id := coalesce(
      nullif(v_row->>'trip_id', '')::bigint,
      nullif(v_row->>'parent_trip_id', '')::bigint
    );
    v_module := 'trips';
  elsif tg_table_name = 'stops' then
    for v_trip in
      select distinct ts.trip_id, tg.group_id::text as group_id
        from public.trip_stops ts
        join public.trip_groups tg on tg.trip_id = ts.trip_id
       where ts.stop_id::text = nullif(v_row->>'id', '')
    loop
      insert into public.microsha_sync_events (
        group_id, module, scope_key, trip_id, source_table, change_type
      ) values (
        v_trip.group_id,
        'trips',
        v_trip.group_id || ':trips',
        v_trip.trip_id,
        tg_table_name,
        tg_op
      );
    end loop;
    return null;
  elsif tg_table_name = 'buses' then
    for v_trip in
      select distinct tb.trip_id, tg.group_id::text as group_id
        from public.trip_buses tb
        join public.trip_groups tg on tg.trip_id = tb.trip_id
       where tb.bus_id = nullif(v_row->>'id', '')::bigint
    loop
      insert into public.microsha_sync_events (
        group_id, module, scope_key, trip_id, source_table, change_type
      ) values (
        v_trip.group_id,
        'trips',
        v_trip.group_id || ':trips',
        v_trip.trip_id,
        tg_table_name,
        tg_op
      );
    end loop;
    return null;
  elsif tg_table_name = 'reservations' then
    v_trip_id := nullif(v_row->>'trip_id', '')::bigint;
    v_module := 'reservations';
  elsif tg_table_name = 'trip_runs' then
    v_trip_id := nullif(v_row->>'trip_id', '')::bigint;
    v_module := 'attendance';
  elsif tg_table_name in ('trip_run_passengers', 'trip_run_unregistered_passengers') then
    select r.trip_id
      into v_trip_id
      from public.trip_runs r
     where r.id = coalesce(
       nullif(v_row->>'run_id', '')::bigint,
       nullif(v_row->>'trip_run_id', '')::bigint
     );
    v_module := 'attendance';
  elsif tg_table_name = 'trip_history_runs' then
    v_trip_id := nullif(v_row->>'trip_id', '')::bigint;
    v_group_id := nullif(v_row->>'group_id', '');
    v_module := 'history';
  elsif tg_table_name = 'trip_history_passengers' then
    v_history_run_id := nullif(v_row->>'history_run_id', '')::bigint;
    select h.trip_id, h.group_id::text
      into v_trip_id, v_group_id
      from public.trip_history_runs h
     where h.id = v_history_run_id;
    v_module := 'history';
  elsif tg_table_name = 'users' then
    v_group_id := coalesce(
      nullif(v_row->>'group_number', ''),
      nullif(v_row->>'organization_id', '')
    );
    v_module := 'sanctions';
  else
    return null;
  end if;

  if v_module is null then
    return null;
  end if;

  if v_group_id is null and v_trip_id is not null then
    select tg.group_id::text
      into v_group_id
      from public.trip_groups tg
     where tg.trip_id = v_trip_id;
  end if;

  if v_group_id is not null then
    insert into public.microsha_sync_events (
      group_id, module, scope_key, trip_id, source_table, change_type
    ) values (
      v_group_id,
      v_module,
      v_group_id || ':' || v_module,
      v_trip_id,
      tg_table_name,
      tg_op
    );
  end if;

  return null;
end;
$$;

revoke all on function public.emit_microsha_sync_event()
  from public, anon, authenticated;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'trips',
    'trip_groups',
    'stops',
    'trip_stops',
    'trip_buses',
    'buses',
    'trip_reinforcement_configs',
    'reservations',
    'trip_runs',
    'trip_run_passengers',
    'trip_run_unregistered_passengers',
    'trip_history_runs',
    'trip_history_passengers'
  ]
  loop
    if to_regclass(format('public.%I', v_table)) is not null then
      execute format(
        'drop trigger if exists trg_microsha_sync_event on public.%I',
        v_table
      );
      execute format(
        'create trigger trg_microsha_sync_event after insert or update or delete on public.%I for each row execute function public.emit_microsha_sync_event()',
        v_table
      );
    end if;
  end loop;

  if to_regclass('public.users') is not null
     and (
       select count(*)
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'users'
          and column_name in ('suspended_until', 'suspension_reason', 'no_show_streak')
     ) = 3 then
    execute 'drop trigger if exists trg_microsha_sync_event_sanctions on public.users';
    execute 'create trigger trg_microsha_sync_event_sanctions after update of suspended_until, suspension_reason, no_show_streak on public.users for each row when (old.suspended_until is distinct from new.suspended_until or old.suspension_reason is distinct from new.suspension_reason or old.no_show_streak is distinct from new.no_show_streak) execute function public.emit_microsha_sync_event()';
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'microsha_sync_events'
  ) then
    alter publication supabase_realtime
      add table public.microsha_sync_events;
  end if;
end
$$;
