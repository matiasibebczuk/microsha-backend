alter table public.trips
  add column if not exists waitlist_end_at timestamptz;
