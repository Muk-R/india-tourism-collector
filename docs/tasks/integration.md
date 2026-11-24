# Agent task: integration coordinator
Branch: dev/integration

## Owned paths
- worker/src/index.ts (exclusive until stable module boundaries are established)
- contracts/openapi.yaml
- cross-feature integration and shared documentation/orchestration
- Do not edit feature-owned production modules, frontend/**, itinerary/**, or QA-owned tests unless coordinating a requested fix.

## Work
Review the existing Worker and its tested collection-cycle/lease migration contract. Complete compatible API integration and collection lifecycle behavior, keeping persisted cycle radius through discovery/processing, bounded retries, checkpoints, renewal/release, stale-worker fences, crash recovery, and public current-link filtering. Preserve security, attribution/licensing, curated places, separate importance/quality, and pilot reconciliation disabled. Existing routes in contracts/openapi.yaml must match implementation; keep planned routes marked planned until implemented and tested. Review ingestion reporting/admin statistics against the queue and identify exact database-dependent gaps. Integrate feature commits only after tests and diff review, in dependency order; do not force-merge or overwrite.

## Acceptance and tests
Worker tests with mocked fetch/RPC cover route auth, RPC argument/response compatibility, discovery pagination, errors, radius persistence, leases and retries, duplicate/source identity behavior, current links, ranking, attribution, and crash recovery. Run npm test, typecheck, Python tests, and local SQL tests where safely available. Update contract status only after route tests exist. Self-review all integrated changes and commit local milestones.

## Dependencies and coordination
Read other agent checkpoints and branches. Keep stable interfaces small. Resolve shared-file requests explicitly. SQL semantics must match migration. Never claim exact inserted-row counts unless backend provides that distinction.

## Autonomous operation / approval
Read AGENTS.md first, inspect status, implement, test, debug, review, and checkpoint autonomously. Local integration commits are approved; no push/deploy/live Supabase. Stop for destructive operations, credential access, paid services, or an unsafe breaking migration; continue independent work.
