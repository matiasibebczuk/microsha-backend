do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'route_template_stops_template_order_unique'
  ) then
    alter table public.route_template_stops
      add constraint route_template_stops_template_order_unique
      unique (template_id, order_index);
  end if;
end
$$;
