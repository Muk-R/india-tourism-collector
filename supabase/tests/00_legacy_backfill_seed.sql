-- ISOLATED DATABASE ONLY. Run against schema.sql before the draft migration.
-- This fixture intentionally contains an invalid historical run radius and a
-- processing queue row with no claim timestamp. It is not production SQL.
begin;

insert into public.tourism_cities (
  id, name, state_name, latitude, longitude, radius_km, is_enabled,
  collection_status, collection_discovered_at, last_collected_at
) values (
  'f7f683cc-c940-4c59-85df-568b3fe95fd1',
  'Migration Test Legacy City', 'Test State', 12.9716, 77.5946, 40, true,
  'processing', now(), now()
);

insert into public.tourism_ingestion_runs (
  id, city_id, status, radius_km, started_at, finished_at
) values (
  '7f6c8d39-881d-4a59-9517-741e30f5dfb0',
  'f7f683cc-c940-4c59-85df-568b3fe95fd1', 'completed', 200, now(), now()
);

insert into public.tourism_collection_items (
  id, city_id, source_name, source_id, raw_payload, status, attempts, claimed_at
) values
(
  '9129b931-9ff5-460c-9b27-5366e5bfa2a0',
  'f7f683cc-c940-4c59-85df-568b3fe95fd1', 'openstreetmap', 'node/710001',
  '{"type":"node","id":710001}', 'processing', 2, null
),
(
  '17c7b024-f33c-4d89-a52a-7845d9cff3c7',
  'f7f683cc-c940-4c59-85df-568b3fe95fd1', 'wikidata', 'Q710002',
  '{"id":"Q710002"}', 'completed', 2, now() - interval '1 day'
);

commit;
