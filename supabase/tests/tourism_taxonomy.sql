-- Isolated PostgreSQL/PostGIS CI database only. Run after the complete migration chain.
begin;

do $$
declare
  v_snapshot text := 'sha256:' || repeat('a', 64);
  v_source_key text := 'node/900000001';
  v_tags jsonb := '{"natural":"water","water":"lake","tourism":"viewpoint"}'::jsonb;
  v_city uuid;
  v_place uuid;
  v_stage bigint;
  v_publication uuid;
  v_taxonomy jsonb;
begin
  if not exists (select 1 from pg_extension where extname = 'postgis') then
    raise exception 'PostGIS extension is unavailable in migration test database';
  end if;

  v_taxonomy := public.classify_osm_tourism_tags(v_tags, 'attraction', 80, null);
  if not (v_taxonomy->'categories' ? 'lakes') or not (v_taxonomy->'categories' ? 'scenic_spots')
     or v_taxonomy->>'recommendationEligible' <> 'true' then
    raise exception 'Lake/viewpoint did not receive both supported tourism categories';
  end if;
  v_taxonomy := public.classify_osm_tourism_tags('{"shop":"mall"}'::jsonb, 'attraction', 0, null);
  if not (v_taxonomy->'categories' ? 'shopping_malls') then raise exception 'Mall tag classification failed'; end if;
  v_taxonomy := public.classify_osm_tourism_tags('{"tourism":"museum"}'::jsonb, 'attraction', 0, null);
  if not (v_taxonomy->'categories' ? 'museums') then raise exception 'Museum tag classification failed'; end if;
  v_taxonomy := public.classify_osm_tourism_tags('{"building":"apartments","tourism":"apartment"}'::jsonb, 'accommodation', 0, null);
  if v_taxonomy->>'recommendationEligible' <> 'false'
     or not (v_taxonomy->'exclusionReasons' ? 'unverified_tourist_apartment') then
    raise exception 'Unverified residential accommodation was not excluded';
  end if;

  insert into public.tourism_cities(name, state_name, latitude, longitude, radius_km, is_enabled)
  values ('Taxonomy CI Fixture', 'Test State', 17.4, 78.4, 40, true) returning id into v_city;
  insert into public.offline_pbf_imports(snapshot_id, source_snapshot, source_checksum, expected_total, attribution, license)
  values (v_snapshot, '2026-11-27T00:00:00Z', repeat('a', 64), 1, chr(169) || ' OpenStreetMap contributors', 'ODbL-1.0');
  insert into public.offline_pbf_stage_rows(
    snapshot_id, source_type, source_id, source_key, name, categories, latitude, longitude,
    distance_km, area_class, importance_evidence_score, importance_signals, raw_tags,
    geometry_method, source_url, source_snapshot, attribution, license, data_status,
    itinerary_ready, disposition, raw_record
  ) values (
    v_snapshot, 'node', 900000001, v_source_key, 'Taxonomy Lake Viewpoint', array['attraction'],
    17.4, 78.4, 1, 'core_hyderabad', 8, array['wikidata'], v_tags,
    'osm_node_coordinate', 'https://www.openstreetmap.org/' || v_source_key,
    '2026-11-27T00:00:00Z', chr(169) || ' OpenStreetMap contributors', 'ODbL-1.0',
    'needs_review', false, 'review_only', '{}'::jsonb
  ) returning id into v_stage;
  insert into public.tourism_places(canonical_name, category, latitude, longitude, osm_type, osm_id, importance_score)
  values ('Taxonomy Lake Viewpoint', 'attraction', 17.4, 78.4, 'node', 900000001, 80) returning id into v_place;
  insert into public.tourism_place_sources(place_id, source_name, source_id, source_url, attribution, license, payload)
  values (v_place, 'openstreetmap', v_source_key, 'https://www.openstreetmap.org/' || v_source_key,
    chr(169) || ' OpenStreetMap contributors', 'ODbL-1.0', jsonb_build_object('tags', v_tags));
  insert into public.offline_pbf_publications(
    idempotency_key, snapshot_id, city_id, approval_reference, approved_by, request_sha256, record_count
  ) values ('taxonomy-ci-approval-0001', v_snapshot, v_city, 'CI taxonomy fixture', 'CI Owner', repeat('b', 64), 1)
  returning id into v_publication;
  insert into public.offline_pbf_publication_items(
    publication_id, stage_row_id, source_key, place_id, category, importance_score,
    importance_rationale, importance_source_url, source_record_sha256,
    published_record_state, published_link_state
  ) values (
    v_publication, v_stage, v_source_key, v_place, 'attraction', 80, 'CI-only fixture',
    'https://example.test/importance', repeat('c', 64), '{}'::jsonb, '{}'::jsonb
  );
  select payload->'localise_taxonomy' into v_taxonomy
  from public.tourism_place_sources where place_id = v_place and source_id = v_source_key;
  if v_taxonomy is null or not (v_taxonomy->'categories' ? 'lakes')
     or not (v_taxonomy->'categories' ? 'scenic_spots')
     or v_taxonomy->>'recommendationEligible' <> 'true' then
    raise exception 'Publication trigger did not persist the OSM taxonomy in protected source provenance';
  end if;
  if has_function_privilege('anon', 'public.classify_osm_tourism_tags(jsonb,text,integer,text)', 'execute')
     or has_function_privilege('authenticated', 'public.classify_osm_tourism_tags(jsonb,text,integer,text)', 'execute') then
    raise exception 'Untrusted database roles can call the taxonomy RPC';
  end if;
end;
$$;

rollback;
