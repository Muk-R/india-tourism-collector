# Localise development progress

## Shared baseline
- Base: main at 74473f7ed37a5180653bbbb824c03f7f285c858d.
- Baseline commit: 69be29b98cc3053951cc9eee99a22f7be1effa3c.
- Temporary CodeRabbit review history and REVIEW.md are excluded.
- Worker/API inspection is complete. Existing and planned endpoints are distinguished in contracts/openapi.yaml.
- No frontend or itinerary source existed at setup.

## Parallel work
- Feature task briefs are in the shared setup commit. Branches dev/backend, dev/tourism-data, dev/frontend, dev/itinerary, and dev/qa have separate worktrees based on that commit.
- Overnight launcher is available at scripts/run_overnight.ps1; it launches five feature agents in parallel and the integration coordinator afterward.
- Localise Mission Control is in scripts/mission_control.html and scripts/mission_control.mjs; default URL is http://127.0.0.1:8789/ and port fallback is 8790-8798.
- Review timestamped logs, machine-readable status, and morning-summary.json under the generated overnight run directory.
- Checkpoint: agents use their own ignored .overnight/progress.json.
- Storage policy: C: only; warn below 30 GB; pause storage-intensive work below 20 GB; check every 15 minutes during collection. Do not download bulk photographs.

The integration coordinator updates this file after tested integration milestones. Do not have parallel agents edit this shared file.


## v4.1 execution checkpoint — 2026-11-25
The v4.1 gated backlog supersedes the initial parallel-agent plan above. All setup worktrees and existing feature contributions remain preserved; do not restart the six-agent launcher. The Localise website prototype and the existing `frontend/` and `itinerary/` pilots are to be extended rather than replaced. Earlier Worker 24/24, Python mock-suite, strict TypeScript, and local PostgreSQL migration evidence remains the baseline; do not rerun unchanged suites without a relevant source/configuration change.

Latest host check: C: has 101,711,712,256 bytes free (about 94.7 GiB); Windows reports 5,354 MiB available memory. Node is v26.13.1 and npm.cmd is 11.20.0. Python 3.15.2 is installed; the isolated read-only import check confirmed neither `osmium` nor `requests` is installed. PyPI currently publishes a CPython 3.15 Windows x86-64 `osmium` wheel, so do not replace system Python or create a 3.12 environment unless an actual install/runtime check demonstrates incompatibility. TypeScript 5.9.3 is present in the original checkout's dependency store; a direct sandbox launch was denied, while the earlier approved typecheck remains valid evidence.

The expected `southern-zone-latest.osm.pbf` file was not found by filename in either the user's Downloads folder or this checkout's `data/raw`. No download or PBF processing occurred. G2 remains blocked pending the completed manual download, file integrity/readability verification, and benchmark. Fixture review remains draft-only: the 20 entries have no verified coordinates, durations, or opening hours and must not be promoted to routable places. See the updated G2 evidence and execution state in `docs/BASELINE_BENCHMARK.md` and `docs/V4.1_EXECUTION_BACKLOG.md`.
## Latest handoff checkpoint - 2026-11-25 fast-track decision

The Southern India OSM PBF was processed offline from the existing local snapshot; no duplicate download was started. The full Hyderabad 150 km scan staged 5,893 unique OSM source entities: 5,857 core (within 40 km) and 36 nearby-escape candidates (40-150 km). Categories overlap: attraction 2,031, accommodation 724, food 2,133, transport 1,010. The stage validator passed with zero record errors. All records remain review-only and non-routable; no Supabase writes or live tourism collection requests were made in this session.

The 20 draft Hyderabad landmark candidates remain unpromoted. The exact-name report found OSM candidates for 12 names (14 OSM rows), two ambiguous name groups, and eight names without exact matches. Official-source evidence covers 11 individually documented candidates; nine have only official list-level mentions. A Ramoji Film City location discrepancy remains: the Telangana Tourism coordinate is about 38.64 km from the OSM relation point; the OSM-linked Wikidata coordinate agrees with the OSM location, but the visitor entrance is not verified. See data/local_pilot/hyderabad/landmark-evidence-review.md and the local candidate/ambiguity artifacts.

Latest relevant checks: focused Python suite 13/13 passed; Worker suite 22/22 passed; Worker TypeScript typecheck passed; git diff --check passed with only existing LF/CRLF notices. Local PostgreSQL 17 migration/regression scripts passed earlier against the isolated localise_test database; they were not rerun because their inputs did not change.

Owner decision: defer detailed landmark enrichment, unmatched-name work, similarity scans, current opening-hour verification, fees, and visit-duration research to Session A. Keep every unverified landmark non-routable. Broader duplicate review remains pending; preserve all candidate entities and links. Offline PBF cycle intake remains blocked on a separate cursor/source-mode and additive RPC contract. Frontend/itinerary edits remain in their existing worktree and are not included in this local collector integration commit.

Session A: fast-track the Hyderabad website using real, validated data where available, resolve targeted landmark identity/access and the Ramoji coordinate discrepancy, and keep unsupported fields unknown. Session B: design optimized shared regional extraction for the first ten cities, reusing the completed bounded-memory pipeline and never downloading the existing PBF again.

### Fast-track final checks — 2026-11-25

The integration Worker suite now passes 22/22. Two pre-existing assertions were updated to match the current v1 OSM discovery cursor: OSM discovery completes after the attraction, lodging and restaurant page sequence; incomplete page checkpoints retain pending tiles under `cursor.cursors[kind].pending`. The assertions still verify finalization only after complete discovery and resumable state after an invocation limit. TypeScript 5.9.3 `--noEmit` passed against the integration Worker configuration. No source extraction was repeated, no database was accessed, and no production operation occurred.

The session is ready for handoff. Pending/deferred work remains explicitly assigned to Session A (landmark enrichment, identity ambiguities, exact unmatched names, optional similarity, verified hours/fees/durations) and Session B (shared regional extraction for ten cities). Every unresolved landmark remains non-routable. The offline PBF-to-Worker queue bridge remains blocked on an additive database intake contract and isolated regression tests; frontend/itinerary integration remains blocked by workspace access. See `data/local_pilot/execution_state.json` for task-level recovery instructions.

### Session A offline importer and isolated database gate — 2026-11-25

Implemented additive private snapshot/staging tables, a service-role-only idempotent batch RPC, exact count finalization, and admin-only Worker batch/finalize routes. Source OSM identities, unmodified JSON records/raw tags, source snapshot/checksum, ODbL license, attribution, geometry evidence, categories, importance evidence, and area classification are retained. Named records remain `needs_review`; missing-name rows are stored with `quarantine_reason=missing_name`. No row is copied to canonical/public tables or marked itinerary-ready. The route validates bounded payloads and rejects malformed, out-of-radius, provenance-mismatched, or itinerary-ready records. Manual independent review repaired malformed-body handling and byte-based request sizing; confirmed defects were regression-tested.

Validation used the existing JSONL artifact without PBF re-extraction. PostgreSQL 17.12 ran from an isolated, loopback-only disposable cluster on port 55432. The SHA-256 snapshot is `55d690a9c4418b5d14aa38fe399041e27883a53ecc55dd0b6dfed97bed8a947b`; source timestamp `2026-11-23T21:21:17Z`; 5,893 rows. Three full import passes reconciled: pass 1 inserted 5,893; pass 2 inserted 0 and recognized 5,893 identical; pass 3 after finalization inserted 0 and recognized 5,893 identical. Database totals: 5,893 rows, 5,893 distinct source keys matching the source key set exactly, 5,893 distinct raw records, 4,153 review-only, 1,740 nameless quarantine, 0 itinerary-ready. Finalization returned those same counts and froze the snapshot. An altered payload after finalization was rejected.

Database security regression passed with `anon` and `authenticated` unable to read staging tables or execute import RPCs; `service_role` has the RPC grant. Worker focused route/mapper checks passed 8/8, TypeScript `--noEmit` passed, and `git diff --check` passed. SQL migration was applied and rerun successfully in the disposable database. The public role test exercises the actual isolated database grants/RLS. A local PostgREST/Supabase HTTP server is not installed, so an end-to-end HTTP request traversing PostgREST against that database remains unverified; Worker route transport tests use a mocked PostgREST response. Production remains untouched. The Python runner was not needed for this TypeScript/SQL intake and remains blocked by Windows process creation under the sandbox; `psql.exe` worked through the permitted direct execution path.

This checkpoint is importer/database validation only. It is not a production deployment or production database change. The existing website remains isolated and unchanged during this step. Licensing approval and independent landmark verification remain pending before any staged row can be published or routed.

Execution accounting for this importer gate: approximately 35 productive minutes; approximately 14 seconds of database processing across three import passes; under 0.2 minutes of automatic-review delay. A sandbox restriction blocked Node child-process creation, so SQL batches were generated locally and run using the already verified direct `psql.exe` path. The disposable PostgreSQL server was cleanly stopped after validation; its data directory and logs remain preserved.
