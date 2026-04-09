-- Stores persistent reinforcement configuration per base trip
-- and tracks the currently active forced reinforcement trip.

create table if not exists public.trip_reinforcement_configs (
  parent_trip_id bigint primary key references public.trips(id) on delete cascade,
  active_reinforcement_trip_id bigint references public.trips(id) on delete set null,
  parent_stops_snapshot jsonb,
  split_stop_ids jsonb,
  reinforcement_trip_name text,
  reinforcement_bus_name text,
  reinforcement_bus_capacity integer,
  updated_at timestamptz not null default now()
);

create index if not exists idx_trip_reinforcement_active_trip
  on public.trip_reinforcement_configs(active_reinforcement_trip_id);

create or replace function public.set_trip_reinforcement_configs_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_trip_reinforcement_configs_updated_at on public.trip_reinforcement_configs;

create trigger trg_trip_reinforcement_configs_updated_at
before update on public.trip_reinforcement_configs
for each row
execute function public.set_trip_reinforcement_configs_updated_at();
