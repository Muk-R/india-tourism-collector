create extension if not exists pgcrypto;

create table if not exists public.tourism_cities (
 id uuid primary key default gen_random_uuid(),
 geonames_id bigint unique,
 name text not null,
 state_name text,
 country_code text not null default 'IN',
 latitude double precision not null check(latitude between -90 and 90),
 longitude double precision not null check(longitude between -180 and 180),
 radius_km int not null default 40 check(radius_km between 10 and 50),
 population bigint,
 city_source text not null default 'curated',
 is_enabled boolean not null default true,
 collection_status text not null default 'pending' check(collection_status in ('pending','processing','completed','partial','failed')),
 collection_discovered_at timestamptz,
 collection_discovery_error text,
 last_collected_at timestamptz,
 last_error text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
alter table public.tourism_cities
 add column if not exists collection_discovered_at timestamptz;
alter table public.tourism_cities
 add column if not exists collection_discovery_error text;
create index if not exists tourism_cities_status_idx on tourism_cities(is_enabled,collection_status,population desc);

create table if not exists public.tourism_places (
 id uuid primary key default gen_random_uuid(),
 canonical_name text not null,
 normalized_name text generated always as (lower(regexp_replace(trim(canonical_name),'\s+',' ','g'))) stored,
 category text, subcategory text,
 latitude double precision not null check(latitude between -90 and 90),
 longitude double precision not null check(longitude between -180 and 180),
 address text, description text, description_source text, description_license text,
 website_url text, phone text, wikipedia_url text, wikidata_id text,
 osm_type text, osm_id bigint,
 image_url text, image_source_url text, image_author text, image_license text,
 quality_score int not null default 0,
 review_status text not null default 'pending' check(review_status in ('pending','approved','rejected')),
 is_active boolean not null default true,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index if not exists tourism_places_osm_unique on tourism_places(osm_type,osm_id) where osm_type is not null and osm_id is not null;
create unique index if not exists tourism_places_wikidata_unique on tourism_places(wikidata_id) where wikidata_id is not null;
create index if not exists tourism_places_geo_idx on tourism_places(latitude,longitude);
create index if not exists tourism_places_name_idx on tourism_places(normalized_name);

create table if not exists public.tourism_city_places (
 city_id uuid not null references tourism_cities(id) on delete cascade,
 place_id uuid not null references tourism_places(id) on delete cascade,
 distance_km double precision,
 relevance_score int not null default 0,
 created_at timestamptz not null default now(),
 primary key(city_id,place_id)
);
create index if not exists tourism_city_places_rank_idx on tourism_city_places(city_id,relevance_score desc);

create table if not exists public.tourism_place_sources (
 id bigserial primary key,
 place_id uuid not null references tourism_places(id) on delete cascade,
 source_name text not null check(source_name in ('openstreetmap','wikidata','wikipedia')),
 source_id text not null, source_url text, attribution text, license text,
 payload jsonb not null default '{}'::jsonb, fetched_at timestamptz not null default now(),
 unique(source_name,source_id)
);

create table if not exists public.tourism_ingestion_runs (
 id uuid primary key default gen_random_uuid(),
 city_id uuid references tourism_cities(id) on delete set null,
 status text not null default 'running' check(status in ('running','completed','partial','failed')),
 radius_km int, osm_count int not null default 0, wikidata_count int not null default 0,
 wikipedia_count int not null default 0, inserted_count int not null default 0,
 updated_count int not null default 0, error_message text,
 started_at timestamptz not null default now(), finished_at timestamptz
);

-- Durable source work queue. Discovery can be retried safely because each city/source item is unique.
create table if not exists public.tourism_collection_items (
 id uuid primary key default gen_random_uuid(),
 city_id uuid not null references public.tourism_cities(id) on delete cascade,
 source_name text not null check(source_name in ('openstreetmap','wikidata')),
 source_id text not null,
 raw_payload jsonb not null,
 status text not null default 'pending' check(status in ('pending','processing','completed','failed')),
 attempts int not null default 0 check(attempts >= 0),
 available_at timestamptz not null default now(),
 claimed_at timestamptz,
 last_error text,
 created_at timestamptz not null default now(),
 processed_at timestamptz,
 unique(city_id,source_name,source_id)
);
create index if not exists tourism_collection_items_work_idx
 on public.tourism_collection_items(city_id,status,available_at,created_at);
alter table public.tourism_collection_items enable row level security;
revoke all on public.tourism_collection_items from public,anon,authenticated;
grant all on public.tourism_collection_items to service_role;

-- Atomically claims a bounded batch. Expired processing claims recover after a Worker interruption.
create or replace function public.claim_tourism_collection_items(p_city_id uuid,p_limit int default 5)
returns setof public.tourism_collection_items
language sql security definer set search_path=public as $$
 with exhausted_claims as (
  update public.tourism_collection_items
  set status='failed',claimed_at=null,
      last_error=coalesce(last_error,'Processing lease expired after the maximum attempts')
  where city_id=p_city_id and status='processing'
    and claimed_at<now()-interval '10 minutes' and attempts>=3
  returning id
 ), candidates as (
  select id from public.tourism_collection_items
  where city_id=p_city_id and attempts<3 and (
   (status in ('pending','failed') and available_at<=now()) or
   (status='processing' and claimed_at<now()-interval '10 minutes')
  )
  order by created_at
  limit greatest(1,least(coalesce(p_limit,5),5))
  for update skip locked
 )
 update public.tourism_collection_items item
 set status='processing',attempts=item.attempts+1,claimed_at=now(),last_error=null
 from candidates where item.id=candidates.id
 returning item.*;
$$;
revoke all on function public.claim_tourism_collection_items(uuid,int) from public,anon,authenticated;
grant execute on function public.claim_tourism_collection_items(uuid,int) to service_role;

create or replace function public.tourism_distance_km(lat1 float8,lon1 float8,lat2 float8,lon2 float8)
returns float8 language sql immutable strict as $$
 select 6371*2*asin(sqrt(power(sin(radians(lat2-lat1)/2),2)+cos(radians(lat1))*cos(radians(lat2))*power(sin(radians(lon2-lon1)/2),2)));
$$;

create or replace function public.upsert_tourism_place(p jsonb)
returns uuid language plpgsql security definer set search_path=public as $$
declare
 v_id uuid;
 v_name text := coalesce(nullif(trim(p->>'canonical_name'),''),'Unnamed place');
 v_lat float8 := (p->>'latitude')::float8;
 v_lon float8 := (p->>'longitude')::float8;
 v_ot text := p->>'osm_type';
 v_oi bigint := nullif(p->>'osm_id','')::bigint;
 v_wd text := nullif(p->>'wikidata_id','');
begin
 if v_lat is null or v_lon is null then raise exception 'Coordinates required'; end if;
 if v_ot is not null and v_oi is not null then
   select id into v_id from tourism_places where osm_type=v_ot and osm_id=v_oi limit 1;
 end if;
 if v_id is null and v_wd is not null then
   select id into v_id from tourism_places where wikidata_id=v_wd limit 1;
 end if;
 if v_id is null then
   select id into v_id from tourism_places
   where normalized_name=lower(regexp_replace(trim(v_name),'\s+',' ','g'))
     and abs(latitude-v_lat)<0.003 and abs(longitude-v_lon)<0.003
     and tourism_distance_km(latitude,longitude,v_lat,v_lon)<=0.12
   order by tourism_distance_km(latitude,longitude,v_lat,v_lon) limit 1;
 end if;
 if v_id is null then
   insert into tourism_places(canonical_name,category,subcategory,latitude,longitude,address,description,
    description_source,description_license,website_url,phone,wikipedia_url,wikidata_id,osm_type,osm_id,
    image_url,image_source_url,image_author,image_license,quality_score)
   values(v_name,p->>'category',p->>'subcategory',v_lat,v_lon,p->>'address',p->>'description',
    p->>'description_source',p->>'description_license',p->>'website_url',p->>'phone',p->>'wikipedia_url',
    v_wd,v_ot,v_oi,p->>'image_url',p->>'image_source_url',p->>'image_author',p->>'image_license',
    coalesce((p->>'quality_score')::int,0)) returning id into v_id;
 else
   update tourism_places set
    canonical_name=case when length(v_name)>length(canonical_name) then v_name else canonical_name end,
    category=coalesce(category,p->>'category'),subcategory=coalesce(subcategory,p->>'subcategory'),
    address=coalesce(address,p->>'address'),description=coalesce(description,p->>'description'),
    description_source=coalesce(description_source,p->>'description_source'),
    description_license=coalesce(description_license,p->>'description_license'),
    website_url=coalesce(website_url,p->>'website_url'),phone=coalesce(phone,p->>'phone'),
    wikipedia_url=coalesce(wikipedia_url,p->>'wikipedia_url'),wikidata_id=coalesce(wikidata_id,v_wd),
    osm_type=coalesce(osm_type,v_ot),osm_id=coalesce(osm_id,v_oi),
    image_url=coalesce(image_url,p->>'image_url'),image_source_url=coalesce(image_source_url,p->>'image_source_url'),
    image_author=coalesce(image_author,p->>'image_author'),image_license=coalesce(image_license,p->>'image_license'),
    quality_score=greatest(quality_score,coalesce((p->>'quality_score')::int,0)),updated_at=now()
   where id=v_id;
 end if;
 return v_id;
end; $$;

alter table tourism_cities enable row level security;
alter table tourism_places enable row level security;
alter table tourism_city_places enable row level security;
alter table tourism_place_sources enable row level security;
alter table tourism_ingestion_runs enable row level security;

drop policy if exists "public read enabled cities" on tourism_cities;
create policy "public read enabled cities" on tourism_cities for select to anon,authenticated using(is_enabled=true);
drop policy if exists "public read approved places" on tourism_places;
create policy "public read approved places" on tourism_places for select to anon,authenticated using(review_status='approved' and is_active=true);
drop policy if exists "public read approved city links" on tourism_city_places;
create policy "public read approved city links" on tourism_city_places for select to anon,authenticated using(
 exists(select 1 from tourism_places p where p.id=place_id and p.review_status='approved' and p.is_active=true)
);
grant execute on function public.upsert_tourism_place(jsonb) to service_role;
grant execute on function public.tourism_distance_km(float8,float8,float8,float8) to service_role;

-- Restrict RPC execution to the server-side service role.
revoke all on function public.upsert_tourism_place(jsonb) from public, anon, authenticated;
revoke all on function public.tourism_distance_km(float8,float8,float8,float8) from public, anon, authenticated;
grant execute on function public.upsert_tourism_place(jsonb) to service_role;
grant execute on function public.tourism_distance_km(float8,float8,float8,float8) to service_role;
