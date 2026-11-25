-- Synthetic, explicitly labeled Localise HTTP integration fixture.
-- Safety guard: run only in the Session A disposable PostgreSQL cluster on port 55432.
do $$
begin
  if current_setting('port') <> '55432' then
    raise exception 'Local E2E fixture is restricted to disposable PostgreSQL port 55432';
  end if;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname='authenticator') then
    create role authenticator login noinherit;
  end if;
end;
$$;
grant anon, authenticated, service_role to authenticator;

create table if not exists public.tourism_cities (
  id uuid primary key,
  name text not null,
  state_name text,
  latitude double precision not null,
  longitude double precision not null,
  radius_km integer not null default 40,
  is_enabled boolean not null default true
);
create table if not exists public.tourism_places (
  id uuid primary key,
  canonical_name text not null,
  category text,
  subcategory text,
  latitude double precision not null,
  longitude double precision not null,
  address text,
  description text,
  description_source text,
  description_license text,
  website_url text,
  phone text,
  wikipedia_url text,
  image_url text,
  image_author text,
  image_license text,
  importance_score integer not null default 0,
  quality_score integer not null default 0,
  review_status text not null check (review_status in ('pending','approved','rejected')),
  is_active boolean not null default true
);
create table if not exists public.tourism_city_places (
  city_id uuid not null references public.tourism_cities(id),
  place_id uuid not null references public.tourism_places(id),
  distance_km double precision,
  relevance_score integer not null default 0,
  is_current boolean not null default true,
  primary key (city_id, place_id)
);
create table if not exists public.tourism_place_sources (
  id bigint generated always as identity primary key,
  place_id uuid not null references public.tourism_places(id),
  source_name text not null,
  source_id text not null,
  source_url text,
  attribution text,
  license text,
  payload jsonb not null default '{}'::jsonb,
  unique (source_name, source_id)
);

alter table public.tourism_cities enable row level security;
alter table public.tourism_places enable row level security;
alter table public.tourism_city_places enable row level security;
alter table public.tourism_place_sources enable row level security;
revoke all on public.tourism_cities,public.tourism_places,public.tourism_city_places,public.tourism_place_sources from public,anon,authenticated;
grant select on public.tourism_cities,public.tourism_places,public.tourism_city_places,public.tourism_place_sources to service_role;
grant usage on schema public to authenticator;

insert into public.tourism_cities(id,name,state_name,latitude,longitude,radius_km,is_enabled)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Hyderabad','Telangana',17.385,78.4867,40,true)
on conflict (id) do update set name=excluded.name,state_name=excluded.state_name,
  latitude=excluded.latitude,longitude=excluded.longitude,radius_km=excluded.radius_km,is_enabled=excluded.is_enabled;

insert into public.tourism_places(
  id,canonical_name,category,subcategory,latitude,longitude,address,description,
  importance_score,quality_score,review_status,is_active
)
select
  ('bbbbbbbb-bbbb-4bbb-8bbb-' || lpad(to_hex(n),12,'0'))::uuid,
  case when n=2 then 'TEST FIXTURE — Highest importance attraction'
       when n=75 then 'TEST FIXTURE — Nearby escape candidate'
       else 'TEST FIXTURE — Place ' || lpad(n::text,3,'0') end,
  case when n<=75 then 'attraction' when n<=90 then 'food'
       when n<=110 then 'accommodation' else 'transport' end,
  case when n<=75 then 'synthetic attraction' when n<=90 then 'synthetic food'
       when n<=110 then 'synthetic stay' else 'synthetic transport' end,
  17.385 + n*0.0001,78.4867 + n*0.0001,
  'TEST FIXTURE ONLY', 'Synthetic E2E fixture, not real tourism data.',
  case when n=2 then 250 else 10 end, 0, 'approved', true
from generate_series(1,120) as n
on conflict (id) do update set canonical_name=excluded.canonical_name,category=excluded.category,
  subcategory=excluded.subcategory,latitude=excluded.latitude,longitude=excluded.longitude,
  address=excluded.address,description=excluded.description,importance_score=excluded.importance_score,
  review_status=excluded.review_status,is_active=excluded.is_active;

insert into public.tourism_city_places(city_id,place_id,distance_km,relevance_score,is_current)
select 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
  ('bbbbbbbb-bbbb-4bbb-8bbb-' || lpad(to_hex(n),12,'0'))::uuid,
  n*0.01,121-n,true
from generate_series(1,120) as n
on conflict (city_id,place_id) do update set distance_km=excluded.distance_km,
  relevance_score=excluded.relevance_score,is_current=excluded.is_current;

insert into public.tourism_place_sources(place_id,source_name,source_id,source_url,attribution,license,payload)
select ('bbbbbbbb-bbbb-4bbb-8bbb-' || lpad(to_hex(n),12,'0'))::uuid,
  'local_test_fixture','session-a-e2e/' || n,
  'https://example.test/localise-e2e/' || n,
  'Synthetic Session A E2E fixture; not real tourism data','TEST-FIXTURE-ONLY',
  jsonb_build_object('localise_stage',jsonb_build_object('area_class',
    case when n=75 then 'nearby_escape_candidate' else 'core_hyderabad' end))
from generate_series(1,120) as n
on conflict (source_name,source_id) do update set payload=excluded.payload,
  source_url=excluded.source_url,attribution=excluded.attribution,license=excluded.license;

notify pgrst,'reload schema';
