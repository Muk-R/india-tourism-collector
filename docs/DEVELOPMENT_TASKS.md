# Parallel development ownership and sequence

| Branch | Initial exclusive ownership |
|---|---|
| dev/backend | supabase/migrations/** (additive only), worker/src/backend/**; coordinate SQL regression cases with QA |
| dev/tourism-data | production scripts/*.py, worker/src/tourism-data/**; do not edit tests or worker/src/index.ts |
| dev/frontend | frontend/** |
| dev/itinerary | itinerary/** |
| dev/qa | worker/test/**, scripts/test*.py, supabase/tests/**, qa/** |
| dev/integration | worker/src/index.ts, contracts/openapi.yaml, cross-feature integration, shared docs, overnight orchestration |

Integration exclusively owns worker/src/index.ts until stable interfaces are published. Feature agents must request route changes in their own checkpoint instead of editing that file.

## Sequence
1. Backend and tourism-data define independently testable persistence and source modules.
2. Frontend and itinerary proceed with clearly labeled mocks against contracts/openapi.yaml.
3. QA adds regression, security, attribution, and itinerary feasibility coverage.
4. Integration reviews and incorporates compatible tested commits in dependency order, then updates API implementation status.
5. Do not integrate untested or conflicting changes.

## Session protocol
Each agent reads AGENTS.md and its task brief, inspects status, implements/tests/reviews within ownership, and commits passing milestones locally. It writes its own ignored .overnight/progress.json. The coordinator writes shared progress after integration. Timestamped logs and machine-readable run summaries are stored outside source worktrees.


## v4.1 backlog precedence
The earlier parallel-agent ownership table and session protocol above describe the completed setup phase. They are historical and do not authorize restarting the old multi-agent launcher. For current work, follow `docs/V4.1_EXECUTION_BACKLOG.md`, the v4.1 gates in `AGENTS.md`, and the current checkpoint in `docs/PROGRESS.md`. Use one lead session and at most one specialist; keep tasks sequential and continue independent work when a gate is blocked.