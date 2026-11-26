-- Durable, single-use BB8 previews, confirmations, and audit events.
-- The backend must use the service-role key and authenticate each admin request.

create table if not exists public.bb8_operations (
  id uuid primary key,
  actor_id text not null,
  group_id text not null check (group_id = '1926'),
  action jsonb not null,
  preview jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'succeeded', 'failed', 'cancelled', 'expired')),
  result jsonb,
  failure_code text,
  verification_success boolean,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_bb8_operations_actor_status_created
  on public.bb8_operations (actor_id, status, created_at desc);

create table if not exists public.bb8_audit_log (
  id bigserial primary key,
  operation_id uuid not null references public.bb8_operations(id),
  actor_id text not null,
  group_id text not null check (group_id = '1926'),
  event text not null
    check (event in ('preview_created', 'confirmed', 'failed', 'cancelled', 'expired')),
  action jsonb not null,
  details jsonb not null default '{}'::jsonb,
  succeeded boolean not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_bb8_audit_log_group_created
  on public.bb8_audit_log (group_id, created_at desc);

alter table public.bb8_operations enable row level security;
alter table public.bb8_audit_log enable row level security;
revoke all on public.bb8_operations from anon, authenticated;
revoke all on public.bb8_audit_log from anon, authenticated;
grant all on public.bb8_operations to service_role;
grant all on public.bb8_audit_log to service_role;
grant usage, select on sequence public.bb8_audit_log_id_seq to service_role;

create or replace function public.bb8_create_operation(
  p_id uuid,
  p_actor_id text,
  p_action jsonb,
  p_preview jsonb,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_trip_id bigint;
begin
  if p_id is null or nullif(trim(p_actor_id), '') is null
     or p_action is null or p_preview is null
     or p_expires_at <= now()
     or p_expires_at > now() + interval '5 minutes 10 seconds' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_OPERATION');
  end if;

  if p_action->>'type' = 'user_create' then
    if p_action->>'group_number' is distinct from '1926'
       or p_action->>'role' is distinct from 'pasajero'
       or nullif(trim(p_action->>'name'), '') is null
       or coalesce(p_action->>'dni', '') !~ '^\d{7,9}$'
       or coalesce(p_action->>'member_number', '') !~ '^(?:0|\d{6})$' then
      return jsonb_build_object('ok', false, 'code', 'INVALID_USER');
    end if;

    insert into public.bb8_operations (
      id, actor_id, group_id, action, preview, expires_at
    ) values (
      p_id, p_actor_id, '1926', p_action, p_preview, p_expires_at
    );

    insert into public.bb8_audit_log (
      operation_id, actor_id, group_id, event, action, details, succeeded
    ) values (
      p_id, p_actor_id, '1926', 'preview_created', p_action, p_preview, true
    );

    return jsonb_build_object('ok', true, 'status', 'pending');
  end if;

  if p_action->>'type' not in (
    'trip_set_start_time',
    'trip_cancel',
    'reservation_cancel'
  ) then
    return jsonb_build_object('ok', false, 'code', 'UNSUPPORTED_OPERATION');
  end if;

  begin
    v_trip_id := (p_action->>'trip_id')::bigint;
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'INVALID_TRIP_ID');
  end;

  if v_trip_id <= 0 or not exists (
    select 1
      from public.trips t
      join public.trip_groups tg on tg.trip_id = t.id
     where t.id = v_trip_id
       and tg.group_id::text = '1926'
  ) then
    return jsonb_build_object('ok', false, 'code', 'TRIP_OUTSIDE_CLUB');
  end if;

  if p_action->>'type' = 'reservation_cancel'
     and not exists (
       select 1 from public.trips
        where id = v_trip_id
          and status = 'open'
     ) then
    return jsonb_build_object('ok', false, 'code', 'TRIP_NOT_EDITABLE');
  end if;

  if p_action->>'type' = 'reservation_cancel'
     and exists (
       select 1 from public.trip_runs
        where trip_id = v_trip_id
          and finished_at is null
     ) then
    return jsonb_build_object('ok', false, 'code', 'TRIP_HAS_ACTIVE_RUN');
  end if;

  if p_action->>'type' = 'trip_set_start_time'
     and (
       coalesce(p_action->>'new_start_time', '') !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
       or not (p_action ? 'expected_start_time')
     ) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_TRIP_TIME');
  end if;

  if p_action->>'type' = 'trip_cancel'
     and (
       p_action->>'expected_status' is distinct from 'open'
       or p_action->>'new_status' is distinct from 'closed'
     ) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_TRIP_STATUS');
  end if;

  if p_action->>'type' = 'reservation_cancel'
     and (
       coalesce(p_action->>'reservation_id', '') !~ '^\d+$'
       or coalesce(p_action->>'user_id', '') = ''
       or p_action->>'expected_status' is null
       or p_action->>'expected_status' not in ('confirmed', 'waiting')
       or not exists (
         select 1
           from public.reservations r
           join public.users u on u.id = r.user_id
          where r.id::text = p_action->>'reservation_id'
            and r.trip_id = v_trip_id
            and r.user_id::text = p_action->>'user_id'
            and r.status = p_action->>'expected_status'
            and u.role = 'pasajero'
            and (
              u.group_number::text = '1926'
              or u.organization_id::text = '1926'
            )
       )
     ) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_RESERVATION');
  end if;

  insert into public.bb8_operations (
    id, actor_id, group_id, action, preview, expires_at
  ) values (
    p_id, p_actor_id, '1926', p_action, p_preview, p_expires_at
  );

  insert into public.bb8_audit_log (
    operation_id, actor_id, group_id, event, action, details, succeeded
  ) values (
    p_id, p_actor_id, '1926', 'preview_created', p_action, p_preview, true
  );

  return jsonb_build_object('ok', true, 'status', 'pending');
end;
$$;

create or replace function public.bb8_cancel_operation(
  p_id uuid,
  p_actor_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_operation public.bb8_operations%rowtype;
begin
  select *
    into v_operation
    from public.bb8_operations
   where id = p_id
   for update;

  if not found or v_operation.actor_id <> p_actor_id or v_operation.group_id <> '1926' then
    return jsonb_build_object('ok', false, 'code', 'OPERATION_NOT_FOUND');
  end if;

  if v_operation.status <> 'pending' then
    return jsonb_build_object('ok', false, 'code', 'OPERATION_ALREADY_HANDLED', 'status', v_operation.status);
  end if;

  if v_operation.expires_at <= now() then
    update public.bb8_operations
       set status = 'expired', completed_at = now()
     where id = p_id;
    insert into public.bb8_audit_log (
      operation_id, actor_id, group_id, event, action, details, succeeded
    ) values (
      p_id, p_actor_id, '1926', 'expired', v_operation.action,
      jsonb_build_object('reason', 'preview_expired'), false
    );
    return jsonb_build_object('ok', false, 'code', 'OPERATION_EXPIRED', 'status', 'expired');
  end if;

  update public.bb8_operations
     set status = 'cancelled', completed_at = now()
   where id = p_id;

  insert into public.bb8_audit_log (
    operation_id, actor_id, group_id, event, action, details, succeeded
  ) values (
    p_id, p_actor_id, '1926', 'cancelled', v_operation.action,
    jsonb_build_object('reason', 'admin_cancelled'), true
  );

  return jsonb_build_object('ok', true, 'status', 'cancelled');
end;
$$;

create or replace function public.bb8_fail_operation(
  p_id uuid,
  p_actor_id text,
  p_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_action jsonb;
begin
  update public.bb8_operations
     set status = 'failed', failure_code = p_code, completed_at = now()
   where id = p_id
     and actor_id = p_actor_id
     and group_id = '1926'
     and status = 'pending'
  returning action into v_action;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'OPERATION_ALREADY_HANDLED');
  end if;

  insert into public.bb8_audit_log (
    operation_id, actor_id, group_id, event, action, details, succeeded
  ) values (
    p_id, p_actor_id, '1926', 'failed', v_action,
    jsonb_build_object('code', p_code), false
  );

  return jsonb_build_object('ok', false, 'code', p_code, 'status', 'failed');
end;
$$;

create or replace function public.bb8_execute_operation(
  p_id uuid,
  p_actor_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_operation public.bb8_operations%rowtype;
  v_trip_id bigint;
  v_trip public.trips%rowtype;
  v_user public.users%rowtype;
  v_new_start_time text;
  v_dni text;
  v_reservation_id bigint;
  v_reservation_status text;
  v_reservation_user_id text;
  v_user_name text;
  v_user_description text;
  v_result jsonb;
begin
  select *
    into v_operation
    from public.bb8_operations
   where id = p_id
   for update;

  if not found or v_operation.actor_id <> p_actor_id or v_operation.group_id <> '1926' then
    return jsonb_build_object('ok', false, 'code', 'OPERATION_NOT_FOUND');
  end if;

  if v_operation.status = 'succeeded' then
    return jsonb_build_object(
      'ok', true,
      'status', 'succeeded',
      'result', v_operation.result
    );
  end if;

  if v_operation.status <> 'pending' then
    return jsonb_build_object(
      'ok', false,
      'code', 'OPERATION_ALREADY_HANDLED',
      'status', v_operation.status,
      'result', v_operation.result
    );
  end if;

  if v_operation.expires_at <= now() then
    update public.bb8_operations
       set status = 'expired', completed_at = now(), failure_code = 'OPERATION_EXPIRED'
     where id = p_id;
    insert into public.bb8_audit_log (
      operation_id, actor_id, group_id, event, action, details, succeeded
    ) values (
      p_id, p_actor_id, '1926', 'expired', v_operation.action,
      jsonb_build_object('reason', 'preview_expired'), false
    );
    return jsonb_build_object('ok', false, 'code', 'OPERATION_EXPIRED', 'status', 'expired');
  end if;

  if v_operation.action->>'type' = 'user_create' then
    v_dni := v_operation.action->>'dni';
    perform pg_advisory_xact_lock(hashtext(v_dni));
    if exists (select 1 from public.users where dni = v_dni) then
      return public.bb8_fail_operation(p_id, p_actor_id, 'DUPLICATE_DNI');
    end if;

    insert into public.users (name, dni, role, group_number, member_number)
    values (
      v_operation.action->>'name',
      v_dni,
      'pasajero',
      1926,
      v_operation.action->>'member_number'
    )
    returning * into v_user;

    v_result := jsonb_build_object(
      'userId', v_user.id::text,
      'name', v_user.name,
      'dni', v_user.dni,
      'memberNumber', v_user.member_number,
      'groupId', v_user.group_number,
      'field', 'user_created'
    );
  else
    if v_operation.action->>'type' not in (
      'trip_set_start_time',
      'trip_cancel',
      'reservation_cancel'
    ) then
      return jsonb_build_object('ok', false, 'code', 'UNSUPPORTED_OPERATION');
    end if;

    v_trip_id := (v_operation.action->>'trip_id')::bigint;
    select t.*
      into v_trip
      from public.trips t
      join public.trip_groups tg on tg.trip_id = t.id
     where t.id = v_trip_id
       and tg.group_id::text = '1926'
     for update of t;

    if not found then
      return public.bb8_fail_operation(p_id, p_actor_id, 'TRIP_OUTSIDE_CLUB');
    end if;

    if v_operation.action->>'type' = 'trip_set_start_time' then
      v_new_start_time := v_operation.action->>'new_start_time';
      if v_trip.start_time is distinct from v_operation.action->>'expected_start_time' then
        return public.bb8_fail_operation(p_id, p_actor_id, 'PREVIEW_STALE');
      end if;
      if v_trip.status is distinct from 'open' then
        return public.bb8_fail_operation(p_id, p_actor_id, 'TRIP_NOT_EDITABLE');
      end if;
      if coalesce(v_new_start_time, '') !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' then
        return public.bb8_fail_operation(p_id, p_actor_id, 'INVALID_TRIP_TIME');
      end if;

      update public.trips
         set start_time = v_new_start_time
       where id = v_trip_id;
      v_result := jsonb_build_object(
        'tripId', v_trip_id,
        'tripName', v_trip.name,
        'field', 'start_time',
        'previousValue', v_trip.start_time,
        'value', v_new_start_time
      );
    elsif v_operation.action->>'type' = 'trip_cancel' then
      if v_trip.status is distinct from v_operation.action->>'expected_status' then
        return public.bb8_fail_operation(p_id, p_actor_id, 'PREVIEW_STALE');
      end if;
      if v_trip.status is distinct from 'open'
         or v_operation.action->>'new_status' is distinct from 'closed' then
        return public.bb8_fail_operation(p_id, p_actor_id, 'TRIP_NOT_CANCELLABLE');
      end if;
      if exists (
        select 1 from public.trip_runs
         where trip_id = v_trip_id
           and finished_at is null
      ) then
        return public.bb8_fail_operation(p_id, p_actor_id, 'TRIP_HAS_ACTIVE_RUN');
      end if;

      update public.trips
         set status = 'closed'
       where id = v_trip_id;
      v_result := jsonb_build_object(
        'tripId', v_trip_id,
        'tripName', v_trip.name,
        'field', 'status',
        'previousValue', v_trip.status,
        'value', 'closed'
      );
    else
      begin
        v_reservation_id := (v_operation.action->>'reservation_id')::bigint;
      exception when others then
        return public.bb8_fail_operation(p_id, p_actor_id, 'INVALID_RESERVATION');
      end;

      select r.status, r.user_id::text, u.name, u.description
        into v_reservation_status, v_reservation_user_id, v_user_name, v_user_description
        from public.reservations r
        join public.users u on u.id = r.user_id
       where r.id = v_reservation_id
         and r.trip_id = v_trip_id
         and u.role = 'pasajero'
         and (
           u.group_number::text = '1926'
           or u.organization_id::text = '1926'
         )
       for update of r;

      if not found
         or v_reservation_user_id is distinct from v_operation.action->>'user_id' then
        return public.bb8_fail_operation(p_id, p_actor_id, 'RESERVATION_NOT_FOUND');
      end if;
      if v_trip.status is distinct from 'open' then
        return public.bb8_fail_operation(p_id, p_actor_id, 'TRIP_NOT_EDITABLE');
      end if;
      if exists (
        select 1 from public.trip_runs
         where trip_id = v_trip_id
           and finished_at is null
      ) then
        return public.bb8_fail_operation(p_id, p_actor_id, 'TRIP_HAS_ACTIVE_RUN');
      end if;
      if v_reservation_status is distinct from v_operation.action->>'expected_status'
         or v_reservation_status not in ('confirmed', 'waiting') then
        return public.bb8_fail_operation(p_id, p_actor_id, 'PREVIEW_STALE');
      end if;

      delete from public.reservations
       where id = v_reservation_id;

      v_result := jsonb_build_object(
        'tripId', v_trip_id,
        'tripName', v_trip.name,
        'reservationId', v_reservation_id,
        'userId', v_reservation_user_id,
        'userName', v_user_name,
        'userDescription', coalesce(v_user_description, ''),
        'field', 'reservation_removed',
        'previousValue', v_reservation_status,
        'value', 'removed'
      );
    end if;
  end if;

  update public.bb8_operations
     set status = 'succeeded', result = v_result, completed_at = now()
   where id = p_id;

  insert into public.bb8_audit_log (
    operation_id, actor_id, group_id, event, action, details, succeeded
  ) values (
    p_id, p_actor_id, '1926', 'confirmed', v_operation.action, v_result, true
  );

  return jsonb_build_object('ok', true, 'status', 'succeeded', 'result', v_result);
exception when others then
  update public.bb8_operations
     set status = 'failed', failure_code = sqlstate, completed_at = now()
   where id = p_id
     and actor_id = p_actor_id
     and status = 'pending';

  insert into public.bb8_audit_log (
    operation_id, actor_id, group_id, event, action, details, succeeded
  )
  select
    p_id, p_actor_id, '1926', 'failed', action,
    jsonb_build_object('code', sqlstate), false
    from public.bb8_operations
   where id = p_id
     and actor_id = p_actor_id
     and status = 'failed';

  return jsonb_build_object('ok', false, 'code', 'OPERATION_FAILED');
end;
$$;

create or replace function public.bb8_record_verification(
  p_id uuid,
  p_actor_id text,
  p_verified boolean,
  p_details jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.bb8_operations
     set verification_success = p_verified,
         result = coalesce(result, '{}'::jsonb) ||
           case
             when result->>'field' = 'reservation_removed'
               then coalesce(
                 p_details - 'verified',
                 '{}'::jsonb
               )
             else '{}'::jsonb
           end ||
           jsonb_build_object('verified', p_verified)
   where id = p_id
     and actor_id = p_actor_id
     and group_id = '1926'
     and status = 'succeeded';

  if not found then
    return jsonb_build_object('ok', false, 'code', 'OPERATION_NOT_FOUND');
  end if;

  update public.bb8_audit_log
     set details = details ||
       coalesce(p_details, '{}'::jsonb) ||
       jsonb_build_object('verified', p_verified)
   where operation_id = p_id
     and actor_id = p_actor_id
     and event = 'confirmed';

  return jsonb_build_object('ok', true, 'verified', p_verified);
end;
$$;

revoke all on function public.bb8_create_operation(uuid, text, jsonb, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.bb8_cancel_operation(uuid, text) from public, anon, authenticated;
revoke all on function public.bb8_fail_operation(uuid, text, text) from public, anon, authenticated;
revoke all on function public.bb8_execute_operation(uuid, text) from public, anon, authenticated;
revoke all on function public.bb8_record_verification(uuid, text, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.bb8_create_operation(uuid, text, jsonb, jsonb, timestamptz) to service_role;
grant execute on function public.bb8_cancel_operation(uuid, text) to service_role;
grant execute on function public.bb8_fail_operation(uuid, text, text) to service_role;
grant execute on function public.bb8_execute_operation(uuid, text) to service_role;
grant execute on function public.bb8_record_verification(uuid, text, boolean, jsonb) to service_role;
