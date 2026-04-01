-- Supabase security hardening: enable RLS everywhere and block direct table access
-- for anon/authenticated roles. Backend uses service_role, so app API keeps working.

-- 1) Ensure RLS is enabled on all user tables in public schema.
do $$
declare
  r record;
begin
  for r in
    select schemaname, tablename
    from pg_tables
    where schemaname = 'public'
      and tablename not in ('schema_migrations')
  loop
    execute format('alter table %I.%I enable row level security;', r.schemaname, r.tablename);
  end loop;
end
$$;

-- 2) Revoke direct table access from client roles.
revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;

-- 3) Revoke sequence access too (prevents id probing/nextval).
revoke all on all sequences in schema public from anon;
revoke all on all sequences in schema public from authenticated;

-- 4) Keep future tables/sequences locked by default.
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on tables from authenticated;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke all on sequences from authenticated;

-- Note:
-- If later you want direct client-side reads/writes for a specific table,
-- grant explicit privileges + create explicit RLS policies only for that table.
