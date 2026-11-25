# Localise repository instructions

Read docs/PRODUCT_REQUIREMENTS.md, docs/ARCHITECTURE.md, docs/DEVELOPMENT_TASKS.md, your docs/tasks brief, and contracts/openapi.yaml before editing.

## Ownership
Work only in your assigned worktree and branch. Follow the ownership table in docs/DEVELOPMENT_TASKS.md. Integration exclusively owns worker/src/index.ts until stable module boundaries are established. Do not edit files owned by another agent. Put interface requests and blockers in your own ignored .overnight/progress.json. Do not update shared docs/PROGRESS.md while agents run.

## Workflow
Inspect Git status and existing code first. Preserve all current work. Make focused changes, add tests, run relevant checks, review the diff, and create local milestone commits when acceptance criteria pass. Never push. Keep .overnight/progress.json as valid JSON with only agent, status, completed, current, tests, commits, next, blockers, and updated_at_utc fields. Do not include secret values, environment data, or credentials. Do not commit the checkpoint.

Label mock data clearly. Never describe mocks as verified or collected data. Do not invent facts, hours, durations, dietary labels, hotel ratings, historical claims, or source attribution.

## Safety
Never read, print, log, copy, or modify secrets, tokens, password files, credential stores, or .env files. Do not inspect environment variable values. Do not access live Supabase, deploy, push, buy services, enable untrusted hooks, or run destructive Git/database operations. Keep workspace sandbox protections enabled.
Database work is additive. Verify SQL only in a new isolated local database; never reset or drop localise_test or another existing database. Rate-limited public-source collection into isolated local storage is allowed only after the collector is verified, with bounded scope and provider-compliant requests. Never write to a remote database or production service.
If blocked by a forbidden operation, record the blocker and continue independent work. Before completion, run the task checks, git diff --check, and review the final diff.

Localise is an intelligent personal tour guide. Product requirements, rollout goals, and source policies are defined in docs/PRODUCT_REQUIREMENTS.md.

## Storage
Keep worktrees, local databases, logs, and collection artifacts on C:. Never use M:. Check C: free space before storage-intensive work and every 15 minutes during collection. Warn below 30 GB and pause storage-intensive work below 20 GB while preserving checkpoints. Store image URLs with attribution/license metadata instead of downloading bulk photographs. Compress large raw archives when appropriate and avoid duplicate dependency or dataset copies. Never delete existing user files or databases.

## Localise v4.1 execution policy
The v4.1 gated backlog in `docs/V4.1_EXECUTION_BACKLOG.md` is the current implementation strategy and supersedes the earlier continuous six-agent overnight workflow. Use one lead session and at most one specialist session; run no more than one resource-intensive process at a time. Do not restart the legacy multi-agent launcher or create another permanent orchestrator. Keep Mission Control available for monitoring, but do not spend development time redesigning it.

- Prefer the manually downloaded Southern India PBF and existing collector code. Never start or duplicate a PBF download, process an incomplete file, or create a parallel collector. If the expected PBF is absent, continue independent development and check again at meaningful task transitions. Keep source extracts and generated datasets outside Git; `.gitignore` excludes the expected PBF path and local pilot snapshots.
- For any retained HTTP path, budget and count every physical request, including retries and redirects, before sending; use provider-compliant rate limits and preserve status, byte, and retry evidence. Do not retry unchanged provider failures. An HTTP fallback requires its own scoped approval if selected by a later gate.
- Use only owner-approved city scope/configuration and a frozen, owner-approved reference list for extraction and acceptance. Keep draft city centers, exceptions, reference landmarks, and licensing proposals explicitly unapproved until the owner approves them.
- Keep test fixtures separate from collected records. Preserve raw tags and geometry; use original OSM node coordinates or a representative interior point for ways/relations. Leave navigation points null unless checked. Keep source identity separate from canonical place identity and do not make uncertain automatic merges.
- Do not fabricate missing facts. Preserve provenance and source licensing; do not copy Wikipedia article text or images during the pilot. Store permitted source links and metadata only. Do not publish ODbL-derived data until the required attribution and licensing review is approved.
- Prefer short, atomic, idempotent local batch jobs. Add durable checkpoint infrastructure only when measured task duration requires it. Report exact commands, artifacts/checksums, observed counts, test results, blockers, and gate status; unknown counts must remain unknown rather than zero.

## Permission-aware unattended execution

Before each task, check existing permissions, prerequisites, and legitimate permitted alternatives. Avoid changing approved command invocation patterns. If additional permission is unavoidable and the task is not a prerequisite for remaining work, mark it BLOCKED_PERMISSION and continue with the highest-priority independent task. Do not repeat unresolved permission requests.

Maintain data/local_pilot/execution_state.json using only these statuses: PENDING, RUNNING, COMPLETED, BLOCKED_PERMISSION, BLOCKED_DEPENDENCY, FAILED_RETRYABLE, and FAILED_REVIEW_REQUIRED. Persist dependencies, checkpoint evidence, test results, artifacts, and safe recovery instructions after significant operations. Revisit deferred tasks when prerequisites or permissions change.

Keep one implementation task active and at most one resource-intensive process running. Preserve checkpoints, memory/disk safeguards, sandbox boundaries, and completed work. Do not bypass sandbox restrictions, fabricate results, or perform production database writes, remote pushes, or deployment without separate approval. Continue independent work while tasks are blocked; stop for human intervention only when useful work is blocked or a required safety/authorization decision is missing.