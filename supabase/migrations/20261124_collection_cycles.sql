-- DRAFT ONLY: review and coordinate with the Worker change before execution.
-- This migration is additive for records and links. It does not delete places,
-- sources, existing queue rows, or city-place links.
--
-- Rollout prerequisites:
--   1. Pause collection and drain/expire existing Worker claims.
--   2. Apply this migration to staging only after independent review.
--   3. Deploy a Worker version that uses the cycle/lease RPCs in this file.
--   4. Resume collection only after legacy cycles with unverified radii are reviewed.
-- Compatibility: the current Worker does not use these tables/RPCs and cannot
-- safely run against radii above 50 km. Do not resume it after this migration
-- until the coordinated Worker release is ready.
-- Rollback: before new Worker writes, leave this additive schema in place and
-- resume the old Worker only if all city radii remain <= 50. After cycle writes,
-- pause collection and forward-reconcile or restore from a reviewed backup;
-- do not drop cycle tables/columns or silently switch queue implementations.
-- Staging-only verification plan (never run on production):
--   * Compare counts for places, place_sources, city_places, and legacy queue
--     before/after migration; all must remain unchanged.
--   * Verify radii 10 and 150 accepted, 9 and 151 rejected, and fractional RPC
--     values rejected by the integer parameter type.
--   * Persist two discovery pages, replay the first page key, and simulate a
--     transaction interruption; cursor and queue writes must be atomic.
--   * Verify successful pages change pages_completed but not attempts; source
--     failures and expired leases alone consume the bounded failure budget.
--   * Race two city claims and test stale city/source/item lease calls fail.
--   * Reobserve a manual link and verify it remains unmanaged; incomplete or
--     exhausted cycles must not retire links; complete cycles retire only
--     collector-managed, unseen links.
--   * Verify unverified legacy radii are excluded from automatic claims and
--     source-identity mismatches abort without changing source/place rows.
-- Lock order for every RPC that mutates cycle work is fixed: city, cycle,
-- source, item, then place/link rows. Keep this order in the Worker RPC contract.
-- The collector is intentionally sequential per city for the pilot. A city row
-- lock fences every operation in its cycle; no parallel city-item worker pool
-- is required for correctness.

begin;

-- Backfill preflight: the legacy queue has no upper bound on attempts. Abort
-- before copying anything if a row exceeds the new bounded retry envelope.
do $$
begin
  if exists (
    select 1 from public.tourism_collection_items where attempts > 20
  ) then
    raise exception 'legacy queue attempts exceed 20; review those rows before migration';
  end if;
end;
$$;

-- Keep the existing city radius column and raise only its allowed range.
-- Existing values are already constrained to 10..50 by the current schema.
alter table public.tourism_cities
  drop constraint if exists tourism_cities_radius_km_check;
alter table public.tourism_cities
  add constraint tourism_cities_radius_km_check
  check (radius_km between 10 and 150) not valid;
alter table public.tourism_cities
  validate constraint tourism_cities_radius_km_check;

alter table public.tourism_ingestion_runs
  add constraint tourism_ingestion_runs_radius_km_range_check
  check (radius_km is null or radius_km between 10 and 150) not valid;
-- Keep historical run rows unvalidated so unusual legacy values do not block
-- rollout. NOT VALID still rejects out-of-range new/updated rows; audit and
-- validate this constraint in staging before production rollout.

-- A cycle is an immutable unit of work for one city at one radius. Lease tokens
-- fence old Worker invocations after rediscovery or lease expiry.
create table if not exists public.tourism_collection_cycles (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references public.tourism_cities(id) on delete cascade,
  radius_km int not null check (radius_km between 10 and 150),
  radius_verified boolean not null default true,
  is_legacy boolean not null default false,
  status text not null default 'pending' check (status in (
    'pending', 'processing', 'retry_wait', 'ready_to_finalize', 'partial', 'completed',
    'failed', 'exhausted', 'legacy_review', 'superseded'
  )),
  reconcile_links boolean not null default false,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_claimed_at timestamptz,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  unique (city_id, id)
);

alter table public.tourism_cities
  add column if not exists active_collection_cycle_id uuid
  references public.tourism_collection_cycles(id) on delete set null;
alter table public.tourism_cities
  add constraint tourism_cities_active_cycle_owner_fkey
  foreign key (id, active_collection_cycle_id)
  references public.tourism_collection_cycles(city_id, id) not valid;
alter table public.tourism_cities
  validate constraint tourism_cities_active_cycle_owner_fkey;

create index if not exists tourism_collection_cycles_city_status_idx
  on public.tourism_collection_cycles(city_id, status, last_claimed_at);
create unique index if not exists tourism_collection_cycles_one_active_per_city_idx
  on public.tourism_collection_cycles(city_id)
  where status in ('pending', 'processing', 'retry_wait', 'ready_to_finalize', 'partial');

-- Source state makes discovery retries durable and independent. cursor stores
-- source-specific pagination state; complete=false means the source may not be
-- used to retire links. A capped response must be continued or marked truncated.
create table if not exists public.tourism_collection_cycle_sources (
  cycle_id uuid not null references public.tourism_collection_cycles(id) on delete cascade,
  source_name text not null check (source_name in ('openstreetmap', 'wikidata')),
  status text not null default 'pending' check (status in (
    'pending', 'processing', 'retry_wait', 'completed', 'exhausted',
    'truncated', 'superseded'
  )),
  -- attempts counts failed source attempts only; pages_completed is progress.
  attempts int not null default 0 check (attempts >= 0),
  max_attempts int not null default 5 check (max_attempts between 1 and 20),
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  cursor jsonb,
  pages_completed int not null default 0 check (pages_completed >= 0),
  items_discovered bigint not null default 0 check (items_discovered >= 0),
  is_complete boolean not null default false,
  last_attempt_at timestamptz,
  completed_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (cycle_id, source_name),
  check (status <> 'completed' or is_complete)
);

create index if not exists tourism_collection_cycle_sources_due_idx
  on public.tourism_collection_cycle_sources(status, next_attempt_at, cycle_id);

-- A page ledger and queue inserts commit with cursor advancement in one RPC.
-- Replaying a committed page key is idempotent; a crash before commit advances
-- neither the cursor nor the queue.
create table if not exists public.tourism_collection_cycle_source_pages (
  cycle_id uuid not null,
  source_name text not null,
  page_key text not null,
  expected_cursor jsonb,
  next_cursor jsonb,
  items_discovered int not null check (items_discovered >= 0),
  is_complete boolean not null,
  -- Store canonical JSONB itself so replay checks do not rely on a collision-
  -- prone digest and compare arrays/objects using PostgreSQL JSONB semantics.
  items_payload jsonb not null check (jsonb_typeof(items_payload) = 'array'),
  created_at timestamptz not null default now(),
  primary key (cycle_id, source_name, page_key),
  foreign key (cycle_id, source_name)
    references public.tourism_collection_cycle_sources(cycle_id, source_name)
    on delete cascade
);

-- Keep cycle work separately from the legacy queue so existing records remain
-- intact. New Worker versions must read/write this table and must not infer
-- source completeness from a page reaching its result limit.
create table if not exists public.tourism_collection_cycle_items (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references public.tourism_collection_cycles(id) on delete cascade,
  source_name text not null check (source_name in ('openstreetmap', 'wikidata')),
  source_id text not null,
  raw_payload jsonb not null,
  status text not null default 'pending' check (status in (
    'pending', 'processing', 'completed', 'failed', 'exhausted', 'superseded'
  )),
  attempts int not null default 0 check (attempts >= 0),
  max_attempts int not null default 3 check (max_attempts between 1 and 20),
  available_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  priority_score smallint not null default 0 check (priority_score between 0 and 100),
  priority_reasons text[] not null default '{}',
  last_error text,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (cycle_id, source_name, source_id)
);

create index if not exists tourism_collection_cycle_items_due_idx
  on public.tourism_collection_cycle_items(cycle_id, status, available_at,
    priority_score desc, created_at);
create index if not exists tourism_collection_cycle_items_expired_lease_idx
  on public.tourism_collection_cycle_items(cycle_id, lease_expires_at)
  where status = 'processing';

-- Internal checkpoint: a cycle becomes claimable for finalization only after
-- both sources and all items have reached a terminal state.
create or replace function public.mark_tourism_cycle_ready_to_finalize(p_cycle_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.tourism_collection_cycles cy
  set status = 'ready_to_finalize'
  where cy.id = p_cycle_id
    and cy.status not in ('completed', 'failed', 'exhausted', 'legacy_review', 'superseded')
    and (select count(*) from public.tourism_collection_cycle_sources s
         where s.cycle_id = p_cycle_id) = 2
    and not exists (
      select 1 from public.tourism_collection_cycle_sources s
      where s.cycle_id = p_cycle_id
        and s.status not in ('completed', 'exhausted', 'superseded')
    )
    and not exists (
      select 1 from public.tourism_collection_cycle_items i
      where i.cycle_id = p_cycle_id
        and i.status not in ('completed', 'exhausted', 'superseded')
    );
end;
$$;
revoke all on function public.mark_tourism_cycle_ready_to_finalize(uuid)
  from public, anon, authenticated, service_role;

-- Preserve every existing link. Legacy links are marked unmanaged because the
-- old schema cannot distinguish collector-created links from manual curation.
alter table public.tourism_city_places
  add column if not exists is_current boolean not null default true,
  add column if not exists managed_by_collector boolean not null default false,
  add column if not exists last_seen_cycle_id uuid
    references public.tourism_collection_cycles(id) on delete set null;

alter table public.tourism_places
  add column if not exists importance_score smallint not null default 0
    check (importance_score between 0 and 100);

-- Replace the baseline upsert with a serialized, identity-aware version. The
-- single transaction lock is intentionally simple for the sequential pilot.
-- Existing coordinates are canonical once a row has been matched.
create or replace function public.upsert_tourism_place(p jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_osm_match uuid;
  v_wikidata_match uuid;
  v_name text := coalesce(nullif(trim(p->>'canonical_name'), ''), 'Unnamed place');
  v_lat double precision := nullif(p->>'latitude', '')::double precision;
  v_lon double precision := nullif(p->>'longitude', '')::double precision;
  v_osm_type text := nullif(p->>'osm_type', '');
  v_osm_id bigint := nullif(p->>'osm_id', '')::bigint;
  v_wikidata_id text := nullif(p->>'wikidata_id', '');
  v_description text := nullif(trim(p->>'description'), '');
  v_description_source text := nullif(p->>'description_source', '');
  v_description_license text := nullif(p->>'description_license', '');
  v_importance int := coalesce(nullif(p->>'importance_score', '')::int, 0);
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'place payload must be an object'; end if;
  if v_lat is null or v_lon is null or v_lat not between -90 and 90
     or v_lon not between -180 and 180 then
    raise exception 'valid place coordinates are required';
  end if;
  if (v_osm_type is null) <> (v_osm_id is null) then
    raise exception 'OSM type and id must be supplied together';
  end if;
  if v_importance not between 0 and 100 then
    raise exception 'importance_score must be an integer from 0 through 100';
  end if;
  if v_description is null then
    v_description_source := null;
    v_description_license := null;
  elsif not ((v_description_source = 'Wikipedia' and v_description_license = 'CC BY-SA')
          or (v_description_source = 'Wikidata' and v_description_license = 'CC0')) then
    raise exception 'description source and license do not form a supported pair';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('tourism-place-upsert-v1', 0));
  if v_osm_type is not null then
    select p0.id into v_osm_match from public.tourism_places p0
    where p0.osm_type = v_osm_type and p0.osm_id = v_osm_id;
  end if;
  if v_wikidata_id is not null then
    select p0.id into v_wikidata_match from public.tourism_places p0
    where p0.wikidata_id = v_wikidata_id;
  end if;
  if v_osm_match is not null and v_wikidata_match is not null
     and v_osm_match <> v_wikidata_match then
    raise exception 'OSM and Wikidata identities resolve to different canonical places';
  end if;
  v_id := coalesce(v_osm_match, v_wikidata_match);

  if v_id is null then
    select p0.id into v_id from public.tourism_places p0
    where p0.normalized_name = lower(regexp_replace(trim(v_name), '\s+', ' ', 'g'))
      and public.tourism_distance_km(p0.latitude, p0.longitude, v_lat, v_lon) <= 0.12
      and (v_osm_type is null or p0.osm_type is null
           or (p0.osm_type = v_osm_type and p0.osm_id = v_osm_id))
      and (v_wikidata_id is null or p0.wikidata_id is null
           or p0.wikidata_id = v_wikidata_id)
    order by public.tourism_distance_km(p0.latitude, p0.longitude, v_lat, v_lon)
    limit 1;
  end if;

  if v_id is null then
    insert into public.tourism_places (
      canonical_name, category, subcategory, latitude, longitude, address,
      description, description_source, description_license, website_url, phone,
      wikipedia_url, wikidata_id, osm_type, osm_id, image_url, image_source_url,
      image_author, image_license, quality_score, importance_score
    ) values (
      v_name, p->>'category', p->>'subcategory', v_lat, v_lon, p->>'address',
      v_description, v_description_source, v_description_license, p->>'website_url',
      p->>'phone', p->>'wikipedia_url', v_wikidata_id, v_osm_type, v_osm_id,
      p->>'image_url', p->>'image_source_url', p->>'image_author', p->>'image_license',
      coalesce(nullif(p->>'quality_score', '')::int, 0), v_importance
    ) returning id into v_id;
  else
    update public.tourism_places p0 set
      canonical_name = case when length(v_name) > length(p0.canonical_name)
                            then v_name else p0.canonical_name end,
      category = coalesce(p0.category, p->>'category'),
      subcategory = coalesce(p0.subcategory, p->>'subcategory'),
      address = coalesce(p0.address, p->>'address'),
      description = case when p0.description is null and v_description is not null
                         then v_description else p0.description end,
      description_source = case when p0.description is null and v_description is not null
                                then v_description_source else p0.description_source end,
      description_license = case when p0.description is null and v_description is not null
                                 then v_description_license else p0.description_license end,
      website_url = coalesce(p0.website_url, p->>'website_url'),
      phone = coalesce(p0.phone, p->>'phone'),
      wikipedia_url = coalesce(p0.wikipedia_url, p->>'wikipedia_url'),
      wikidata_id = coalesce(p0.wikidata_id, v_wikidata_id),
      osm_type = coalesce(p0.osm_type, v_osm_type),
      osm_id = coalesce(p0.osm_id, v_osm_id),
      image_url = coalesce(p0.image_url, p->>'image_url'),
      image_source_url = coalesce(p0.image_source_url, p->>'image_source_url'),
      image_author = coalesce(p0.image_author, p->>'image_author'),
      image_license = coalesce(p0.image_license, p->>'image_license'),
      quality_score = greatest(p0.quality_score, coalesce(nullif(p->>'quality_score', '')::int, 0)),
      importance_score = greatest(p0.importance_score, v_importance),
      updated_at = now()
    where p0.id = v_id;
  end if;
  return v_id;
end;
$$;

create index if not exists tourism_city_places_current_rank_idx
  on public.tourism_city_places(city_id, is_current, relevance_score desc);
create index if not exists tourism_city_places_cycle_idx
  on public.tourism_city_places(city_id, last_seen_cycle_id)
  where managed_by_collector;

-- Conservative legacy backfill. Existing rows and links are never deleted.
-- Radius is inferred from the most recent run only when every recorded radius
-- agrees. Ambiguous active cycles require explicit operator confirmation.
with city_runs as (
  select r.city_id,
         count(distinct r.radius_km) filter (where r.radius_km is not null) as distinct_radii,
         bool_or(r.radius_km is not null and r.radius_km not between 10 and 150) as has_invalid_radius,
         (array_agg(r.radius_km order by r.started_at desc, r.id desc)
           filter (where r.radius_km between 10 and 150))[1] as latest_radius
  from public.tourism_ingestion_runs r
  where r.city_id is not null
  group by r.city_id
), legacy_cities as (
  select c.*,
         coalesce(cr.latest_radius, c.radius_km) as inferred_radius,
         coalesce(cr.distinct_radii, 0) as distinct_radii,
         coalesce(cr.has_invalid_radius, false) as has_invalid_radius,
         exists (
           select 1 from public.tourism_collection_items qi where qi.city_id = c.id
         ) as has_legacy_queue
  from public.tourism_cities c
  left join city_runs cr on cr.city_id = c.id
  where c.active_collection_cycle_id is null
    and (
      c.collection_status <> 'pending'
      or c.collection_discovered_at is not null
      or exists (select 1 from public.tourism_collection_items qi where qi.city_id = c.id)
    )
)
insert into public.tourism_collection_cycles (
  city_id, radius_km, radius_verified, is_legacy, status,
  started_at, finished_at, last_error
)
select lc.id,
       lc.inferred_radius,
       (lc.distinct_radii = 1 and not lc.has_invalid_radius
          and lc.collection_discovery_error is null),
       true,
       case
         -- Preserve the city-level completed status, but do not claim that an
         -- old timestamp proves a complete, uncapped source cycle.
         when lc.collection_status = 'completed' then 'legacy_review'
         -- Give legacy failures a bounded retry under the new source policy.
         when lc.collection_status = 'failed' then 'retry_wait'
         when lc.collection_status = 'partial' then 'partial'
         when lc.collection_status = 'processing' or lc.collection_discovered_at is not null
              or lc.has_legacy_queue then 'processing'
         else 'pending'
       end,
       coalesce(lc.collection_discovered_at, lc.last_collected_at, lc.created_at),
       null,
       lc.last_error
from legacy_cities lc
where not exists (
  select 1 from public.tourism_collection_cycles cy
  where cy.city_id = lc.id and cy.is_legacy
);

update public.tourism_cities c
set active_collection_cycle_id = cy.id
from public.tourism_collection_cycles cy
where cy.city_id = c.id
  and cy.is_legacy
  and c.active_collection_cycle_id is null;

insert into public.tourism_collection_cycle_sources (
  cycle_id, source_name, status, next_attempt_at, is_complete,
  completed_at, last_error
)
select cy.id,
       src.source_name,
       case when c.collection_discovery_error is not null
                  or c.collection_status = 'failed' then 'retry_wait'
            else 'pending' end,
       now(),
       false,
       null,
       c.collection_discovery_error
from public.tourism_collection_cycles cy
join public.tourism_cities c on c.id = cy.city_id
cross join (values ('openstreetmap'), ('wikidata')) as src(source_name)
where cy.is_legacy
on conflict (cycle_id, source_name) do nothing;

-- Copy old queue state into the new cycle queue; leave the original queue rows
-- untouched for audit and rollback. A processing item keeps its old lease time
-- and is not immediately reclaimed.
insert into public.tourism_collection_cycle_items (
  cycle_id, source_name, source_id, raw_payload, status, attempts, max_attempts,
  available_at, lease_expires_at, last_error, created_at, processed_at
)
select c.active_collection_cycle_id,
       q.source_name,
       q.source_id,
       q.raw_payload,
       case when q.status = 'completed' then 'pending'
            when q.attempts >= 20 then 'exhausted' else q.status end,
       case when q.status = 'completed' then 0 else q.attempts end,
       case when q.status = 'completed' then 3
            else greatest(3, least(20, q.attempts + 1)) end,
       case when q.status = 'completed' then now() else q.available_at end,
       case when q.status = 'processing'
            then coalesce(q.claimed_at + interval '10 minutes', now() - interval '10 minutes') end,
       q.last_error,
       q.created_at,
       case when q.status = 'completed' then null else q.processed_at end
from public.tourism_collection_items q
join public.tourism_cities c on c.id = q.city_id
where c.active_collection_cycle_id is not null
on conflict (cycle_id, source_name, source_id) do nothing;

-- Public clients must not see links explicitly retired by a completed cycle.
-- Existing links remain current; legacy links are not auto-retired.
drop policy if exists "public read approved city links" on public.tourism_city_places;
create policy "public read approved city links" on public.tourism_city_places
  for select to anon, authenticated
  using (
    is_current = true
    and exists (
      select 1 from public.tourism_places p
      where p.id = place_id and p.review_status = 'approved' and p.is_active = true
    )
  );

-- Cycle lease claim: row-locks the city, creates a new cycle only when needed,
-- and fences old workers with a fresh token. Explicit rediscovery supersedes
-- the old queue state without deleting it or touching place/link records.
create or replace function public.claim_tourism_collection_cycle(
  p_city_id uuid,
  p_radius_km int default null,
  p_rediscover boolean default false,
  p_confirm_legacy_radius boolean default false,
  p_lease_seconds int default 600,
  p_reconcile_links boolean default false
)
returns table (
  cycle_id uuid,
  city_id uuid,
  radius_km int,
  lease_token uuid,
  lease_expires_at timestamptz,
  cycle_status text
)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_city public.tourism_cities%rowtype;
  v_cycle public.tourism_collection_cycles%rowtype;
  v_new_id uuid;
  v_token uuid := gen_random_uuid();
  v_radius int;
  v_due boolean;
begin
  if p_lease_seconds is null or p_lease_seconds not between 60 and 1800 then
    raise exception 'lease must be between 60 and 1800 seconds';
  end if;
  if p_rediscover is null or p_confirm_legacy_radius is null or p_reconcile_links is null then
    raise exception 'rediscovery, legacy confirmation, and reconciliation flags are required';
  end if;
  if p_radius_km is not null and p_radius_km not between 10 and 150 then
    raise exception 'radius must be an integer from 10 through 150';
  end if;

  select c.* into v_city
  from public.tourism_cities c
  where c.id = p_city_id and c.is_enabled = true
  for update skip locked;
  if not found then return; end if;

  if v_city.active_collection_cycle_id is not null then
    select cy.* into v_cycle
    from public.tourism_collection_cycles cy
    where cy.id = v_city.active_collection_cycle_id and cy.city_id = v_city.id
    for update;
  end if;

  if v_cycle.id is not null and p_rediscover then
    update public.tourism_collection_cycles cy
    set status = 'superseded', lease_token = null, lease_expires_at = null,
        finished_at = coalesce(cy.finished_at, now())
    where cy.id = v_cycle.id;
    update public.tourism_collection_cycle_sources s
    set status = 'superseded', lease_token = null, lease_expires_at = null,
        updated_at = now()
    where s.cycle_id = v_cycle.id and s.status <> 'completed';
    update public.tourism_collection_cycle_items i
    set status = 'superseded', lease_token = null, lease_expires_at = null
    where i.cycle_id = v_cycle.id and i.status in ('pending', 'processing', 'failed');
    v_cycle.id := null;
  end if;

  if v_cycle.id is not null then
    if p_radius_km is not null and p_radius_km <> v_cycle.radius_km then
      raise exception 'radius differs from the active cycle; use explicit rediscovery';
    end if;
    if not v_cycle.radius_verified and not p_confirm_legacy_radius then
      raise exception 'legacy cycle radius is ambiguous; confirm it or start rediscovery';
    end if;
    if v_cycle.status in ('completed', 'failed', 'exhausted', 'legacy_review', 'superseded') then
      return;
    end if;
    if v_cycle.lease_expires_at > now() then return; end if;

    select v_cycle.status = 'ready_to_finalize' or exists (
      select 1 from public.tourism_collection_cycle_sources s
      where s.cycle_id = v_cycle.id
        and ((s.status in ('pending', 'retry_wait', 'truncated')
              and s.attempts < s.max_attempts and s.next_attempt_at <= now())
             or (s.status = 'processing' and s.lease_expires_at <= now()))
      union all
      select 1 from public.tourism_collection_cycle_items i
      where i.cycle_id = v_cycle.id
        and ((i.status in ('pending', 'failed')
              and i.attempts < i.max_attempts and i.available_at <= now())
             or (i.status = 'processing' and i.lease_expires_at <= now()))
    ) into v_due;
    if not v_due then return; end if;
  else
    if v_city.collection_status = 'completed' and not p_rediscover then return; end if;
    v_radius := coalesce(p_radius_km, v_city.radius_km);
    if v_radius not between 10 and 150 then
      raise exception 'configured city radius must be an integer from 10 through 150';
    end if;
    insert into public.tourism_collection_cycles(city_id, radius_km, status, reconcile_links)
    values (v_city.id, v_radius, 'pending', p_reconcile_links)
    returning id into v_new_id;
    insert into public.tourism_collection_cycle_sources(cycle_id, source_name)
    values (v_new_id, 'openstreetmap'), (v_new_id, 'wikidata');
    update public.tourism_cities c
    set active_collection_cycle_id = v_new_id, collection_status = 'processing'
    where c.id = v_city.id;
    select cy.* into v_cycle from public.tourism_collection_cycles cy where cy.id = v_new_id;
  end if;

  update public.tourism_collection_cycles cy
  set lease_token = v_token,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      last_claimed_at = now(),
      radius_verified = true,
      status = case when cy.status = 'ready_to_finalize'
                    then 'ready_to_finalize' else 'processing' end,
      reconcile_links = cy.reconcile_links or p_reconcile_links
  where cy.id = v_cycle.id
  returning * into v_cycle;

  update public.tourism_cities c
  set collection_status = 'processing'
  where c.id = v_cycle.city_id and c.active_collection_cycle_id = v_cycle.id;

  return query select v_cycle.id, v_cycle.city_id, v_cycle.radius_km,
                      v_cycle.lease_token, v_cycle.lease_expires_at, v_cycle.status;
end;
$$;

-- City lease is checked and locked before claiming source work. The cursor lets
-- the Worker resume a paged discovery instead of treating a 100-row page as all
-- results. Source attempts are bounded and retry times persist across requests.
create or replace function public.claim_tourism_cycle_source(
  p_cycle_id uuid,
  p_city_lease_token uuid,
  p_source_name text,
  p_lease_seconds int default 600
)
returns setof public.tourism_collection_cycle_sources
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_city_id uuid;
  v_source public.tourism_collection_cycle_sources%rowtype;
begin
  if p_lease_seconds is null or p_lease_seconds not between 60 and 1800 then
    raise exception 'source lease must be between 60 and 1800 seconds';
  end if;
  select id into v_city_id from public.tourism_cities
  where active_collection_cycle_id = p_cycle_id for update;
  if not found then return; end if;
  perform 1 from public.tourism_collection_cycles cy
  where cy.id = p_cycle_id and cy.city_id = v_city_id
    and cy.lease_token = p_city_lease_token and cy.lease_expires_at > now()
  for update;
  if not found then return; end if;

  update public.tourism_collection_cycle_sources s
  set status = 'exhausted', attempts = s.attempts + 1,
      lease_token = null, lease_expires_at = null,
      last_error = coalesce(s.last_error, 'Source lease expired at retry limit'),
      updated_at = now()
  where s.cycle_id = p_cycle_id and s.source_name = p_source_name
    and s.status = 'processing' and s.lease_expires_at <= now()
    and s.attempts + 1 >= s.max_attempts;

  select * into v_source
  from public.tourism_collection_cycle_sources s
  where s.cycle_id = p_cycle_id and s.source_name = p_source_name
    and s.attempts < s.max_attempts
    and (
      (s.status in ('pending', 'retry_wait', 'truncated') and s.next_attempt_at <= now())
      or (s.status = 'processing' and s.lease_expires_at <= now()
          and s.attempts + 1 < s.max_attempts)
    )
  for update skip locked;
  if not found then
    perform public.mark_tourism_cycle_ready_to_finalize(p_cycle_id);
    return;
  end if;

  return query update public.tourism_collection_cycle_sources s
  set status = 'processing',
      attempts = s.attempts + case when s.status = 'processing' then 1 else 0 end,
      lease_token = gen_random_uuid(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      last_attempt_at = now(), updated_at = now()
  where s.cycle_id = p_cycle_id and s.source_name = p_source_name
  returning s.*;
end;
$$;

create or replace function public.persist_tourism_cycle_source_page(
  p_cycle_id uuid,
  p_city_lease_token uuid,
  p_source_name text,
  p_source_lease_token uuid,
  p_page_key text,
  p_expected_cursor jsonb,
  p_next_cursor jsonb,
  p_items jsonb,
  p_is_complete boolean
)
returns table (page_applied boolean, cursor_after jsonb, source_complete boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_city_id uuid;
  v_source public.tourism_collection_cycle_sources%rowtype;
  v_page public.tourism_collection_cycle_source_pages%rowtype;
  v_inserted int;
begin
  select id into v_city_id from public.tourism_cities
  where active_collection_cycle_id = p_cycle_id for update;
  if not found then raise exception 'stale collection cycle'; end if;
  perform 1 from public.tourism_collection_cycles cy
  where cy.id = p_cycle_id and cy.city_id = v_city_id
    and cy.lease_token = p_city_lease_token and cy.lease_expires_at > now()
  for update;
  if not found then raise exception 'stale collection cycle lease'; end if;

  if p_page_key is null or length(p_page_key) = 0 or length(p_page_key) > 256 then
    raise exception 'page key must contain 1 through 256 characters';
  end if;
  if p_is_complete is null then raise exception 'completion flag is required'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'page items must be a JSON array';
  end if;
  if jsonb_array_length(p_items) > 2000 then
    raise exception 'page items must be an array of at most 2000 records; continue pagination';
  end if;
  if not p_is_complete and (p_next_cursor is null or p_next_cursor is not distinct from p_expected_cursor) then
    raise exception 'incomplete page must advance to a non-null cursor';
  end if;
  select * into v_source
  from public.tourism_collection_cycle_sources s
  where s.cycle_id = p_cycle_id and s.source_name = p_source_name
  for update;
  if not found then raise exception 'unknown collection source'; end if;

  select * into v_page from public.tourism_collection_cycle_source_pages p
  where p.cycle_id = p_cycle_id and p.source_name = p_source_name
    and p.page_key = p_page_key;
  if found then
    if v_page.expected_cursor is distinct from p_expected_cursor
       or v_page.next_cursor is distinct from p_next_cursor
       or v_page.is_complete is distinct from p_is_complete
       or v_page.items_payload is distinct from p_items then
      raise exception 'page key was reused with different page contents';
    end if;
    return query select false, v_source.cursor, v_source.is_complete;
    return;
  end if;
  if v_source.status <> 'processing' or v_source.lease_token is distinct from p_source_lease_token
     or v_source.lease_expires_at <= now() then
    raise exception 'stale or expired source lease';
  end if;
  if v_source.cursor is distinct from p_expected_cursor then
    raise exception 'source cursor changed; reload current source state';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_items) as x(source_id text, raw_payload jsonb)
    where nullif(x.source_id, '') is null or x.raw_payload is null
  ) then
    raise exception 'every page item requires a source_id and raw_payload';
  end if;

  insert into public.tourism_collection_cycle_items (
    cycle_id, source_name, source_id, raw_payload, priority_score, priority_reasons
  )
  select p_cycle_id, p_source_name, x.source_id, x.raw_payload,
         coalesce(x.priority_score, 0), coalesce(x.priority_reasons, '{}')
  from jsonb_to_recordset(p_items) as x(
    source_id text, raw_payload jsonb, priority_score smallint, priority_reasons text[]
  )
  where nullif(x.source_id, '') is not null and x.raw_payload is not null
  on conflict (cycle_id, source_name, source_id) do nothing;
  get diagnostics v_inserted = row_count;

  insert into public.tourism_collection_cycle_source_pages (
    cycle_id, source_name, page_key, expected_cursor, next_cursor,
    items_discovered, is_complete, items_payload
  ) values (
    p_cycle_id, p_source_name, p_page_key, p_expected_cursor, p_next_cursor,
    v_inserted, p_is_complete, p_items
  );

  update public.tourism_collection_cycle_sources s
  set status = case when p_is_complete then 'completed' else 'processing' end,
      cursor = case when p_is_complete then null else p_next_cursor end,
      pages_completed = s.pages_completed + 1,
      items_discovered = s.items_discovered + v_inserted,
      is_complete = p_is_complete,
      lease_token = case when p_is_complete then null else s.lease_token end,
      lease_expires_at = case when p_is_complete then null else s.lease_expires_at end,
      completed_at = case when p_is_complete then now() else null end,
      last_error = null,
      updated_at = now()
  where s.cycle_id = p_cycle_id and s.source_name = p_source_name;
  perform public.mark_tourism_cycle_ready_to_finalize(p_cycle_id);
  return query select true, case when p_is_complete then null else p_next_cursor end,
                      p_is_complete;
end;
$$;

create or replace function public.fail_tourism_cycle_source(
  p_cycle_id uuid, p_city_lease_token uuid, p_source_name text,
  p_source_lease_token uuid, p_error text
)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_city_id uuid;
  v_source public.tourism_collection_cycle_sources%rowtype;
  v_status text;
begin
  select id into v_city_id from public.tourism_cities
  where active_collection_cycle_id = p_cycle_id for update;
  if not found then raise exception 'stale collection cycle'; end if;
  perform 1 from public.tourism_collection_cycles cy
  where cy.id = p_cycle_id and cy.city_id = v_city_id
    and cy.lease_token = p_city_lease_token and cy.lease_expires_at > now()
  for update;
  if not found then raise exception 'stale collection cycle lease'; end if;
  select * into v_source from public.tourism_collection_cycle_sources s
  where s.cycle_id = p_cycle_id and s.source_name = p_source_name
    and s.status = 'processing' and s.lease_token = p_source_lease_token
    and s.lease_expires_at > now()
  for update;
  if not found then raise exception 'stale or expired source lease'; end if;

  v_status := case when v_source.attempts + 1 >= v_source.max_attempts
                   then 'exhausted' else 'retry_wait' end;
  update public.tourism_collection_cycle_sources s
  set attempts = s.attempts + 1, status = v_status,
      next_attempt_at = now() + make_interval(secs => least(
        3600, 30 * power(2, s.attempts)::int
      )),
      lease_token = null, lease_expires_at = null,
      last_error = left(p_error, 1000), updated_at = now()
  where s.cycle_id = p_cycle_id and s.source_name = p_source_name
  returning s.status into v_status;
  perform public.mark_tourism_cycle_ready_to_finalize(p_cycle_id);
  return v_status;
end;
$$;

-- Claim only due work and rotate through cities by last claim time. A city with
-- a future retry or exhausted source/item is skipped, so it cannot starve peers.
create or replace function public.claim_next_tourism_collection_cycle(
  p_lease_seconds int default 600
)
returns table (
  cycle_id uuid,
  city_id uuid,
  radius_km int,
  lease_token uuid,
  lease_expires_at timestamptz,
  cycle_status text
)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_city_id uuid;
begin
  if p_lease_seconds is null or p_lease_seconds not between 60 and 1800 then
    raise exception 'lease must be between 60 and 1800 seconds';
  end if;
  select c.id into v_city_id
  from public.tourism_cities c
  left join public.tourism_collection_cycles cy
    on cy.id = c.active_collection_cycle_id and cy.city_id = c.id
  where c.is_enabled
    and c.collection_status <> 'completed'
    and (cy.id is null or (
      cy.radius_verified = true
      and cy.status in ('pending', 'processing', 'retry_wait', 'ready_to_finalize', 'partial')
      and (cy.lease_expires_at is null or cy.lease_expires_at <= now())
      and (cy.status = 'ready_to_finalize' or (
        exists (
          select 1 from public.tourism_collection_cycle_sources s
          where s.cycle_id = cy.id
            and ((s.status in ('pending', 'retry_wait', 'truncated')
                  and s.attempts < s.max_attempts and s.next_attempt_at <= now())
                 or (s.status = 'processing' and s.lease_expires_at <= now()))
        )
        or exists (
          select 1 from public.tourism_collection_cycle_items i
          where i.cycle_id = cy.id
            and ((i.status in ('pending', 'failed')
                  and i.attempts < i.max_attempts and i.available_at <= now())
              or (i.status = 'processing' and i.lease_expires_at <= now()))
        )
      ))
    ))
  order by cy.last_claimed_at asc nulls first, c.created_at asc,
           c.population desc nulls last, c.id
  for update of c skip locked
  limit 1;
  if v_city_id is null then return; end if;
  return query select * from public.claim_tourism_collection_cycle(
    v_city_id, null, false, false, p_lease_seconds, false
  );
end;
$$;

create or replace function public.claim_tourism_cycle_items(
  p_cycle_id uuid,
  p_city_lease_token uuid,
  p_limit int default 5,
  p_lease_seconds int default 600
)
returns setof public.tourism_collection_cycle_items
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_city_id uuid;
begin
  if p_limit is null or p_limit < 1 or p_limit > 20 then raise exception 'item limit must be 1 through 20'; end if;
  if p_lease_seconds is null or p_lease_seconds not between 60 and 1800 then raise exception 'invalid item lease duration'; end if;
  select id into v_city_id from public.tourism_cities
  where active_collection_cycle_id = p_cycle_id for update;
  if not found then raise exception 'stale collection cycle'; end if;
  perform 1 from public.tourism_collection_cycles cy
  where cy.id = p_cycle_id and cy.city_id = v_city_id
    and cy.lease_token = p_city_lease_token and cy.lease_expires_at > now()
  for update;
  if not found then raise exception 'stale collection cycle lease'; end if;

  update public.tourism_collection_cycle_items i
  set status = 'exhausted', lease_token = null, lease_expires_at = null,
      last_error = coalesce(i.last_error, 'Item lease expired at retry limit')
  where i.cycle_id = p_cycle_id and i.status = 'processing'
    and i.lease_expires_at <= now() and i.attempts >= i.max_attempts;

  return query
  with candidates as (
    select i.id
    from public.tourism_collection_cycle_items i
    where i.cycle_id = p_cycle_id and i.attempts < i.max_attempts
      and ((i.status in ('pending', 'failed') and i.available_at <= now())
        or (i.status = 'processing' and i.lease_expires_at <= now()))
    order by i.priority_score desc, i.available_at, i.created_at, i.id
    limit p_limit
    for update skip locked
  )
  update public.tourism_collection_cycle_items i
  set status = 'processing', attempts = i.attempts + 1,
      lease_token = gen_random_uuid(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      last_error = null
  from candidates x where i.id = x.id
  returning i.*;
  perform public.mark_tourism_cycle_ready_to_finalize(p_cycle_id);
end;
$$;

-- Extend active leases safely using the global lock order: city, cycle, source,
-- then item. Expired leases cannot be resurrected by a stale Worker.
create or replace function public.renew_tourism_collection_lease(
  p_cycle_id uuid,
  p_city_lease_token uuid,
  p_lease_seconds int default 600,
  p_source_name text default null,
  p_source_lease_token uuid default null,
  p_item_id uuid default null,
  p_item_lease_token uuid default null
)
returns timestamptz
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_city_id uuid;
  v_expires timestamptz;
begin
  if p_lease_seconds is null or p_lease_seconds not between 60 and 1800 then
    raise exception 'lease must be between 60 and 1800 seconds';
  end if;
  if (p_source_name is null) <> (p_source_lease_token is null)
     or (p_item_id is null) <> (p_item_lease_token is null) then
    raise exception 'lease resource identifiers and tokens must be supplied together';
  end if;

  select id into v_city_id from public.tourism_cities
  where active_collection_cycle_id = p_cycle_id for update;
  if not found then raise exception 'stale collection cycle'; end if;
  perform 1 from public.tourism_collection_cycles cy
  where cy.id = p_cycle_id and cy.city_id = v_city_id
    and cy.lease_token = p_city_lease_token and cy.lease_expires_at > now()
  for update;
  if not found then raise exception 'stale or expired collection cycle lease'; end if;

  update public.tourism_collection_cycles
  set lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  where id = p_cycle_id returning lease_expires_at into v_expires;

  if p_source_name is not null then
    perform 1 from public.tourism_collection_cycle_sources s
    where s.cycle_id = p_cycle_id and s.source_name = p_source_name
      and s.status = 'processing' and s.lease_token = p_source_lease_token
      and s.lease_expires_at > now()
    for update;
    if not found then raise exception 'stale or expired source lease'; end if;
    update public.tourism_collection_cycle_sources
    set lease_expires_at = v_expires, updated_at = now()
    where cycle_id = p_cycle_id and source_name = p_source_name;
  end if;

  if p_item_id is not null then
    perform 1 from public.tourism_collection_cycle_items i
    where i.id = p_item_id and i.cycle_id = p_cycle_id
      and i.status = 'processing' and i.lease_token = p_item_lease_token
      and i.lease_expires_at > now()
    for update;
    if not found then raise exception 'stale or expired item lease'; end if;
    update public.tourism_collection_cycle_items
    set lease_expires_at = v_expires
    where id = p_item_id and cycle_id = p_cycle_id;
  end if;
  return v_expires;
end;
$$;

create or replace function public.release_tourism_cycle_source(
  p_cycle_id uuid,
  p_city_lease_token uuid,
  p_source_name text,
  p_source_lease_token uuid
)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_city_id uuid;
  v_status text;
begin
  select id into v_city_id from public.tourism_cities
  where active_collection_cycle_id = p_cycle_id for update;
  if not found then raise exception 'stale collection cycle'; end if;
  perform 1 from public.tourism_collection_cycles cy
  where cy.id = p_cycle_id and cy.city_id = v_city_id
    and cy.lease_token = p_city_lease_token and cy.lease_expires_at > now()
  for update;
  if not found then raise exception 'stale or expired collection cycle lease'; end if;
  update public.tourism_collection_cycle_sources s
  set status = case when s.cursor is null then 'pending' else 'truncated' end,
      lease_token = null, lease_expires_at = null, next_attempt_at = now(), updated_at = now()
  where s.cycle_id = p_cycle_id and s.source_name = p_source_name
    and s.status = 'processing' and s.lease_token = p_source_lease_token
    and s.lease_expires_at > now()
  returning s.status into v_status;
  if not found then raise exception 'stale or expired source lease'; end if;
  return v_status;
end;
$$;

create or replace function public.release_tourism_collection_city_lease(
  p_cycle_id uuid,
  p_city_lease_token uuid
)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_city_id uuid;
begin
  select id into v_city_id from public.tourism_cities
  where active_collection_cycle_id = p_cycle_id for update;
  if not found then raise exception 'stale collection cycle'; end if;
  perform 1 from public.tourism_collection_cycles cy
  where cy.id = p_cycle_id and cy.city_id = v_city_id
    and cy.lease_token = p_city_lease_token and cy.lease_expires_at > now()
  for update;
  if not found then raise exception 'stale or expired collection cycle lease'; end if;

  update public.tourism_collection_cycle_sources s
  set status = case when s.cursor is null then 'pending' else 'truncated' end,
      lease_token = null, lease_expires_at = null, next_attempt_at = now(), updated_at = now()
  where s.cycle_id = p_cycle_id and s.status = 'processing';
  update public.tourism_collection_cycle_items i
  set status = 'pending', attempts = greatest(i.attempts - 1, 0),
      available_at = now(), lease_token = null, lease_expires_at = null
  where i.cycle_id = p_cycle_id and i.status = 'processing';
  update public.tourism_collection_cycles cy
  set lease_token = null, lease_expires_at = null
  where cy.id = p_cycle_id and cy.lease_token = p_city_lease_token;
  return true;
end;
$$;

-- This single transaction verifies both leases, upserts the canonical place and
-- source metadata, records the cycle link, and completes the item. A stale
-- Worker cannot write a place/link after a newer cycle has superseded it.
create or replace function public.upsert_tourism_place_for_cycle(
  p_cycle_id uuid,
  p_city_lease_token uuid,
  p_item_id uuid,
  p_item_lease_token uuid,
  p_place jsonb,
  p_source jsonb,
  p_wikipedia_source jsonb default null
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_city_id uuid;
  v_cycle public.tourism_collection_cycles%rowtype;
  v_city public.tourism_cities%rowtype;
  v_item public.tourism_collection_cycle_items%rowtype;
  v_place_id uuid;
  v_lat double precision := (p_place->>'latitude')::double precision;
  v_lon double precision := (p_place->>'longitude')::double precision;
  v_distance double precision;
begin
  select c.id into v_city_id from public.tourism_cities c
  where c.active_collection_cycle_id = p_cycle_id for update;
  if not found then raise exception 'stale collection cycle'; end if;
  select cy.* into v_cycle from public.tourism_collection_cycles cy
  where cy.id = p_cycle_id and cy.city_id = v_city_id
    and cy.lease_token = p_city_lease_token and cy.lease_expires_at > now()
  for update;
  if not found then raise exception 'stale collection cycle lease'; end if;

  select c.* into v_city from public.tourism_cities c where c.id = v_city_id;

  select i.* into v_item
  from public.tourism_collection_cycle_items i
  where i.id = p_item_id and i.cycle_id = p_cycle_id
    and i.status = 'processing' and i.lease_token = p_item_lease_token
    and i.lease_expires_at > now()
  for update;
  if not found then raise exception 'stale collection item lease'; end if;

  if p_source->>'source_name' is distinct from v_item.source_name
     or p_source->>'source_id' is distinct from v_item.source_id then
    raise exception 'source metadata does not match the claimed queue item';
  end if;
  if v_item.source_name = 'openstreetmap'
     and concat(p_place->>'osm_type', '/', p_place->>'osm_id') is distinct from v_item.source_id then
    raise exception 'OSM place identity does not match the claimed queue item';
  end if;
  if v_item.source_name = 'wikidata'
     and p_place->>'wikidata_id' is distinct from v_item.source_id then
    raise exception 'Wikidata identity does not match the claimed queue item';
  end if;
  if v_lat is null or v_lon is null then raise exception 'place coordinates required'; end if;
  v_distance := public.tourism_distance_km(v_city.latitude, v_city.longitude, v_lat, v_lon);
  if v_distance > v_cycle.radius_km then
    raise exception 'place is outside the persisted collection cycle radius';
  end if;

  v_place_id := public.upsert_tourism_place(p_place);

  insert into public.tourism_place_sources(
    place_id, source_name, source_id, source_url, attribution, license, payload
  ) values (
    v_place_id, p_source->>'source_name', p_source->>'source_id',
    p_source->>'source_url', p_source->>'attribution', p_source->>'license',
    coalesce(p_source->'payload', '{}'::jsonb)
  ) on conflict (source_name, source_id) do update set
    source_url = excluded.source_url,
    attribution = excluded.attribution, license = excluded.license,
    payload = excluded.payload, fetched_at = now()
    where public.tourism_place_sources.place_id = excluded.place_id;
  if not found then raise exception 'source identity is already assigned to another place'; end if;

  if p_wikipedia_source is not null then
    insert into public.tourism_place_sources(
      place_id, source_name, source_id, source_url, attribution, license, payload
    ) values (
      v_place_id, 'wikipedia', p_wikipedia_source->>'source_id',
      p_wikipedia_source->>'source_url', p_wikipedia_source->>'attribution',
      p_wikipedia_source->>'license',
      coalesce(p_wikipedia_source->'payload', '{}'::jsonb)
    ) on conflict (source_name, source_id) do update set
      source_url = excluded.source_url,
      attribution = excluded.attribution, license = excluded.license,
      payload = excluded.payload, fetched_at = now()
      where public.tourism_place_sources.place_id = excluded.place_id;
    if not found then raise exception 'Wikipedia identity is already assigned to another place'; end if;
  end if;

  insert into public.tourism_city_places(
    city_id, place_id, distance_km, relevance_score, is_current,
    managed_by_collector, last_seen_cycle_id
  ) values (
    v_city.id, v_place_id, v_distance,
    coalesce((p_place->>'importance_score')::int, 0), true, true, p_cycle_id
  ) on conflict (city_id, place_id) do update set
    distance_km = excluded.distance_km,
    relevance_score = excluded.relevance_score,
    is_current = true,
    last_seen_cycle_id = excluded.last_seen_cycle_id
  where public.tourism_city_places.managed_by_collector = true;

  update public.tourism_collection_cycle_items
  set status = 'completed', processed_at = now(), lease_token = null,
      lease_expires_at = null, last_error = null
  where id = p_item_id and cycle_id = p_cycle_id
    and lease_token = p_item_lease_token;
  if not found then raise exception 'collection item lease changed during write'; end if;
  perform public.mark_tourism_cycle_ready_to_finalize(p_cycle_id);
  return v_place_id;
end;
$$;

create or replace function public.fail_tourism_cycle_item(
  p_cycle_id uuid,
  p_city_lease_token uuid,
  p_item_id uuid,
  p_item_lease_token uuid,
  p_error text
)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_city_id uuid;
  v_status text;
begin
  select id into v_city_id from public.tourism_cities
  where active_collection_cycle_id = p_cycle_id for update;
  if not found then raise exception 'stale collection cycle'; end if;
  perform 1 from public.tourism_collection_cycles cy
  where cy.id = p_cycle_id and cy.city_id = v_city_id
    and cy.lease_token = p_city_lease_token and cy.lease_expires_at > now()
  for update;
  if not found then raise exception 'stale collection cycle lease'; end if;

  update public.tourism_collection_cycle_items i
  set status = case when i.attempts >= i.max_attempts then 'exhausted' else 'failed' end,
      available_at = now() + make_interval(secs => least(
        3600, 300 * power(2, greatest(0, i.attempts - 1))::int
      )),
      lease_token = null, lease_expires_at = null,
      last_error = left(p_error, 1000)
  where i.id = p_item_id and i.cycle_id = p_cycle_id
    and i.status = 'processing' and i.lease_token = p_item_lease_token
    and i.lease_expires_at > now()
    and i.attempts <= i.max_attempts
  returning i.status into v_status;
  if not found then raise exception 'stale collection item lease'; end if;
  perform public.mark_tourism_cycle_ready_to_finalize(p_cycle_id);
  return v_status;
end;
$$;

-- Only fully discovered, uncapped and successfully processed cycles reconcile
-- links. Retired links remain in the table; canonical places/source rows remain.
create or replace function public.finish_tourism_collection_cycle(
  p_cycle_id uuid,
  p_city_lease_token uuid
)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_city_id uuid;
  v_cycle public.tourism_collection_cycles%rowtype;
  v_retired int;
begin
  select id into v_city_id from public.tourism_cities
  where active_collection_cycle_id = p_cycle_id for update;
  if not found then raise exception 'stale collection cycle'; end if;
  select cy.* into v_cycle from public.tourism_collection_cycles cy
  where cy.id = p_cycle_id and cy.city_id = v_city_id
    and cy.lease_token = p_city_lease_token and cy.lease_expires_at > now()
  for update;
  if not found then raise exception 'stale collection cycle lease'; end if;

  if not exists (
    select 1 from public.tourism_collection_cycle_sources s
    where s.cycle_id = p_cycle_id
    group by s.cycle_id having count(*) = 2
  ) or exists (
    select 1 from public.tourism_collection_cycle_sources s
    where s.cycle_id = p_cycle_id
      and s.status not in ('completed', 'exhausted', 'superseded')
  ) or exists (
    select 1 from public.tourism_collection_cycle_items i
    where i.cycle_id = p_cycle_id
      and i.status not in ('completed', 'exhausted', 'superseded')
  ) then
    raise exception 'cycle still has pending or leased work';
  end if;

  if exists (
    select 1 from public.tourism_collection_cycle_sources s
    where s.cycle_id = p_cycle_id and s.status <> 'completed'
  ) or exists (
    select 1 from public.tourism_collection_cycle_items i
    where i.cycle_id = p_cycle_id and i.status <> 'completed'
  ) then
    -- Bounded failures become terminal without retiring any city-place links.
    update public.tourism_collection_cycles
    set status = case
          when exists (select 1 from public.tourism_collection_cycle_sources s
                       where s.cycle_id = p_cycle_id and s.status = 'completed')
            or exists (select 1 from public.tourism_collection_cycle_items i
                       where i.cycle_id = p_cycle_id and i.status = 'completed')
          then 'partial' else 'failed' end,
        finished_at = now(), lease_token = null, lease_expires_at = null,
        last_error = coalesce(last_error, 'One or more source/item retries were exhausted')
    where id = p_cycle_id and lease_token = p_city_lease_token;
    update public.tourism_cities c
    set collection_status = cy.status, last_collected_at = now(),
        last_error = coalesce(cy.last_error, 'One or more source/item retries were exhausted')
    from public.tourism_collection_cycles cy
    where cy.id = p_cycle_id and c.id = cy.city_id
      and c.active_collection_cycle_id = p_cycle_id;
    return 0;
  end if;

  v_retired := 0;
  if v_cycle.reconcile_links then
    update public.tourism_city_places cp
    set is_current = false
    where cp.city_id = v_cycle.city_id
      and cp.managed_by_collector
      and cp.last_seen_cycle_id is distinct from p_cycle_id
      and cp.is_current;
    get diagnostics v_retired = row_count;
  end if;

  update public.tourism_collection_cycles
  set status = 'completed', finished_at = now(), lease_token = null,
      lease_expires_at = null, last_error = null
  where id = p_cycle_id and lease_token = p_city_lease_token;
  update public.tourism_cities
  set collection_status = 'completed', collection_discovered_at = now(),
      collection_discovery_error = null, last_collected_at = now(), last_error = null
  where id = v_cycle.city_id and active_collection_cycle_id = p_cycle_id;
  return v_retired;
end;
$$;

-- Private tables: only the Worker service role may access cycle state.
alter table public.tourism_collection_cycles enable row level security;
alter table public.tourism_collection_cycle_sources enable row level security;
alter table public.tourism_collection_cycle_source_pages enable row level security;
alter table public.tourism_collection_cycle_items enable row level security;
revoke all on public.tourism_collection_cycles from public, anon, authenticated;
revoke all on public.tourism_collection_cycle_sources from public, anon, authenticated;
revoke all on public.tourism_collection_cycle_source_pages from public, anon, authenticated;
revoke all on public.tourism_collection_cycle_items from public, anon, authenticated;
grant all on public.tourism_collection_cycles to service_role;
grant all on public.tourism_collection_cycle_sources to service_role;
grant all on public.tourism_collection_cycle_source_pages to service_role;
grant all on public.tourism_collection_cycle_items to service_role;

revoke all on function public.claim_tourism_collection_cycle(uuid,int,boolean,boolean,int,boolean)
  from public, anon, authenticated;
revoke all on function public.claim_tourism_cycle_source(uuid,uuid,text,int)
  from public, anon, authenticated;
revoke all on function public.persist_tourism_cycle_source_page(uuid,uuid,text,uuid,text,jsonb,jsonb,jsonb,boolean)
  from public, anon, authenticated;
revoke all on function public.fail_tourism_cycle_source(uuid,uuid,text,uuid,text)
  from public, anon, authenticated;
revoke all on function public.claim_next_tourism_collection_cycle(int)
  from public, anon, authenticated;
revoke all on function public.claim_tourism_cycle_items(uuid,uuid,int,int)
  from public, anon, authenticated;
revoke all on function public.renew_tourism_collection_lease(uuid,uuid,int,text,uuid,uuid,uuid)
  from public, anon, authenticated;
revoke all on function public.release_tourism_cycle_source(uuid,uuid,text,uuid)
  from public, anon, authenticated;
revoke all on function public.release_tourism_collection_city_lease(uuid,uuid)
  from public, anon, authenticated;
revoke all on function public.upsert_tourism_place_for_cycle(uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb)
  from public, anon, authenticated;
revoke all on function public.fail_tourism_cycle_item(uuid,uuid,uuid,uuid,text)
  from public, anon, authenticated;
revoke all on function public.finish_tourism_collection_cycle(uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.claim_tourism_collection_cycle(uuid,int,boolean,boolean,int,boolean) to service_role;
grant execute on function public.claim_tourism_cycle_source(uuid,uuid,text,int) to service_role;
grant execute on function public.persist_tourism_cycle_source_page(uuid,uuid,text,uuid,text,jsonb,jsonb,jsonb,boolean) to service_role;
grant execute on function public.fail_tourism_cycle_source(uuid,uuid,text,uuid,text) to service_role;
grant execute on function public.claim_next_tourism_collection_cycle(int) to service_role;
grant execute on function public.claim_tourism_cycle_items(uuid,uuid,int,int) to service_role;
grant execute on function public.renew_tourism_collection_lease(uuid,uuid,int,text,uuid,uuid,uuid) to service_role;
grant execute on function public.release_tourism_cycle_source(uuid,uuid,text,uuid) to service_role;
grant execute on function public.release_tourism_collection_city_lease(uuid,uuid) to service_role;
grant execute on function public.upsert_tourism_place_for_cycle(uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb) to service_role;
grant execute on function public.fail_tourism_cycle_item(uuid,uuid,uuid,uuid,text) to service_role;
grant execute on function public.finish_tourism_collection_cycle(uuid,uuid) to service_role;

commit;
