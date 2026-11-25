# Localise v4.1 baseline and benchmark readiness

Date: 2026-11-25 (Asia/Kolkata)
Scope: read-only baseline inspection plus additive local documentation/ignore rules. No database, production, or PBF operation was performed.

## G1 — preservation and baseline

**Result: pass.** Existing source changes and local collection artifacts were preserved. No reset, stash, delete, force operation, download, migration, or live service call was used.

### Project repositories

| Area | Observed state | Handling |
|---|---|---|
| Collector original checkout | `coderabbit-full-review-temp`, HEAD `e5aca11`; modified `scripts/run_batch.py`, `scripts/seed_cities.py`, `worker/package.json`, `worker/src/index.ts`; untracked tests, migration, Worker testing notes. | Preserved. This artificial review branch is not the v4.1 integration baseline. |
| Collector integration worktree | `dev/integration`, HEAD `df6e69b`; contains the existing Worker, frontend and itinerary pilot. The Worker entry point and a few shared docs/launcher files have local uncommitted integration changes. | Safest working baseline for this task; all existing diffs retained. Do not restart the legacy overnight launcher. |
| Other collector worktrees | `dev/backend` `d1988f2`; `dev/tourism-data` `2a9e7de`; `dev/qa` `169bb0e`; `dev/frontend` `4cfc5a7`; `dev/itinerary` `8193eaf`. | Commits and evidence preserved locally; no pushes. |
| Separate Localise product checkout | `C:\Users\Mukesh Reddy\Documents\ChatGPT\localise`; branch `master` has no commit yet and the website/assets/schema/archive are untracked. Existing `index.html` is a 103,651-byte styled Hyderabad prototype titled “Localise — India, locally.” with city, discovery, food, itinerary and social sections; one PNG asset was present. | Left unchanged. Keep this design as the product reference; do not replace it or infer that the separate checkout is a clean Git baseline. |

The existing `data/cities-template.csv` has a Hyderabad row centered at `17.3850,78.4867`, and existing city seeding uses a 40 km default. These are current project values, not owner approval of the geographic boundary or named exceptions.

### Current verified feature/evidence baseline

- The integrated Worker suite passed 24/24 after the composite OSM cursor/category assertions were updated. Strict TypeScript checking passed for the integration runtime.
- Backend collector mock suite: 17 tests passed; covers per-attempt accounting, cumulative resume and refusal of legacy checkpoints with unknown accounting.
- Tourism supplement mock suite: 8 tests passed; no-network dry run passed.
- Local PostgreSQL 17.12 migration/regression checks passed in an isolated local database in the prior testing session. No database was contacted in this baseline review.
- Fresh Hyderabad OSM snapshot: 228 unique stored OSM IDs (78 attractions, 104 restaurants, 46 lodging), all within the checked 40 km circle and carrying OSM attribution/ODbL. The run is incomplete: 15 request attempts checkpointed (8 initial + 7 resumed), 55,415 response-body bytes accounted, 1 tile completed and 9 pending. One `QueryFailure` and one HTTP 502 were recorded; the last request was interrupted. Repeated-observation duplicate counts and rejected-feature counts remain unknown. The separate earlier 11-row snapshot has an unknown attempt count and was not resumed. No city completion is claimed.
- Wikidata supplement: one physical request attempt, zero evidenced records; the response status was not preserved by the first live attempt, so no retry was made.

### Host and toolchain snapshot

| Resource/tool | Observed value |
|---|---|
| C: capacity/free space | 275.85 GB total; 95.15 GB available at inspection (above the 30 GB warning threshold). |
| CPU | 12 logical processors. |
| Available memory | Approximately 2,022 MB from the Windows performance counter. |
| Node.js / npm | Node `v26.13.1`; npm `11.20.0`. |
| Python | `py -3 -B` resolves Python `3.15.2` at the registered per-user interpreter. Interpreter process creation is denied inside the sandbox; the previously approved outside-sandbox path works. `pyosmium` and `requests` are not installed. |
| TypeScript | Existing compiler package is present under the original collector checkout's `worker/node_modules` (pnpm-managed TypeScript 5.9.3). Direct package access is restricted in the sandbox; the already verified approved compiler/type-root path has passed checks. |
| PostgreSQL | `C:\Program Files\PostgreSQL\17\bin\psql.exe`, version 17.12. No connection made for this baseline. |
| Osmium / WSL | No `osmium` CLI found. `wsl.exe` is present but no WSL distribution is installed. |

## G2 — offline PBF benchmark

**Status: blocked; no benchmark performed.** The expected file `data/raw/southern-zone-latest.osm.pbf` is not present at the requested collector path. No download was initiated. The PBF has not been opened or processed. Pyosmium is absent and WSL has no installed distribution; no package was installed and no native compilation was attempted. Once the manually downloaded file is complete, first verify that it is readable, record size/source/snapshot/checksum, then perform the bounded Pyosmium benchmark in the v4.1 task brief. Do not run the existing HTTP collector as a substitute without a separate scoped approval.

## Owner gates still open

- Approve the exact Hyderabad center/boundary rule and named exceptions. Keep the existing center as a candidate only.
- Review/freeze the 20-entry landmark reference before treating it as an acceptance oracle; all entries in the provided draft are currently unapproved.
- Approve the data contract after mapping it to existing DTOs; the proposed v4.1 fields do not authorize a schema rewrite.
- Review the ODbL/licensing proposal before staging publication or public release. Its draft is not a legal determination or approved policy.
- The supplied 20-place fixture is development-only and currently has null latitude, longitude, opening hours, and visit durations for all 20 rows. It is not routable or a real-data acceptance dataset.

Gate status is tracked in `docs/V4.1_EXECUTION_BACKLOG.md`. Recheck the expected PBF path at meaningful task transitions, not continuously. Keep raw extracts and generated data out of Git; the expected PBF and local Hyderabad pilot output paths are ignored.


## Checkpoint correction — 2026-11-25
A fresh filename-only search found no `southern-zone-latest*` file in either `C:\Users\Mukesh Reddy\Downloads` or this checkout's `data/raw`. No PBF was read, moved, downloaded, or processed. The previously recorded designated-path absence is therefore unchanged; check these two locations again only at a meaningful task transition.

Fresh resource readings supersede the earlier host row above: .NET DriveInfo reports C: free bytes = 101,711,712,256 (about 94.7 GiB), and `\Memory\Available MBytes` reports 5,354 MiB. The earlier 2,022 MiB memory result is historical; it is not the current reading. These host values are availability snapshots, not a guarantee that the PBF index will fit in RAM.

The Python launcher reports CPython 3.15.2. A read-only interpreter probe found no installed `osmium` or `requests`. Current PyPI metadata lists `osmium 4.3.2` with a CPython 3.15 Windows x86-64 wheel; this is compatibility evidence, not a local installation/runtime benchmark. Do not install packages until the completed PBF reaches the benchmark gate. The previously passing Worker/TypeScript tests remain the baseline; an additional direct compiler launch was denied by sandbox package access, so it is not counted as a new pass.
