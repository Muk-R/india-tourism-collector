# Agent task: backend
Branch: dev/backend

## Owned paths
- supabase/migrations/** (additive migration files only)
- worker/src/backend/**
- Provide SQL test scenarios to QA; do not edit worker/src/index.ts or QA-owned test paths.

## Work
Inspect schema.sql, the collection-cycle migration, Worker RPC call sites through read-only inspection, and current migration regression docs. Build focused typed persistence/RPC adapters in worker/src/backend/ with a small stable interface for integration. Recheck migration compatibility and preserve places, source identities, manual city-place links, attribution, and legacy queue rows. Identify any schema-dependent itinerary, lodging, restaurant, historical, and corridor needs; do not invent schema facts or expand scope without evidence. If correcting a migration, use an additive follow-up rather than rewriting one already applied outside a fresh disposable database.

## Acceptance and tests
- Interfaces match the existing PostgREST RPC names, arguments, and return shapes; list assumptions explicitly.
- Radius validation supports integer 10..150 km with 40 km default at the API boundary.
- Importance remains separate from quality; source/license metadata is retained.
- SQL changes are additive and have regression coverage requested from QA.
- Run Worker typecheck where relevant and verify migration/tests only on a new disposable local database, never localise_test or remote Supabase.
- Review diff for data-loss, RLS, identity, and lease-fencing risks; commit passing milestones locally.

## Dependencies and coordination
Use contracts/openapi.yaml for HTTP contracts. Send route needs to integration in .overnight/progress.json. Coordinate DB result-shape changes with integration before implementation.

## Autonomous operation / approval
Read AGENTS.md first, inspect status, implement, test, debug, self-review, and checkpoint autonomously. Routine local tests, dependencies, and local commits are authorized. Stop only for forbidden live/production access, destructive database or Git action, credential access, paid service, or a breaking schema decision that cannot be resolved additively. Log the blocker and continue independent work.
