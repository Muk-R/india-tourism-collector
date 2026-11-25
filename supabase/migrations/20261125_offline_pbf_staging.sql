-- Private, additive intake for immutable offline OSM PBF snapshots.
-- Staged records remain review-only and are deliberately disconnected from public place tables.
create table if not exists public.offline_pbf_imports (
  snapshot_id text primary key check (length(snapshot_id) between 16 and 160),
  source_snapshot text not null,
  source_checksum text not null check (source_checksum ~ '^[0-9a-f]{64}$'),
  expected_total integer not null check (expected_total > 0),
  created_at timestamptz not null default now(),
  attribution text not null check (attribution = '© OpenStreetMap contributors'),
  license text not null check (license = 'ODbL-1.0'),
  finalized_at timestamptz
);
alter table public.offline_pbf_imports add column if not exists finalized_at timestamptz;

create table if not exists public.offline_pbf_stage_rows (
  id bigint generated always as identity primary key,
  snapshot_id text not null references public.offline_pbf_imports(snapshot_id),
  source_type text not null check (source_type in ('node','way','relation')),
  source_id bigint not null check (source_id > 0),
  source_key text not null,
  name text,
  categories text[] not null check (cardinality(categories) > 0),
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  distance_km double precision not null check (distance_km between 0 and 150.001),
  area_class text not null check (area_class in ('core_hyderabad','nearby_escape_candidate')),
  importance_evidence_score smallint not null check (importance_evidence_score between 0 and 10),
  importance_signals text[] not null,
  raw_tags jsonb not null check (jsonb_typeof(raw_tags) = 'object'),
  geometry_method text not null,
  source_url text not null,
  source_snapshot text not null,
  attribution text not null,
  license text not null,
  data_status text not null check (data_status = 'needs_review'),
  itinerary_ready boolean not null default false check (itinerary_ready = false),
  disposition text not null check (disposition in ('review_only','quarantine')),
  quarantine_reason text,
  raw_record jsonb not null check (jsonb_typeof(raw_record) = 'object'),
  inserted_at timestamptz not null default now(),
  unique(snapshot_id, source_key),
  unique(snapshot_id, source_type, source_id),
  check (source_key = source_type || '/' || source_id::text),
  check (source_url = 'https://www.openstreetmap.org/' || source_key),
  check (attribution = '© OpenStreetMap contributors'),
  check (license = 'ODbL-1.0'),
  check ((disposition = 'quarantine' and quarantine_reason = 'missing_name') or
         (disposition = 'review_only' and quarantine_reason is null and length(trim(name)) > 0))
);

create index if not exists offline_pbf_stage_rows_snapshot_disposition_idx
  on public.offline_pbf_stage_rows(snapshot_id, disposition);

alter table public.offline_pbf_imports enable row level security;
alter table public.offline_pbf_stage_rows enable row level security;
revoke all on public.offline_pbf_imports, public.offline_pbf_stage_rows from public, anon, authenticated;
grant select, insert, update on public.offline_pbf_imports, public.offline_pbf_stage_rows to service_role;
grant usage, select on sequence public.offline_pbf_stage_rows_id_seq to service_role;

create or replace function public.import_offline_pbf_batch(
  p_snapshot_id text,
  p_source_snapshot text,
  p_source_checksum text,
  p_expected_total integer,
  p_records jsonb
) returns table(inserted_count integer, existing_count integer, review_only_count integer, quarantine_count integer)
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  r jsonb;
  v_type text;
  v_id bigint;
  v_key text;
  v_name text;
  v_categories text[];
  v_lat double precision;
  v_lon double precision;
  v_dist double precision;
  v_area text;
  v_exact_dist double precision;
  v_disposition text;
  v_reason text;
  v_inserted integer := 0;
  v_existing integer := 0;
  v_review integer := 0;
  v_quarantine integer := 0;
begin
  if p_snapshot_id is null or length(p_snapshot_id) not between 16 and 160 or
     p_source_snapshot is null or length(p_source_snapshot) > 128 or
     p_source_checksum !~ '^[0-9a-f]{64}$' or p_expected_total not between 1 and 100000 or
     jsonb_typeof(p_records) <> 'array' or jsonb_array_length(p_records) not between 1 and 500 then
    raise exception 'Invalid offline PBF batch envelope';
  end if;
  if p_snapshot_id <> 'sha256:' || p_source_checksum then
    raise exception 'snapshot_id must be derived from the source checksum';
  end if;
  if (select count(*) <> count(distinct e.value->>'source_key') from jsonb_array_elements(p_records) e) then
    raise exception 'Duplicate source_key within batch';
  end if;

  insert into public.offline_pbf_imports(snapshot_id, source_snapshot, source_checksum, expected_total, attribution, license)
  values (p_snapshot_id, p_source_snapshot, p_source_checksum, p_expected_total,
          '© OpenStreetMap contributors', 'ODbL-1.0')
  on conflict (snapshot_id) do nothing;
  if not exists (select 1 from public.offline_pbf_imports i where i.snapshot_id = p_snapshot_id
                 and i.source_snapshot = p_source_snapshot and i.source_checksum = p_source_checksum
                 and i.expected_total = p_expected_total) then
    raise exception 'Snapshot metadata conflicts with existing import';
  end if;

  for r in select value from jsonb_array_elements(p_records) loop
    v_type := r->>'source_type';
    v_id := (r->>'source_id')::bigint;
    v_key := r->>'source_key';
    v_name := nullif(trim(r->>'name'), '');
    if v_type not in ('node','way','relation') or v_id <= 0 or v_key <> v_type || '/' || v_id::text then
      raise exception 'Invalid OSM source identity';
    end if;
    if r->>'source_url' <> 'https://www.openstreetmap.org/' || v_key or
       r->>'attribution' <> '© OpenStreetMap contributors' or r->>'license' <> 'ODbL-1.0' or
       r->>'source_snapshot' <> p_source_snapshot or r->>'data_status' <> 'needs_review' or
       coalesce(r->>'itinerary_ready','') not in ('false','0') then
      raise exception 'Invalid provenance or review-only fields';
    end if;
    if jsonb_typeof(r->'raw_tags') <> 'object' or jsonb_typeof(r->'categories') <> 'array' or
       jsonb_array_length(r->'categories') = 0 or jsonb_typeof(r->'importance_signals') <> 'array' then
      raise exception 'Invalid raw tags, categories, or evidence';
    end if;
    if exists (select 1 from jsonb_array_elements_text(r->'categories') c(value)
               where c.value not in ('attraction','accommodation','food','transport')) then
      raise exception 'Invalid category';
    end if;
    select array_agg(value order by ordinality) into v_categories
      from jsonb_array_elements_text(r->'categories') with ordinality;
    v_lat := (r->>'latitude')::double precision;
    v_lon := (r->>'longitude')::double precision;
    v_dist := (r->>'distance_km')::double precision;
    v_area := r->>'area_class';
    v_exact_dist := 6371 * 2 * asin(sqrt(
      power(sin(radians(v_lat - 17.385) / 2), 2) +
      cos(radians(17.385)) * cos(radians(v_lat)) * power(sin(radians(v_lon - 78.4867) / 2), 2)));
    if v_dist < 0 or v_dist > 150.001 or abs(v_dist-v_exact_dist) > 0.001 or
       v_area <> (case when v_exact_dist <= 40 then 'core_hyderabad' else 'nearby_escape_candidate' end) or
       (v_area = 'nearby_escape_candidate' and not ('attraction' = any(v_categories))) then
      raise exception 'Invalid distance or area classification';
    end if;
    if (r->>'importance_evidence_score')::integer not between 0 and 10 or
       coalesce(r->>'geometry_method','') = '' then raise exception 'Invalid staging evidence'; end if;
    v_disposition := case when v_name is null then 'quarantine' else 'review_only' end;
    v_reason := case when v_name is null then 'missing_name' else null end;

    if exists (select 1 from public.offline_pbf_imports i where i.snapshot_id=p_snapshot_id and i.finalized_at is not null)
       and not exists (select 1 from public.offline_pbf_stage_rows s where s.snapshot_id=p_snapshot_id
                       and s.source_key=v_key and s.raw_record=r) then
      raise exception 'Finalized snapshot is immutable';
    end if;

    insert into public.offline_pbf_stage_rows(
      snapshot_id,source_type,source_id,source_key,name,categories,latitude,longitude,distance_km,area_class,
      importance_evidence_score,importance_signals,raw_tags,geometry_method,source_url,source_snapshot,
      attribution,license,data_status,itinerary_ready,disposition,quarantine_reason,raw_record
    ) values (
      p_snapshot_id,v_type,v_id,v_key,v_name,v_categories,v_lat,v_lon,v_dist,v_area,
      (r->>'importance_evidence_score')::smallint,
      array(select jsonb_array_elements_text(r->'importance_signals')),
      r->'raw_tags',r->>'geometry_method',r->>'source_url',r->>'source_snapshot',r->>'attribution',r->>'license',
      'needs_review',false,v_disposition,v_reason,r
    ) on conflict (snapshot_id, source_key) do nothing;
    if found then
      v_inserted := v_inserted + 1;
      if v_disposition = 'quarantine' then v_quarantine := v_quarantine + 1;
      else v_review := v_review + 1; end if;
    else
      if not exists (select 1 from public.offline_pbf_stage_rows s where s.snapshot_id=p_snapshot_id
                     and s.source_key=v_key and s.raw_record=r) then
        raise exception 'Source key conflicts with different payload: %', v_key;
      end if;
      v_existing := v_existing + 1;
    end if;
  end loop;
  return query select v_inserted,v_existing,v_review,v_quarantine;
end;
$$;

revoke all on function public.import_offline_pbf_batch(text,text,text,integer,jsonb) from public, anon, authenticated;
grant execute on function public.import_offline_pbf_batch(text,text,text,integer,jsonb) to service_role;

create or replace function public.finalize_offline_pbf_import(p_snapshot_id text)
returns table(total_count integer, review_only_count integer, quarantine_count integer)
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_expected integer;
  v_total integer;
  v_review integer;
  v_quarantine integer;
begin
  select expected_total into v_expected from public.offline_pbf_imports where snapshot_id=p_snapshot_id for update;
  if not found then raise exception 'Offline PBF snapshot not found'; end if;
  select count(*)::integer,
         count(*) filter (where disposition='review_only')::integer,
         count(*) filter (where disposition='quarantine')::integer
    into v_total,v_review,v_quarantine
    from public.offline_pbf_stage_rows where snapshot_id=p_snapshot_id;
  if v_total <> v_expected then
    raise exception 'Snapshot count mismatch: expected %, found %', v_expected, v_total;
  end if;
  update public.offline_pbf_imports set finalized_at=coalesce(finalized_at,now()) where snapshot_id=p_snapshot_id;
  return query select v_total,v_review,v_quarantine;
end;
$$;
revoke all on function public.finalize_offline_pbf_import(text) from public, anon, authenticated;
grant execute on function public.finalize_offline_pbf_import(text) to service_role;
