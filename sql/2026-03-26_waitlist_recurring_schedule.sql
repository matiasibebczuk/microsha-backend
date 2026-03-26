alter table public.trips
  add column if not exists waitlist_start_day smallint,
  add column if not exists waitlist_start_time time,
  add column if not exists waitlist_end_day smallint,
  add column if not exists waitlist_end_time time;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'trips_waitlist_start_day_chk'
  ) then
    alter table public.trips
      add constraint trips_waitlist_start_day_chk
      check (waitlist_start_day is null or (waitlist_start_day >= 0 and waitlist_start_day <= 6));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'trips_waitlist_end_day_chk'
  ) then
    alter table public.trips
      add constraint trips_waitlist_end_day_chk
      check (waitlist_end_day is null or (waitlist_end_day >= 0 and waitlist_end_day <= 6));
  end if;
end
$$;
