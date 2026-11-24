# Worker collection-cycle testing

## Local checks

From `worker/` run:

```text
npm test
npm run typecheck
```

The Worker tests replace `fetch` with in-memory mocks. They do not contact Supabase, Overpass, Wikidata, Wikipedia, or Cloudflare.

## Collection contract

- `/admin/collect` uses the database's fair `claim_next_tourism_collection_cycle` RPC and each city's persisted radius.
- `/admin/collect-city/{city_id}?radiusKm=N` supports integer radii from 10 through 150 km. An active cycle keeps its persisted radius; changing it requires `rediscover=true`, which starts a new cycle without deleting prior place or link records.
- `confirmLegacyRadius=true` is an explicit administrative confirmation for a backfilled cycle with an uncertain historical radius.
- `reconcile_links` is always false in Worker claims for the pilot. Rediscovery and incomplete cycles therefore do not retire old links.
- Discovery persists each page and cursor with `persist_tourism_cycle_source_page`. OSM uses geographic tiles, subdivides overloaded tiles, and does not apply an output-count cap. Wikidata uses ordered `LIMIT`/`OFFSET` pages. Up to three pages per source are handled in one invocation; unfinished source/city leases are checkpoint-released.
- OSM and Wikidata payloads remain in source records. The Worker retains OSM, Wikidata, and Wikipedia attribution/license fields; image URLs remain unverified source metadata and are not published as approved place images.

## Required integration verification before deployment

1. Apply the current reviewed schema and corrected collection-cycle migration to a disposable local Supabase/PostgreSQL instance. The migration was changed after the earlier SQL regression run so city-link relevance uses `importance_score`; rerun the migration SQL tests from a clean disposable database. Do not reapply it over an already-migrated database without preparing a proper follow-up migration.
2. Run Worker requests against that local instance using a non-production service role. Verify each RPC argument and response against the installed PostgREST version, including scalar return decoding for `finish_tourism_collection_cycle`.
3. Exercise concurrent claims from separate clients; expire city, source, and item leases between requests; interrupt requests after page persistence and after the final page; verify recovery, retry counts, and cursor continuity.
4. In a controlled staging environment, validate Overpass tile coverage and subdivision for dense and remote areas, and Wikidata paging across pages where the result count is exactly the page size. Confirm rate limits, timeouts, response sizes, and full-radius boundary behavior without starting a broad collection run.
5. Verify source/license attribution and manual city-place preservation with staging fixtures. Automatic stale-link retirement must remain disabled for the pilot.
6. Confirm ingestion-run counters with product reporting. The current upsert RPC returns a place UUID but does not distinguish a newly inserted place from an updated canonical place; `inserted_count` therefore cannot be made exact without a database RPC change.

Hotels, restaurants, neighborhoods, and travel-corridor datasets can reuse the same city-cycle radius, geographic cursor, source payload, and lease machinery. Their discovery tag/query sets and ranking policy still need a separately scoped implementation and tests.
