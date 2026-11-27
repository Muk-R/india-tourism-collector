-- Synthetic migration fixtures for an isolated CI database only.
-- These source identities let the data-enrichment migration verify its exact
-- four-record selection and fee normalization without copying production rows.
begin;

with fixture(source_type, source_id, name, latitude, longitude) as (
  values
    ('way', 238186115::bigint, 'CI fixture Charminar', 17.3616::double precision, 78.4747::double precision),
    ('relation', 9128913::bigint, 'CI fixture Golconda Fort', 17.3833::double precision, 78.4011::double precision),
    ('way', 116031164::bigint, 'CI fixture Chowmahalla Palace', 17.3578::double precision, 78.4717::double precision),
    ('way', 238284090::bigint, 'CI fixture Salar Jung Museum', 17.3714::double precision, 78.4804::double precision)
), places as (
  insert into public.tourism_places(canonical_name, category, latitude, longitude, osm_type, osm_id, review_status, is_active)
  select name, 'attraction', latitude, longitude, source_type, source_id, 'approved', true
  from fixture
  returning id, osm_type as source_type, osm_id as source_id
)
insert into public.tourism_place_sources(place_id, source_name, source_id, source_url, attribution, license)
select places.id, 'openstreetmap', fixture.source_type || '/' || fixture.source_id,
  'https://www.openstreetmap.org/' || fixture.source_type || '/' || fixture.source_id,
  chr(169) || ' OpenStreetMap contributors', 'ODbL-1.0'
from places
join fixture using (source_type, source_id);

commit;
