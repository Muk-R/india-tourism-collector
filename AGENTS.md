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
