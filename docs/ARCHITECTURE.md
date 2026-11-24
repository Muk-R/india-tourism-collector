# Architecture and integration boundaries

## Current implementation
- worker/src/index.ts is the Cloudflare Worker entry point and currently combines routes, Supabase/PostgREST access, collection-cycle and lease orchestration, OSM/Wikidata/Wikipedia adapters, normalization, ranking, admin review, and statistics. Integration exclusively owns it until module boundaries are stable.
- supabase/schema.sql is the legacy schema baseline. supabase/migrations/20261124_collection_cycles.sql adds collection-cycle, source, queue, lease, and persistence RPC support. SQL tests are in supabase/tests/.
- Python city seeding and batch administration live in scripts/.
- No frontend or itinerary application source exists. Start those in dedicated top-level directories.

## Target boundaries
- worker/src/backend/: typed persistence and RPC adapters.
- worker/src/tourism-data/: source queries, pagination, normalization, category mapping, importance ranking, and source metadata rules.
- frontend/: mobile traveler and admin experience.
- itinerary/: deterministic scheduling and rescheduling domain engine, independent of UI/provider SDKs.
- contracts/openapi.yaml: shared public/admin HTTP contract.
- Database changes remain additive and are verified on a disposable local database.

## Data flow
A city cycle owns its persisted radius and checkpoints. OSM and Wikidata discovery enqueue source records; leased queue processing creates canonical places and current city links. Keep source attribution/license metadata and separate importance from quality. Pilot automatic stale-link retirement remains disabled. Public DTOs must not expose credentials, lease tokens, internal RPC payloads, or unreviewed media. Planned lodging, restaurant, city-history, and itinerary features may use clearly labeled mocks until APIs and supported data exist.

## Integration
Review contracts before client integration. Agents work in isolated worktrees with disjoint ownership. Integrate only reviewed, tested local commits. Never write live Supabase or deploy during autonomous development.
