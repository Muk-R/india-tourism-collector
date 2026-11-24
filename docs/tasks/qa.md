# Agent task: quality assurance
Branch: dev/qa

## Owned paths
- worker/test/**
- scripts/test*.py
- supabase/tests/**
- qa/**
- Do not edit production code or Worker routes; report defects to the owning agent and continue independent tests.

## Work
Build and maintain regression coverage for Worker pagination, radius consistency and 10/150 boundaries, source failures and retries, stale leases, crash recovery, checkpoint release, deduplication and attribution; Python CLI credentials and safe prompts; SQL backfill, identities, manual links, leases, RLS/RPC permissions; frontend accessible states; and itinerary feasibility. Use mocked external APIs and database RPC responses. SQL tests run only against new disposable local databases. Do not reset/drop localise_test, access live Supabase, or run broad collection.

## Acceptance and tests
Preserve current tests and assertions. Add focused tests for real bugs rather than weakening expectations. Use fixed-seed itinerary scenarios. Run npm test/typecheck, Python syntax/unit tests, and disposable PostgreSQL migration tests when available. Report exact failed checks and reproduce defects for the owner. Review attribution, credential handling, data loss, and conflicting edits. Commit passing test milestones locally.

## Dependencies and coordination
Base tests on contracts/openapi.yaml and task interfaces. When behavior is missing, specify expected behavior in the test and notify its owner; do not guess or edit production.

## Autonomous operation / approval
Read AGENTS.md first, inspect status, implement, test, debug, review, checkpoint, and commit autonomously. Stop only for forbidden live/production access, destructive operations, credentials, or non-isolated database use; continue other test work.
