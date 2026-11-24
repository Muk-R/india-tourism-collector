-- ISOLATED DATABASE ONLY. Run after 00_legacy_backfill_seed.sql and the draft
-- migration. All checks are read-only and fail with a useful assertion error.
do $$
declare
  v_cycle public.tourism_collection_cycles%rowtype;
  v_source_count int;
  v_processing_lease timestamptz;
  v_completed_copy public.tourism_collection_cycle_items%rowtype;
begin
  select cy.* into v_cycle
  from public.tourism_collection_cycles cy
  where cy.city_id = 'f7f683cc-c940-4c59-85df-568b3fe95fd1'
    and cy.is_legacy;
  if not found then raise exception 'legacy cycle was not backfilled'; end if;
  if v_cycle.radius_km <> 40 or v_cycle.radius_verified then
    raise exception 'invalid historical radius was ignored during verification';
  end if;
  if v_cycle.status <> 'processing' then
    raise exception 'legacy processing status was not preserved';
  end if;

  select count(*) into v_source_count
  from public.tourism_collection_cycle_sources s
  where s.cycle_id = v_cycle.id and not s.is_complete
    and s.status in ('pending', 'retry_wait');
  if v_source_count <> 2 then
    raise exception 'legacy discovery timestamp was treated as complete';
  end if;

  select i.lease_expires_at into v_processing_lease
  from public.tourism_collection_cycle_items i
  where i.cycle_id = v_cycle.id and i.source_id = 'node/710001';
  if v_processing_lease is null or v_processing_lease > now() then
    raise exception 'processing item with missing claimed_at was not made reclaimable';
  end if;

  select i.* into v_completed_copy
  from public.tourism_collection_cycle_items i
  where i.cycle_id = v_cycle.id and i.source_id = 'Q710002';
  if v_completed_copy.status <> 'pending' or v_completed_copy.attempts <> 0
     or v_completed_copy.processed_at is not null then
    raise exception 'legacy completed queue item was assumed durably persisted';
  end if;

  if (select collection_status from public.tourism_cities
      where id = v_cycle.city_id) <> 'processing' then
    raise exception 'city status changed during legacy backfill';
  end if;
end;
$$;
