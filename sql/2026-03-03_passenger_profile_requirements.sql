alter table public.users
  add column if not exists description text;

alter table public.users
  alter column phone type text using phone::text;

-- Ajuste opcional para dejar datos existentes limpios
update public.users
set
  phone = regexp_replace(coalesce(phone, ''), '\\D', '', 'g'),
  description = coalesce(trim(description), '')
where true;

-- Restricción de formato: 11 + 8 dígitos (10 en total)
alter table public.users
  drop constraint if exists users_phone_format_check;

alter table public.users
  add constraint users_phone_format_check
  check (phone ~ '^11[0-9]{8}$');

-- Restricción de descripción obligatoria
alter table public.users
  drop constraint if exists users_description_required_check;

alter table public.users
  add constraint users_description_required_check
  check (length(trim(coalesce(description, ''))) > 0);
