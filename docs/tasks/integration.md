# Agent task: integration coordinator
Branch: dev/integration

## Owned paths
- worker/src/index.ts (exclusive until stable module boundaries are established)
- contracts/openapi.yaml
- cross-feature integration and shared documentation/orchestration
- Do not edit feature-owned production modules, frontend/**, itinerary/**, or QA-owned tests unless coordinating a requested fix.

## Work
Review the existing Worker and its tested collection-cycle/lease migration contract. Complete compatible API integration and collection lifecycle behavior, keeping persisted cycle radius through discovery/processing, bounded retries, checkpoints, renewal/release, stale-worker fences, crash recovery, and public current-link filtering. Preserve security, attribution/licensing, curated places, separate importance/quality, and pilot reconciliation disabled. Existing routes in contracts/openapi.yaml must match implementation; keep planned routes marked planned until implemented and tested. Review ingestion reporting/admin statistics against the queue and identify exact database-dependent gaps. Integrate feature commits only after tests and diff review, in dependency order; do not force-merge or overwrite.

## Immediate continuation priority
1. Adopt the committed tourism-data helpers from `dev/tourism-data`, especially `buildOverpassQuery`, `createTileCursor`, `subdividePendingTile`, `completePendingTile`, `normalizeOsmCandidate`, `deduplicateCandidates`, `scoreImportance`, and `validateBoundingBox` in `worker/src/tourism-data/catalog.ts`. Review that branch before merging; do not duplicate implementations in `index.ts`.
2. Wire OSM attraction, lodging, and restaurant discovery sequentially under the existing `openstreetmap` source lease. Persist a composite cursor containing discovery kind and tile cursor through the existing source-page RPC; use a stable page key per kind/tile and atomically checkpoint with queue insertion. Use only the cycle's persisted radius (10–150 km; default 40 at claim time), exact distance filtering, bounded request/retry budgets, lease renewal, and checkpoint release/recovery. Keep remote natural features and travel-corridor places; never silently cap results.
3. Add mocked Worker regressions for composite cursor replay, all three OSM kinds, tile subdivision, radius persistence, incomplete/error state, lease loss, and safe retry. The existing migration has only OSM and Wikidata source rows; do not add source kinds or edit the tested migration unless a concrete incompatibility is proven and reported first.
4. Integrate compatible backend public-read, frontend, and itinerary commits after reviewing diffs. Keep unavailable data fields null/unknown and preserve source/license metadata.
5. When the fresh isolated Hyderabad snapshot is available, validate it from its evidence summary. Do not call `/admin/collect`, write Supabase, or claim a city complete from a partial local snapshot.

## Acceptance and tests
Worker tests with mocked fetch/RPC cover route auth, RPC argument/response compatibility, discovery pagination, errors, radius persistence, leases and retries, duplicate/source identity behavior, current links, ranking, attribution, and crash recovery. Run only tests affected by a change, then the integrated suite once integration is ready. Reuse verified Python/TypeScript/PostgreSQL installations; do not retry known denied tool paths or repeat unchanged test suites. Update contract status only after route tests exist. Self-review all integrated changes and commit local milestones.

## Dependencies and coordination
Read other agent checkpoints and branches. Keep stable interfaces small. Resolve shared-file requests explicitly. SQL semantics must match migration. Never claim exact inserted-row counts unless backend provides that distinction.

## Autonomous operation / approval
Read AGENTS.md first, inspect status, implement, test, debug, review, and checkpoint autonomously. Local integration commits are approved; no push/deploy/live Supabase. Stop for destructive operations, credential access, paid services, or an unsafe breaking migration; continue independent work.
