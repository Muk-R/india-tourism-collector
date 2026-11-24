-- ISOLATED DATABASE ONLY. Run in this order: schema.sql, 00_legacy_backfill_seed.sql,
-- draft migration, this file, then 99_legacy_backfill_assert.sql. This file rolls
-- back all fixtures and assertions. Never run these scripts on production.
begin;

do $$
declare
  v_city uuid;
  v_cycle uuid;
  v_initial_cycle uuid;
  v_city_token uuid;
  v_source_token uuid;
  v_new_token uuid;
  v_other_city uuid;
  v_other_cycle uuid;
  v_other_city_token uuid;
  v_wiki_token uuid;
  v_cursor jsonb;
  v_next_cursor jsonb;
  v_applied boolean;
  v_complete boolean;
  v_attempts int;
  v_rows int;
  v_failed boolean;
  v_place_id uuid;
  v_same_id uuid;
  v_original_lat double precision;
  v_manual_place uuid;
  v_stale_place uuid;
  v_manual_current boolean;
  v_manual_managed boolean;
  v_item public.tourism_collection_cycle_items%rowtype;
  v_place jsonb;
  v_source jsonb;
  v_i int;
  v_table text;
begin
  -- Make the automatic-claim assertions deterministic in an isolated fixture DB.
  update public.tourism_cities set is_enabled = false;
  insert into public.tourism_cities (
    name, state_name, latitude, longitude, radius_km, is_enabled
  ) values ('Cycle Regression City A', 'Test State', 12.9716, 77.5946, 10, true)
  returning id into v_city;

  select cc.cycle_id, cc.lease_token into v_initial_cycle, v_city_token
  from public.claim_next_tourism_collection_cycle(600) cc;
  if v_initial_cycle is null then raise exception 'first automatic claim returned no cycle'; end if;
  if (select radius_km from public.tourism_collection_cycles where id = v_initial_cycle) <> 10 then
    raise exception '10 km radius boundary was not accepted';
  end if;

  select count(*) into v_rows
  from public.claim_tourism_collection_cycle(v_city, 10, false, false, 600, false);
  if v_rows <> 0 then raise exception 'subsequent claim ignored the active city lease'; end if;

  -- Explicit rediscovery supersedes the old cycle and accepts the 150 km bound.
  select cc.cycle_id, cc.lease_token into v_cycle, v_city_token
  from public.claim_tourism_collection_cycle(v_city, 150, true, false, 600, false) cc;
  if v_cycle is null or v_cycle = v_initial_cycle then
    raise exception 'explicit rediscovery did not create a new cycle';
  end if;
  if (select radius_km from public.tourism_collection_cycles where id = v_cycle) <> 150 then
    raise exception '150 km radius boundary was not accepted';
  end if;
  if (select status from public.tourism_collection_cycles where id = v_initial_cycle) <> 'superseded' then
    raise exception 'old cycle was not fenced by rediscovery';
  end if;

  v_failed := false;
  begin
    select count(*) into v_rows
    from public.claim_tourism_collection_cycle(v_city, 9, true, false, 600, false);
  exception when raise_exception then v_failed := true;
  end;
  if not v_failed then raise exception '9 km radius was accepted'; end if;
  v_failed := false;
  begin
    select count(*) into v_rows
    from public.claim_tourism_collection_cycle(v_city, 151, true, false, 600, false);
  exception when raise_exception then v_failed := true;
  end;
  if not v_failed then raise exception '151 km radius was accepted'; end if;
  v_failed := false;
  begin
    select count(*) into v_rows
    from public.claim_tourism_collection_cycle(v_city, null, false, false, null, false);
  exception when raise_exception then v_failed := true;
  end;
  if not v_failed then raise exception 'NULL city lease duration was accepted'; end if;
  v_failed := false;
  begin
    select count(*) into v_rows from public.claim_next_tourism_collection_cycle(null);
  exception when raise_exception then v_failed := true;
  end;
  if not v_failed then raise exception 'NULL batch lease duration was accepted'; end if;
  v_failed := false;
  begin
    select s.lease_token into v_source_token
    from public.claim_tourism_cycle_source(v_cycle, v_city_token, 'openstreetmap', null) s;
  exception when raise_exception then v_failed := true;
  end;
  if not v_failed then raise exception 'NULL source lease duration was accepted'; end if;
  v_failed := false;
  begin
    perform public.renew_tourism_collection_lease(v_cycle, v_city_token, null, null, null, null, null);
  exception when raise_exception then v_failed := true;
  end;
  if not v_failed then raise exception 'NULL renewal duration was accepted'; end if;

  -- Source release and city release checkpoint progress without retry cost.
  select s.lease_token into v_source_token
  from public.claim_tourism_cycle_source(v_cycle, v_city_token, 'openstreetmap', 600) s;
  if v_source_token is null then raise exception 'source claim returned no lease'; end if;
  perform public.release_tourism_cycle_source(v_cycle, v_city_token, 'openstreetmap', v_source_token);
  select s.attempts into v_attempts from public.tourism_collection_cycle_sources s
  where s.cycle_id = v_cycle and s.source_name = 'openstreetmap';
  if v_attempts <> 0 then raise exception 'voluntary source release consumed a retry'; end if;
  perform public.release_tourism_collection_city_lease(v_cycle, v_city_token);
  select cc.cycle_id, cc.lease_token into v_cycle, v_city_token
  from public.claim_tourism_collection_cycle(v_city, null, false, false, 600, false) cc;
  if v_cycle is null then raise exception 'released city cycle was not claimable'; end if;

  -- Safe lease renewal extends both city and source leases.
  select s.lease_token into v_source_token
  from public.claim_tourism_cycle_source(v_cycle, v_city_token, 'openstreetmap', 600) s;
  if public.renew_tourism_collection_lease(
       v_cycle, v_city_token, 900, 'openstreetmap', v_source_token, null, null
     ) <= now() then
    raise exception 'lease renewal did not return a future expiry';
  end if;
  v_failed := false;
  begin
    select count(*) into v_rows
    from public.claim_tourism_cycle_items(v_cycle, v_city_token, null, 600);
  exception when raise_exception then v_failed := true;
  end;
  if not v_failed then raise exception 'NULL item limit was accepted'; end if;
  v_failed := false;
  begin
    select pg.page_applied into v_applied
    from public.persist_tourism_cycle_source_page(
      v_cycle, v_city_token, 'openstreetmap', v_source_token,
      'null-completion', null, null, '[]'::jsonb, null
    ) pg;
  exception when raise_exception then v_failed := true;
  end;
  if not v_failed then raise exception 'NULL completion flag was accepted'; end if;

  -- Seed a manually curated link that the collector will observe again.
  insert into public.tourism_places (
    canonical_name, latitude, longitude, osm_type, osm_id, review_status
  ) values ('Manual Attraction', 12.9716, 77.5946, 'node', 710101, 'pending')
  returning id into v_manual_place;
  insert into public.tourism_city_places(city_id, place_id, distance_km, relevance_score)
  values (v_city, v_manual_place, 0, 30);
  insert into public.tourism_places(canonical_name, latitude, longitude)
  values ('Collector Managed Stale Link', 12.9717, 77.5947)
  returning id into v_stale_place;
  insert into public.tourism_city_places(
    city_id, place_id, distance_km, relevance_score, managed_by_collector
  ) values (v_city, v_stale_place, 0.02, 10, true);

  -- Persist six successful pages. This exceeds the old five-item claim batch;
  -- source attempts must remain unchanged across all successful pages.
  v_cursor := null;
  for v_i in 1..6 loop
    if v_i < 6 then v_next_cursor := jsonb_build_object('offset', v_i);
    else v_next_cursor := null;
    end if;
    select pg.page_applied, pg.source_complete into v_applied, v_complete
    from public.persist_tourism_cycle_source_page(
      v_cycle, v_city_token, 'openstreetmap', v_source_token,
      format('osm-page-%s', v_i), v_cursor, v_next_cursor,
      jsonb_build_array(jsonb_build_object(
        'source_id', format('node/%s', 710100 + v_i),
        'raw_payload', jsonb_build_object('type', 'node', 'id', 710100 + v_i),
        'priority_score', case when v_i = 1 then 100 else 90 end,
        'priority_reasons', array['landmark']
      )), v_i = 6
    ) pg;
    if not v_applied then raise exception 'new discovery page was not persisted'; end if;
    if v_i < 6 and v_complete then raise exception 'nonfinal page marked source complete'; end if;
    v_cursor := v_next_cursor;
  end loop;
  select s.attempts into v_attempts from public.tourism_collection_cycle_sources s
  where s.cycle_id = v_cycle and s.source_name = 'openstreetmap';
  if v_attempts <> 0 then raise exception 'successful pages incremented source failures'; end if;
  if (select pages_completed from public.tourism_collection_cycle_sources
      where cycle_id = v_cycle and source_name = 'openstreetmap') <> 6 then
    raise exception 'discovery page progress was not recorded across six pages';
  end if;

  -- Final-page replay remains idempotent after the source lease was cleared.
  select pg.page_applied, pg.source_complete into v_applied, v_complete
  from public.persist_tourism_cycle_source_page(
    v_cycle, v_city_token, 'openstreetmap', v_source_token,
    'osm-page-6', jsonb_build_object('offset', 5), null,
    jsonb_build_array(jsonb_build_object(
      'source_id', 'node/710106',
      'raw_payload', jsonb_build_object('type', 'node', 'id', 710106),
      'priority_score', 90,
      'priority_reasons', array['landmark']
    )), true
  ) pg;
  if v_applied or not v_complete then raise exception 'final-page replay was not idempotent'; end if;

  v_failed := false;
  begin
    select pg.page_applied into v_applied from public.persist_tourism_cycle_source_page(
      v_cycle, v_city_token, 'openstreetmap', v_source_token,
      'osm-page-6', jsonb_build_object('offset', 5), null,
      jsonb_build_array(jsonb_build_object(
        'source_id', 'node/999999', 'raw_payload', jsonb_build_object('id', 999999)
      )), true
    ) pg;
  exception when raise_exception then v_failed := true;
  end;
  if not v_failed then raise exception 'inconsistent page-key reuse was accepted'; end if;

  -- Reject identity mismatches without creating a place or source row.
  select i.* into v_item from public.claim_tourism_cycle_items(v_cycle, v_city_token, 1, 600) i
  where i.source_id = 'node/710101';
  if v_item.id is null then raise exception 'manual-link item was not claimable'; end if;
  v_place := jsonb_build_object(
    'canonical_name', 'Reobserved Manual Attraction', 'category', 'tourism',
    'latitude', 12.9716, 'longitude', 77.5946, 'osm_type', 'node', 'osm_id', 710101,
    'quality_score', 55, 'importance_score', 93
  );
  v_source := jsonb_build_object(
    'source_name', 'openstreetmap', 'source_id', 'node/999999',
    'source_url', 'https://www.openstreetmap.org/node/710101',
    'attribution', 'OpenStreetMap contributors', 'license', 'ODbL'
  );
  v_failed := false;
  begin
    perform public.upsert_tourism_place_for_cycle(
      v_cycle, v_city_token, v_item.id, v_item.lease_token, v_place, v_source, null
    );
  exception when raise_exception then v_failed := true;
  end;
  if not v_failed then raise exception 'queue/source identity mismatch was accepted'; end if;

  v_source := jsonb_build_object(
    'source_name', v_item.source_name, 'source_id', v_item.source_id,
    'source_url', 'https://www.openstreetmap.org/' || v_item.source_id,
    'attribution', 'OpenStreetMap contributors', 'license', 'ODbL'
  );
  perform public.upsert_tourism_place_for_cycle(
    v_cycle, v_city_token, v_item.id, v_item.lease_token, v_place, v_source, null
  );
  for v_item in
    select i.* from public.claim_tourism_cycle_items(v_cycle, v_city_token, 5, 600) i
  loop
    v_place := jsonb_build_object(
      'canonical_name', case when v_item.source_id = 'node/710101'
                             then 'Reobserved Manual Attraction'
                             else 'Test Attraction ' || v_item.source_id end,
      'category', 'tourism', 'subcategory', 'attraction',
      'latitude', 12.9716, 'longitude', 77.5946,
      'osm_type', 'node', 'osm_id', split_part(v_item.source_id, '/', 2)::bigint,
      'quality_score', 55, 'importance_score', 93
    );
    v_source := jsonb_build_object(
      'source_name', v_item.source_name, 'source_id', v_item.source_id,
      'source_url', 'https://www.openstreetmap.org/' || v_item.source_id,
      'attribution', 'OpenStreetMap contributors', 'license', 'ODbL'
    );
    perform public.upsert_tourism_place_for_cycle(
      v_cycle, v_city_token, v_item.id, v_item.lease_token, v_place, v_source, null
    );
  end loop;
  if (select cp.relevance_score
      from public.tourism_city_places cp
      join public.tourism_places p on p.id = cp.place_id
      where cp.city_id = v_city and p.osm_id = 710102) <> 93 then
    raise exception 'city-place ranking did not use importance_score separately from quality_score';
  end if;
  -- Expired source leases consume a failure attempt; successful pages do not.
  select s.lease_token into v_wiki_token
  from public.claim_tourism_cycle_source(v_cycle, v_city_token, 'wikidata', 600) s;
  update public.tourism_collection_cycle_sources
  set lease_expires_at = now() - interval '1 second'
  where cycle_id = v_cycle and source_name = 'wikidata';
  select s.lease_token into v_new_token
  from public.claim_tourism_cycle_source(v_cycle, v_city_token, 'wikidata', 600) s;
  if v_new_token is null or v_new_token = v_wiki_token then
    raise exception 'expired source lease was not recovered';
  end if;
  select s.attempts into v_attempts from public.tourism_collection_cycle_sources s
  where s.cycle_id = v_cycle and s.source_name = 'wikidata';
  if v_attempts <> 1 then raise exception 'expired lease failure was not counted exactly once'; end if;
  select pg.page_applied into v_applied from public.persist_tourism_cycle_source_page(
    v_cycle, v_city_token, 'wikidata', v_new_token, 'wd-final', null, null, '[]'::jsonb, true
  ) pg;
  select s.attempts into v_rows from public.tourism_collection_cycle_sources s
  where s.cycle_id = v_cycle and s.source_name = 'wikidata';
  if v_rows <> 1 then raise exception 'successful final page changed retry count'; end if;

  -- The final item write marks ready_to_finalize atomically. Simulate a crash
  -- before finish, expire its city lease, and verify automatic reclamation.
  if (select status from public.tourism_collection_cycles where id = v_cycle) <> 'ready_to_finalize' then
    raise exception 'cycle was not checkpointed for finalization';
  end if;
  update public.tourism_collection_cycles
  set lease_expires_at = now() - interval '1 second'
  where id = v_cycle;
  select cc.cycle_id, cc.lease_token into v_other_cycle, v_new_token
  from public.claim_next_tourism_collection_cycle(600) cc;
  if v_other_cycle <> v_cycle or v_new_token is null then
    raise exception 'ready cycle was not reclaimable after finalization crash';
  end if;
  if (select status from public.tourism_collection_cycles where id = v_cycle) <> 'ready_to_finalize' then
    raise exception 'claim changed ready-to-finalize state';
  end if;

  select cp.is_current, cp.managed_by_collector into v_manual_current, v_manual_managed
  from public.tourism_city_places cp
  where cp.city_id = v_city and cp.place_id = v_manual_place;
  if not v_manual_current or v_manual_managed then
    raise exception 'reobserved manual link lost its curation state';
  end if;
  if public.finish_tourism_collection_cycle(v_cycle, v_new_token) <> 0 then
    raise exception 'pilot default unexpectedly retired city-place links';
  end if;
  if not (select is_current from public.tourism_city_places
          where city_id = v_city and place_id = v_stale_place) then
    raise exception 'link retirement was not disabled by default';
  end if;

  -- Validate the baseline upsert's identity conflict, duplicate, coordinate,
  -- importance, and description/license behavior after replacement.
  v_place_id := public.upsert_tourism_place(jsonb_build_object(
    'canonical_name', 'Identity Lock Place', 'latitude', 13.0, 'longitude', 77.6,
    'osm_type', 'node', 'osm_id', 719001, 'importance_score', 88
  ));
  v_original_lat := (select latitude from public.tourism_places where id = v_place_id);
  v_same_id := public.upsert_tourism_place(jsonb_build_object(
    'canonical_name', 'Identity Lock Place', 'latitude', 13.001, 'longitude', 77.6,
    'osm_type', 'node', 'osm_id', 719001, 'importance_score', 90
  ));
  if v_same_id <> v_place_id or (select latitude from public.tourism_places where id = v_place_id) <> v_original_lat then
    raise exception 'duplicate identity created a row or changed canonical coordinates';
  end if;
  if (select importance_score from public.tourism_places where id = v_place_id) <> 90 then
    raise exception 'validated importance score was not persisted separately';
  end if;

  perform public.upsert_tourism_place(jsonb_build_object(
    'canonical_name', 'Wikidata Identity Place', 'latitude', 13.2, 'longitude', 77.7,
    'wikidata_id', 'Q719002'
  ));
  v_failed := false;
  begin
    perform public.upsert_tourism_place(jsonb_build_object(
      'canonical_name', 'Conflicting Identity Place', 'latitude', 13.3, 'longitude', 77.8,
      'osm_type', 'node', 'osm_id', 719001, 'wikidata_id', 'Q719002'
    ));
  exception when raise_exception then v_failed := true;
  end;
  if not v_failed then raise exception 'conflicting external identities were merged'; end if;

  v_failed := false;
  begin
    perform public.upsert_tourism_place(jsonb_build_object(
      'canonical_name', 'Bad Attribution', 'latitude', 13.4, 'longitude', 77.9,
      'description', 'Text', 'description_source', 'Wikipedia', 'description_license', 'CC0'
    ));
  exception when raise_exception then v_failed := true;
  end;
  if not v_failed then raise exception 'mismatched description attribution was accepted'; end if;
  v_place_id := public.upsert_tourism_place(jsonb_build_object(
    'canonical_name', 'Attributed Description', 'latitude', 13.5, 'longitude', 78.0,
    'description', 'A sourced description', 'description_source', 'Wikipedia',
    'description_license', 'CC BY-SA'
  ));
  if (select description_license from public.tourism_places where id = v_place_id) <> 'CC BY-SA' then
    raise exception 'valid description attribution was not persisted';
  end if;

  -- Explicit future reconciliation is opt-in and still preserves manual links.
  insert into public.tourism_cities (
    name, state_name, latitude, longitude, radius_km, is_enabled
  ) values ('Cycle Regression City B', 'Test State', 14, 78, 10, true)
  returning id into v_other_city;
  insert into public.tourism_places(canonical_name, latitude, longitude)
  values ('Manual Link B', 14, 78) returning id into v_manual_place;
  insert into public.tourism_places(canonical_name, latitude, longitude)
  values ('Managed Old Link B', 14, 78) returning id into v_stale_place;
  insert into public.tourism_city_places(city_id, place_id) values (v_other_city, v_manual_place);
  insert into public.tourism_city_places(city_id, place_id, managed_by_collector)
  values (v_other_city, v_stale_place, true);
  select cc.cycle_id, cc.lease_token into v_other_cycle, v_other_city_token
  from public.claim_tourism_collection_cycle(v_other_city, 150, false, false, 600, true) cc;
  select s.lease_token into v_source_token
  from public.claim_tourism_cycle_source(v_other_cycle, v_other_city_token, 'openstreetmap', 600) s;
  perform public.persist_tourism_cycle_source_page(
    v_other_cycle, v_other_city_token, 'openstreetmap', v_source_token,
    'osm-empty', null, null, '[]'::jsonb, true
  );
  select s.lease_token into v_source_token
  from public.claim_tourism_cycle_source(v_other_cycle, v_other_city_token, 'wikidata', 600) s;
  perform public.persist_tourism_cycle_source_page(
    v_other_cycle, v_other_city_token, 'wikidata', v_source_token,
    'wd-empty', null, null, '[]'::jsonb, true
  );
  perform public.finish_tourism_collection_cycle(v_other_cycle, v_other_city_token);
  if (select is_current from public.tourism_city_places
      where city_id = v_other_city and place_id = v_manual_place) is not true then
    raise exception 'explicit reconciliation retired a manual link';
  end if;
  if (select is_current from public.tourism_city_places
      where city_id = v_other_city and place_id = v_stale_place) is not false then
    raise exception 'explicit reconciliation failed to retire a collector link';
  end if;

  foreach v_table in array array[
    'tourism_collection_cycles', 'tourism_collection_cycle_sources',
    'tourism_collection_cycle_source_pages', 'tourism_collection_cycle_items'
  ] loop
    if not (select relrowsecurity from pg_class
            where oid = to_regclass('public.' || v_table)) then
      raise exception 'RLS is not enabled on %', v_table;
    end if;
    if has_table_privilege('anon', 'public.' || v_table, 'select') then
      raise exception 'anon can read private table %', v_table;
    end if;
  end loop;
  if has_function_privilege(
    'anon', 'public.claim_tourism_collection_cycle(uuid,integer,boolean,boolean,integer,boolean)', 'execute'
  ) then raise exception 'anon can execute privileged claim RPC'; end if;
  if not has_function_privilege(
    'service_role', 'public.claim_tourism_collection_cycle(uuid,integer,boolean,boolean,integer,boolean)', 'execute'
  ) then raise exception 'service_role cannot execute claim RPC'; end if;
  if has_function_privilege(
    'anon', 'public.persist_tourism_cycle_source_page(uuid,uuid,text,uuid,text,jsonb,jsonb,jsonb,boolean)', 'execute'
  ) or has_function_privilege(
    'anon', 'public.renew_tourism_collection_lease(uuid,uuid,integer,text,uuid,uuid,uuid)', 'execute'
  ) or has_function_privilege(
    'anon', 'public.release_tourism_collection_city_lease(uuid,uuid)', 'execute'
  ) then
    raise exception 'anon can execute a privileged cycle RPC';
  end if;
  if not has_function_privilege(
    'service_role', 'public.persist_tourism_cycle_source_page(uuid,uuid,text,uuid,text,jsonb,jsonb,jsonb,boolean)', 'execute'
  ) or not has_function_privilege(
    'service_role', 'public.renew_tourism_collection_lease(uuid,uuid,integer,text,uuid,uuid,uuid)', 'execute'
  ) or not has_function_privilege(
    'service_role', 'public.release_tourism_collection_city_lease(uuid,uuid)', 'execute'
  ) then
    raise exception 'service_role lacks a required cycle RPC grant';
  end if;
end;
$$;

rollback;
