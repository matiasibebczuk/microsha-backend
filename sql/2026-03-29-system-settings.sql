create table if not exists public.system_settings (
  id integer primary key,
  trips_paused boolean not null default false,
  pause_message text not null default 'En mantenimiento, prueba mas tarde',
  scheduled_pause_enabled boolean not null default false,
  scheduled_pause_day integer null,
  scheduled_pause_time text null,
  scheduled_pause_last_trigger_week text null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

insert into public.system_settings (
  id,
  trips_paused,
  pause_message,
  scheduled_pause_enabled,
  scheduled_pause_day,
  scheduled_pause_time,
  scheduled_pause_last_trigger_week
)
values (1, false, 'En mantenimiento, prueba mas tarde', false, null, null, null)
on conflict (id) do nothing;
