-- Atomic reservation flow + DB integrity guards for concurrent signups.

-- Performance indexes for frequent reservation/trip lookups.
create index if not exists idx_reservations_trip_status_id
  on public.reservations (trip_id, status, id);

create index if not exists idx_reservations_user_status_trip
  on public.reservations (user_id, status, trip_id);

create index if not exists idx_trip_buses_trip_id
  on public.trip_buses (trip_id);

create index if not exists idx_trip_stops_trip_order
  on public.trip_stops (trip_id, order_index);

-- Guard against duplicate active reservations inside the same trip.
create unique index if not exists uq_reservations_active_trip_user
  on public.reservations (trip_id, user_id)
  where status in ('confirmed', 'waiting');

create or replace function public.normalize_trip_direction(p_type text)
returns text
language sql
immutable
as $$
  select case
    when lower(trim(coalesce(p_type, ''))) like 'ida%' then 'ida'
    when lower(trim(coalesce(p_type, ''))) like 'vuelta%' then 'vuelta'
    when lower(trim(coalesce(p_type, ''))) like 'regreso%' then 'vuelta'
    else null
  end;
$$;

create or replace function public.enforce_one_active_reservation_per_direction()
returns trigger
language plpgsql
as $$
declare
  v_target_direction text;
  v_conflict record;
begin
  if new.user_id is null or new.trip_id is null then
    return new;
  end if;

  if coalesce(new.status, '') not in ('confirmed', 'waiting') then
    return new;
  end if;

  select public.normalize_trip_direction(t.type)
    into v_target_direction
  from public.trips t
  where t.id = new.trip_id;

  if v_target_direction is null then
    return new;
  end if;

  select r.id, r.trip_id, t.name
    into v_conflict
  from public.reservations r
  join public.trips t on t.id = r.trip_id
  where r.user_id = new.user_id
    and r.status in ('confirmed', 'waiting')
    and r.trip_id <> new.trip_id
    and public.normalize_trip_direction(t.type) = v_target_direction
    and (tg_op = 'INSERT' or r.id <> new.id)
  order by r.id desc
  limit 1;

  if v_conflict.id is not null then
    raise exception
      using errcode = '23514',
            message = format(
              'Solo podés tener un traslado de %s a la vez. Cancelá el actual para anotarte en otro.',
              case when v_target_direction = 'ida' then 'ida' else 'vuelta' end
            ),
            detail = format('existing_trip_id=%s', v_conflict.trip_id);
  end if;

  return new;
end;
$$;

drop trigger if exists trg_reservations_one_direction on public.reservations;
create trigger trg_reservations_one_direction
before insert or update of trip_id, user_id, status
on public.reservations
for each row
execute function public.enforce_one_active_reservation_per_direction();

create or replace function public.reserve_trip_atomic(
  p_trip_id bigint,
  p_stop_id bigint,
  p_user_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trip record;
  v_target_direction text;
  v_conflict record;
  v_existing record;
  v_capacity integer;
  v_confirmed integer;
  v_status text;
  v_inserted_id bigint;
begin
  if p_trip_id is null or p_stop_id is null or p_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_input', 'message', 'Missing data');
  end if;

  perform pg_advisory_xact_lock(3001, p_trip_id::integer);
  perform pg_advisory_xact_lock(3002, p_user_id::integer);

  select id, name, type, status
    into v_trip
  from public.trips
  where id = p_trip_id;

  if v_trip.id is null then
    return jsonb_build_object('ok', false, 'code', 'trip_not_found', 'message', 'Trip not found');
  end if;

  if coalesce(v_trip.status, '') <> 'open' then
    return jsonb_build_object('ok', false, 'code', 'trip_closed', 'message', 'Inscripción cerrada');
  end if;

  v_target_direction := public.normalize_trip_direction(v_trip.type);

  if v_target_direction is not null then
    select r.trip_id, t.name
      into v_conflict
    from public.reservations r
    join public.trips t on t.id = r.trip_id
    where r.user_id = p_user_id
      and r.status in ('confirmed', 'waiting')
      and r.trip_id <> p_trip_id
      and public.normalize_trip_direction(t.type) = v_target_direction
    order by r.id desc
    limit 1;

    if v_conflict.trip_id is not null then
      return jsonb_build_object(
        'ok', false,
        'code', 'direction_limit',
        'direction', v_target_direction,
        'existingTripId', v_conflict.trip_id,
        'existingTripName', coalesce(v_conflict.name, null),
        'message', format(
          'Solo podés tener un traslado de %s a la vez. Cancelá el actual para anotarte en otro.',
          case when v_target_direction = 'ida' then 'ida' else 'vuelta' end
        )
      );
    end if;
  end if;

  select id, status, stop_id
    into v_existing
  from public.reservations
  where trip_id = p_trip_id
    and user_id = p_user_id
  order by id desc
  limit 1;

  if v_existing.id is not null then
    if v_existing.stop_id = p_stop_id then
      return jsonb_build_object(
        'ok', true,
        'status', v_existing.status,
        'existing', true,
        'updated', false,
        'hadSeats', v_existing.status = 'confirmed',
        'reservationId', v_existing.id
      );
    end if;

    update public.reservations
      set stop_id = p_stop_id
    where id = v_existing.id;

    return jsonb_build_object(
      'ok', true,
      'status', v_existing.status,
      'existing', false,
      'updated', true,
      'hadSeats', v_existing.status = 'confirmed',
      'reservationId', v_existing.id
    );
  end if;

  select coalesce(sum(b.capacity), 0)
    into v_capacity
  from public.trip_buses tb
  join public.buses b on b.id = tb.bus_id
  where tb.trip_id = p_trip_id;

  select count(*)
    into v_confirmed
  from public.reservations
  where trip_id = p_trip_id
    and status = 'confirmed';

  v_status := case when v_confirmed < v_capacity then 'confirmed' else 'waiting' end;

  insert into public.reservations (user_id, trip_id, stop_id, status)
  values (p_user_id, p_trip_id, p_stop_id, v_status)
  returning id into v_inserted_id;

  return jsonb_build_object(
    'ok', true,
    'status', v_status,
    'existing', false,
    'updated', false,
    'hadSeats', v_status = 'confirmed',
    'reservationId', v_inserted_id
  );
exception
  when unique_violation then
    select id, status, stop_id
      into v_existing
    from public.reservations
    where trip_id = p_trip_id
      and user_id = p_user_id
    order by id desc
    limit 1;

    if v_existing.id is null then
      return jsonb_build_object('ok', false, 'code', 'unique_violation', 'message', 'No se pudo crear la reserva');
    end if;

    if v_existing.stop_id <> p_stop_id then
      update public.reservations
        set stop_id = p_stop_id
      where id = v_existing.id;
      return jsonb_build_object(
        'ok', true,
        'status', v_existing.status,
        'existing', false,
        'updated', true,
        'hadSeats', v_existing.status = 'confirmed',
        'reservationId', v_existing.id
      );
    end if;

    return jsonb_build_object(
      'ok', true,
      'status', v_existing.status,
      'existing', true,
      'updated', false,
      'hadSeats', v_existing.status = 'confirmed',
      'reservationId', v_existing.id
    );
end;
$$;
