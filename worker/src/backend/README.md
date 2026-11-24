# Backend persistence boundary

`rpc.ts` defines a dependency-free typed adapter for the twelve collection-cycle
RPCs in `supabase/migrations/20261124_collection_cycles.sql`. The integration
layer supplies its authenticated PostgREST transport. RPC names and `p_*`
argument keys are intentionally explicit so an implementation can forward the
database contract without reshaping it.

## Contract assumptions

- PostgREST represents table and `SETOF` results as arrays, including empty
  arrays when a claim returns no work. The persistence adapter does not unwrap
  these results.
- `persist_tourism_cycle_source_page` returns an array of rows with
  `page_applied`, `cursor_after`, and `source_complete`.
- `upsert_tourism_place_for_cycle` returns a UUID scalar; lease renewal returns
  a timestamp scalar; `finish_tourism_collection_cycle` returns an integer
  scalar; release and failure RPCs return their declared boolean/text scalar.
- The Worker validates an explicit radius at its HTTP boundary as an integer
  from 10 through 150 km. An omitted radius uses the valid city radius, then a
  valid configured default, then 40 km. The city schema baseline default is
  already 40 km; the additive migration widens its old 10..50 constraint.
- Importance is an independent 0..100 field. `quality_score` remains a data
  quality measure and is never used as importance. Source identity, raw source
  payload, attribution, license, description provenance, and image URL/license
  fields are accepted in persistence inputs.
- The cycle upsert is expected to enforce city/source/item lease fencing,
  source identity agreement, radius membership, source identity uniqueness,
  and preservation of manual city-place links. Existing place/source/link and
  legacy queue rows are not deleted by the collection-cycle migration.

## Schema gaps kept out of scope

The current schema has no lodging, restaurant, neighborhood, corridor, or
itinerary tables/RPCs. It also has no supported columns for opening hours,
last-entry times, attraction visit durations, meal windows, hotel ratings, or
road travel estimates. `tourism_places.description` with source/license fields
can retain sourced historical context, but it does not establish a city-history
API or verified historical facts. These features need sourced data contracts
and a separately reviewed additive schema proposal before persistence is added.

## SQL regression scenarios for QA

Run only against a new disposable local PostgreSQL database after applying
`supabase/schema.sql`, `supabase/tests/00_legacy_backfill_seed.sql`, the
collection-cycle migration, `supabase/tests/10_collection_cycles_regression.sql`,
and `supabase/tests/99_legacy_backfill_assert.sql`, in that order. Coverage
should continue to assert:

1. 10 and 150 km are accepted, 9 and 151 km rejected, and fractional values
   rejected at the integer RPC boundary.
2. Baseline places, source identities/metadata, city-place links, and legacy
   queue rows survive migration; legacy processing/completed states are copied
   conservatively and old rows remain available for audit.
3. Importance and quality remain separate; source payload, attribution, and
   license survive upsert. A conflicting source identity aborts without moving
   ownership, and a manual city-place link remains unmanaged/current.
4. Concurrent or stale city/source/item leases cannot claim or write work;
   source page replay is idempotent, cursor advancement is atomic, and retry
   counters change only on failures/expired leases.
5. RLS and grants keep cycle tables and privileged RPCs unavailable to public
   roles, and incomplete/truncated cycles cannot retire links.

The current regression SQL already contains scenarios for these areas. This
backend change does not alter the migration, so no follow-up migration is needed.
