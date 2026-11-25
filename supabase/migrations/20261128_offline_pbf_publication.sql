-- Explicit, audited browse-only publication from immutable offline OSM staging.
-- Apply after 20261126_route_readiness.sql and 20261127_public_places_api_compat.sql.
begin;

create table if not exists public.offline_pbf_publications (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique check (length(idempotency_key) between 16 and 160),
  snapshot_id text not null references public.offline_pbf_imports(snapshot_id),
  city_id uuid not null references public.tourism_cities(id),
  approval_reference text not null check (length(trim(approval_reference)) between 8 and 200),
  approved_by text not null check (length(trim(approved_by)) between 2 and 128),
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  record_count smallint not null check (record_count between 1 and 100),
  created_at timestamptz not null default now(),
  rolled_back_at timestamptz,
  rollback_reference text,
  rolled_back_by text,
  check ((rolled_back_at is null and rollback_reference is null and rolled_back_by is null) or
         (rolled_back_at is not null and length(trim(rollback_reference)) between 8 and 200 and length(trim(rolled_back_by)) between 2 and 128))
);

create table if not exists public.offline_pbf_publication_items (
  id bigint generated always as identity primary key,
  publication_id uuid not null references public.offline_pbf_publications(id),
  stage_row_id bigint not null references public.offline_pbf_stage_rows(id),
  source_key text not null,
  place_id uuid not null references public.tourism_places(id),
  category text not null check (category in ('attraction','food','accommodation','transport')),
  importance_score smallint not null check (importance_score between 0 and 100),
  importance_rationale text not null,
  importance_source_url text not null,
  source_record_sha256 text not null check (source_record_sha256 ~ '^[0-9a-f]{64}$'),
  published_record_state jsonb not null check (jsonb_typeof(published_record_state) = 'object'),
  published_link_state jsonb not null check (jsonb_typeof(published_link_state) = 'object'),
  created_at timestamptz not null default now(),
  unique(publication_id, source_key),
  unique(stage_row_id)
);
create index if not exists offline_pbf_publication_items_place_idx
  on public.offline_pbf_publication_items(place_id);

alter table public.offline_pbf_publications enable row level security;
alter table public.offline_pbf_publication_items enable row level security;
revoke all on public.offline_pbf_publications, public.offline_pbf_publication_items from public, anon, authenticated;
grant select, insert, update on public.offline_pbf_publications to service_role;
grant select, insert on public.offline_pbf_publication_items to service_role;
grant usage, select on sequence public.offline_pbf_publication_items_id_seq to service_role;

create or replace function public.promote_offline_pbf_records(
  p_idempotency_key text,
  p_snapshot_id text,
  p_city_id uuid,
  p_approval_reference text,
  p_approved_by text,
  p_records jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_batch public.offline_pbf_publications%rowtype;
  v_stage public.offline_pbf_stage_rows%rowtype;
  v_city public.tourism_cities%rowtype;
  v_place public.tourism_places%rowtype;
  v_record jsonb;
  v_sorted_records jsonb;
  v_hash text;
  v_source_key text;
  v_category text;
  v_wikidata_id text;
  v_exact_distance double precision;
  v_subcategory text;
  v_description text;
  v_description_source_url text;
  v_description_license text;
  v_published_state jsonb;
  v_link_state jsonb;
  v_inserted integer := 0;
  v_place_ids uuid[] := array[]::uuid[];
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 16 and 160
     or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{15,159}$'
     or p_snapshot_id is null or p_snapshot_id !~ '^sha256:[0-9a-f]{64}$'
     or p_city_id is null
     or p_approval_reference is null or length(trim(p_approval_reference)) not between 8 and 200
     or p_approved_by is null or length(trim(p_approved_by)) not between 2 and 128
     or jsonb_typeof(p_records) is distinct from 'array' then
    raise exception 'Invalid browse-only publication envelope';
  end if;
  if jsonb_array_length(p_records) not between 1 and 100 then raise exception 'Invalid browse-only publication size'; end if;
  if (select count(*) <> count(distinct e.value->>'source_key') from jsonb_array_elements(p_records) e(value)) then
    raise exception 'Duplicate source_key in approval batch';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_records) e(value)
    where jsonb_typeof(e.value) is distinct from 'object'
      or not (e.value ?& array['source_key','category','decision','importance_score','importance_rationale','importance_source_url'])
      or e.value - array['source_key','category','decision','importance_score','importance_rationale','importance_source_url',
                         'historical_summary','historical_summary_source_url','historical_summary_license'] <> '{}'::jsonb
      or e.value->>'decision' is distinct from 'approve_browse_only'
      or jsonb_typeof(e.value->'importance_score') is distinct from 'number'
      or coalesce((e.value->>'importance_score')::integer, -1) not between 0 and 100
      or length(trim(coalesce(e.value->>'importance_rationale',''))) not between 8 and 1000
      or coalesce(e.value->>'importance_source_url','') !~ '^https://[^[:space:]]+$'
      or ((e.value ? 'historical_summary') and (
           length(trim(coalesce(e.value->>'historical_summary',''))) not between 20 and 3000
           or coalesce(e.value->>'historical_summary_source_url','') !~ '^https://[^[:space:]]+$'
           or length(trim(coalesce(e.value->>'historical_summary_license',''))) not between 1 and 120))
      or ((e.value ? 'historical_summary_source_url' or e.value ? 'historical_summary_license') and not (e.value ? 'historical_summary'))
  ) then
    raise exception 'Invalid per-record browse-only approval or evidence';
  end if;

  select jsonb_agg(e.value order by e.value->>'source_key') into v_sorted_records
  from jsonb_array_elements(p_records) e(value);
  v_hash := encode(digest(jsonb_build_object(
    'snapshot_id', p_snapshot_id,
    'city_id', p_city_id,
    'approval_reference', trim(p_approval_reference),
    'approved_by', trim(p_approved_by),
    'records', v_sorted_records
  )::text, 'sha256'), 'hex');

  -- Serialize concurrent retries with the same key before checking/inserting the batch.
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key, 0));
  select * into v_batch from public.offline_pbf_publications
  where idempotency_key = p_idempotency_key for update;
  if found then
    if v_batch.request_sha256 is distinct from v_hash
       or v_batch.snapshot_id is distinct from p_snapshot_id
       or v_batch.city_id is distinct from p_city_id
       or v_batch.approval_reference is distinct from trim(p_approval_reference)
       or v_batch.approved_by is distinct from trim(p_approved_by) then
      raise exception 'Idempotency key reused with a different approval payload';
    end if;
    return jsonb_build_object(
      'publication_id', v_batch.id,
      'published_count', 0,
      'existing_count', v_batch.record_count,
      'idempotent_replay', true,
      'rolled_back', v_batch.rolled_back_at is not null,
      'place_ids', coalesce((select jsonb_agg(i.place_id order by i.source_key)
        from public.offline_pbf_publication_items i where i.publication_id=v_batch.id), '[]'::jsonb)
    );
  end if;

  perform 1 from public.offline_pbf_imports i
  where i.snapshot_id = p_snapshot_id and i.finalized_at is not null for update;
  if not found then raise exception 'Snapshot must be finalized before publication'; end if;
  select * into v_city from public.tourism_cities c where c.id=p_city_id for share;
  if not found or not v_city.is_enabled then raise exception 'Enabled publication city was not found'; end if;

  insert into public.offline_pbf_publications(
    idempotency_key,snapshot_id,city_id,approval_reference,approved_by,request_sha256,record_count
  ) values (
    p_idempotency_key,p_snapshot_id,p_city_id,trim(p_approval_reference),trim(p_approved_by),v_hash,jsonb_array_length(p_records)
  ) returning * into v_batch;

  for v_record in select e.value from jsonb_array_elements(v_sorted_records) e(value) order by e.value->>'source_key' loop
    v_source_key := v_record->>'source_key';
    v_category := v_record->>'category';
    if v_source_key !~ '^(node|way|relation)/[1-9][0-9]{0,18}$' then raise exception 'Invalid OSM source key'; end if;

    select * into v_stage from public.offline_pbf_stage_rows s
    where s.snapshot_id=p_snapshot_id and s.source_key=v_source_key
    for update;
    if not found or v_stage.disposition <> 'review_only' or v_stage.data_status <> 'needs_review'
       or v_stage.itinerary_ready or v_stage.name is null or length(trim(v_stage.name)) = 0
       or not (v_category = any(v_stage.categories))
       or v_stage.attribution is distinct from '© OpenStreetMap contributors'
       or v_stage.license is distinct from 'ODbL-1.0'
       or v_stage.source_url is distinct from 'https://www.openstreetmap.org/' || v_source_key
       or v_stage.latitude is null or v_stage.longitude is null
       or v_stage.latitude not between -90 and 90 or v_stage.longitude not between -180 and 180 then
      raise exception 'Approved source is absent, quarantined, changed, or outside its staged categories: %', v_source_key;
    end if;
    if exists (select 1 from public.offline_pbf_publication_items i where i.stage_row_id=v_stage.id) then
      raise exception 'Source identity was already handled by a different publication: %', v_source_key;
    end if;
    v_exact_distance := public.tourism_distance_km(v_city.latitude,v_city.longitude,v_stage.latitude,v_stage.longitude);
    if v_exact_distance > v_city.radius_km + 0.001 or abs(v_exact_distance-v_stage.distance_km) > 0.001 then
      raise exception 'Source feature is outside the selected city radius or its distance evidence changed: %', v_source_key;
    end if;

    v_wikidata_id := nullif(v_stage.raw_tags->>'wikidata','');
    if v_wikidata_id is not null and v_wikidata_id !~ '^Q[1-9][0-9]*$' then
      raise exception 'Invalid staged Wikidata identifier for source %', v_source_key;
    end if;
    if exists (select 1 from public.tourism_places p where p.osm_type=v_stage.source_type and p.osm_id=v_stage.source_id)
       or (v_wikidata_id is not null and exists (select 1 from public.tourism_places p where p.wikidata_id=v_wikidata_id))
       or exists (select 1 from public.tourism_place_sources s where s.source_name='openstreetmap' and s.source_id=v_source_key) then
      raise exception 'Source identity conflicts with an existing canonical place and requires manual reconciliation: %', v_source_key;
    end if;

    v_subcategory := coalesce(nullif(v_stage.raw_tags->>'tourism','attraction'),
                              nullif(v_stage.raw_tags->>'historic',''),
                              nullif(v_stage.raw_tags->>'amenity',''));
    v_description := nullif(trim(v_record->>'historical_summary'),'');
    v_description_source_url := nullif(trim(v_record->>'historical_summary_source_url'),'');
    v_description_license := nullif(trim(v_record->>'historical_summary_license'),'');
    insert into public.tourism_places(
      canonical_name,category,subcategory,latitude,longitude,description,description_source,description_license,
      wikidata_id,osm_type,osm_id,importance_score,review_status,is_active,route_ready
    ) values (
      v_stage.name,v_category,v_subcategory,v_stage.latitude,v_stage.longitude,v_description,v_description_source_url,
      v_description_license,v_wikidata_id,v_stage.source_type,v_stage.source_id,
      (v_record->>'importance_score')::smallint,'approved',true,false
    ) returning * into v_place;

    insert into public.tourism_place_sources(
      place_id,source_name,source_id,source_url,attribution,license,payload
    ) values (
      v_place.id,'openstreetmap',v_source_key,v_stage.source_url,v_stage.attribution,v_stage.license,
      jsonb_strip_nulls(jsonb_build_object(
        'snapshot_id',p_snapshot_id,
        'source_snapshot',v_stage.source_snapshot,
        'dataset_snapshot_id',v_stage.raw_record->>'dataset_snapshot_id',
        'source_content_sha256',v_stage.raw_record->>'source_content_sha256',
        'geometry_method',v_stage.geometry_method
      ))
    );
    insert into public.tourism_city_places(city_id,place_id,distance_km,relevance_score,is_current)
    values (p_city_id,v_place.id,v_exact_distance,(v_record->>'importance_score')::integer,true);

    v_published_state := jsonb_build_object(
      'canonical_name',v_place.canonical_name,'category',v_place.category,'subcategory',v_place.subcategory,
      'latitude',v_place.latitude,'longitude',v_place.longitude,'description',v_place.description,
      'description_source',v_place.description_source,'description_license',v_place.description_license,
      'wikidata_id',v_place.wikidata_id,'osm_type',v_place.osm_type,'osm_id',v_place.osm_id,
      'importance_score',v_place.importance_score,'review_status',v_place.review_status,
      'is_active',v_place.is_active,'route_ready',v_place.route_ready
    );
    v_link_state := jsonb_build_object(
      'city_id',p_city_id,'place_id',v_place.id,'distance_km',v_exact_distance,
      'relevance_score',(v_record->>'importance_score')::integer,'is_current',true
    );
    insert into public.offline_pbf_publication_items(
      publication_id,stage_row_id,source_key,place_id,category,importance_score,importance_rationale,
      importance_source_url,source_record_sha256,published_record_state,published_link_state
    ) values (
      v_batch.id,v_stage.id,v_source_key,v_place.id,v_category,(v_record->>'importance_score')::smallint,
      trim(v_record->>'importance_rationale'),trim(v_record->>'importance_source_url'),
      encode(digest(v_stage.raw_record::text,'sha256'),'hex'),v_published_state,v_link_state
    );
    v_inserted := v_inserted + 1;
    v_place_ids := array_append(v_place_ids,v_place.id);
  end loop;

  return jsonb_build_object(
    'publication_id',v_batch.id,'published_count',v_inserted,'existing_count',0,
    'idempotent_replay',false,'rolled_back',false,'place_ids',to_jsonb(v_place_ids)
  );
end;
$$;
revoke all on function public.promote_offline_pbf_records(text,text,uuid,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.promote_offline_pbf_records(text,text,uuid,text,text,jsonb) to service_role;

create or replace function public.rollback_offline_pbf_publication(
  p_idempotency_key text,
  p_rollback_reference text,
  p_rolled_back_by text
) returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_batch public.offline_pbf_publications%rowtype;
  v_item public.offline_pbf_publication_items%rowtype;
  v_place public.tourism_places%rowtype;
  v_link public.tourism_city_places%rowtype;
  v_count integer := 0;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 16 and 160
     or p_rollback_reference is null or length(trim(p_rollback_reference)) not between 8 and 200
     or p_rolled_back_by is null or length(trim(p_rolled_back_by)) not between 2 and 128 then
    raise exception 'Invalid publication rollback envelope';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('rollback:' || p_idempotency_key,0));
  select * into v_batch from public.offline_pbf_publications b
  where b.idempotency_key=p_idempotency_key for update;
  if not found then raise exception 'Publication batch not found'; end if;
  if v_batch.rolled_back_at is not null then
    if v_batch.rollback_reference is distinct from trim(p_rollback_reference)
       or v_batch.rolled_back_by is distinct from trim(p_rolled_back_by) then
      raise exception 'Publication batch was already rolled back under a different reference';
    end if;
    return jsonb_build_object('publication_id',v_batch.id,'rolled_back_count',v_batch.record_count,'already_rolled_back',true);
  end if;

  for v_item in select i.* from public.offline_pbf_publication_items i
    where i.publication_id=v_batch.id order by i.source_key for update
  loop
    select * into v_place from public.tourism_places p where p.id=v_item.place_id for update;
    if not found then raise exception 'Published place is absent; manual rollback review required: %',v_item.source_key; end if;
    select * into v_link from public.tourism_city_places cp
    where cp.place_id=v_item.place_id and cp.city_id=v_batch.city_id for update;
    if not found then raise exception 'Published city link is absent; manual rollback review required: %',v_item.source_key; end if;
    if not (to_jsonb(v_place) @> v_item.published_record_state) or not (to_jsonb(v_link) @> v_item.published_link_state) then
      raise exception 'Published place changed after release; manual rollback review required: %',v_item.source_key;
    end if;
    update public.tourism_city_places set is_current=false
    where city_id=v_batch.city_id and place_id=v_item.place_id;
    update public.tourism_places set review_status='rejected',is_active=false,route_ready=false,updated_at=now()
    where id=v_item.place_id;
    v_count := v_count + 1;
  end loop;
  if v_count <> v_batch.record_count then raise exception 'Publication audit count does not match batch count'; end if;
  update public.offline_pbf_publications
  set rolled_back_at=now(),rollback_reference=trim(p_rollback_reference),rolled_back_by=trim(p_rolled_back_by)
  where id=v_batch.id;
  return jsonb_build_object('publication_id',v_batch.id,'rolled_back_count',v_count,'already_rolled_back',false);
end;
$$;
revoke all on function public.rollback_offline_pbf_publication(text,text,text) from public, anon, authenticated;
grant execute on function public.rollback_offline_pbf_publication(text,text,text) to service_role;

commit;
