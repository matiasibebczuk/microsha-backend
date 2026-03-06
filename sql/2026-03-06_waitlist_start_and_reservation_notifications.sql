alter table public.trips
  add column if not exists waitlist_start_at timestamptz;

alter table public.reservations
  add column if not exists waiting_promoted_at timestamptz,
  add column if not exists confirm_notify_after timestamptz,
  add column if not exists confirm_notified_at timestamptz;

create index if not exists idx_reservations_notification_due
  on public.reservations (user_id, confirm_notify_after)
  where status = 'confirmed' and confirm_notified_at is null;
