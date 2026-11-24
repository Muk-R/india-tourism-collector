# Agent task: tourism data
Branch: dev/tourism-data

## Owned paths
- Production scripts/*.py
- worker/src/tourism-data/**
- Do not edit worker/src/index.ts, contracts, or tests owned by QA.

## Work
Complete source-appropriate attraction discovery, category normalization, importance ranking, metadata preservation, and robust hotel/restaurant collection design. Include remote peaks, waterfalls, viewpoints, attractions near neighborhoods, and tourist travel corridors; do not bias toward hotels/settlements. Support full configured radius, validated 10..150 km with default 40 km, complete pagination/subdivision, persisted/resumable cursors, bounded retries, timeouts, Retry-After, deduplication, and source attribution/licensing. Keep importance separate from quality. Preserve historical/source payload fields useful to future duration, hours, and itinerary estimates. Never invent missing labels, dietary status, ratings, or descriptions.

## Acceptance and tests
Mock OSM, Wikidata, and Wikipedia responses; cover pagination beyond page one, subdivisions, source errors, timeouts/retries, radius boundary inclusion, duplicates, category normalization, importance vs quality, attribution/license, and unknown hotel/restaurant classifications. Public-source collection may be performed only after local verification, only with bounded rate-limited requests into isolated local storage, and must retain checkpoints. Do not bulk-download photographs; store source URLs and attribution/license metadata. Keep archives compressed and avoid duplicated dependencies/data. Check C: free space; pause storage-intensive collection/dependency/archive work below 20 GB, warn below 30 GB, and check every 15 minutes during a collection run. Never use M:.
Run Python tests and syntax checks plus Worker checks as relevant; self-review and commit passing milestones locally.

## Dependencies and coordination
Use contracts/openapi.yaml and backend interfaces. Ask integration for any route/index change via checkpoint. Use clearly described request/response shapes, not guessed shared types.

## Autonomous operation / approval
Read AGENTS.md first, inspect status, implement, test, debug, review, and checkpoint autonomously. Do not access secrets, remote Supabase, production services, or provider-restricted endpoints. Stop for unsafe/external requests and continue independent tasks.
