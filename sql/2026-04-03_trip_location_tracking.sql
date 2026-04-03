-- Real-time location tracking for trips

create table if not exists public.trip_location_sessions (
  trip_id bigint primary key references public.trips(id) on delete cascade,
  active boolean not null default false,
  started_by text,
  started_at timestamptz,
  stopped_at timestamptz,
  last_latitude double precision,
  last_longitude double precision,
  last_accuracy_meters double precision,
  last_update_at timestamptz,
  last_stop_id bigint,
  last_stop_name text,
  last_stop_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.trip_location_updates (
  id bigserial primary key,
  trip_id bigint not null references public.trips(id) on delete cascade,
  latitude double precision not null,
  longitude double precision not null,
  accuracy_meters double precision,
  recorded_at timestamptz not null default now(),
  source_user_id text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_trip_location_updates_trip_recorded
  on public.trip_location_updates (trip_id, recorded_at desc);

create index if not exists idx_trip_location_sessions_active
  on public.trip_location_sessions (active, last_update_at desc)
  where active = true;
