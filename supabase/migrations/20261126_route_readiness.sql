-- Route readiness is stricter than public place visibility. Approved places can
-- be browsed and mapped, but directions require an explicit human-reviewed gate.
begin;

alter table public.tourism_places
  add column if not exists route_ready boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tourism_places'::regclass
      and conname = 'tourism_places_route_ready_requires_public_approval'
  ) then
    alter table public.tourism_places
      add constraint tourism_places_route_ready_requires_public_approval
      check (not route_ready or (review_status = 'approved' and is_active)) not valid;
  end if;
end;
$$;

alter table public.tourism_places
  validate constraint tourism_places_route_ready_requires_public_approval;

commit;
