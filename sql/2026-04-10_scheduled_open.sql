alter table public.system_settings
  add column if not exists scheduled_open_enabled boolean not null default false,
  add column if not exists scheduled_open_day integer null,
  add column if not exists scheduled_open_time text null,
  add column if not exists scheduled_open_last_trigger_week text null;
