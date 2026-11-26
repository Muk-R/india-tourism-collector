# Session A Hyderabad pilot release preparation

Status: **website-only Hyderabad pilot deployed** to the temporary Localise endpoint. The isolated database restore was verified separately. No production database migration or tourism-record publication occurred in this website-only release.

## Verified release inputs

- Collector changes retain commits `53ff417` and `f737722`.
- Validated OSM snapshot: `sha256:55d690a9c4418b5d14aa38fe399041e27883a53ecc55dd0b6dfed97bed8a947b`, source timestamp `2026-11-23T21:21:17Z`, 5,893 unique records.
- The isolated database contains 5,893 private staging rows: 4,153 review-only, 1,740 missing-name quarantine, and zero itinerary-ready. These rows are not public API records.
- Approved-record browser/API behavior was exercised only with 120 explicitly synthetic rows in an isolated fixture. Never copy that fixture to production.
- `wrangler deploy --dry-run` compiled the Worker (61.33 KiB, 15.04 KiB gzip) and the static site. Neither command deployed.

## Hard gates before any production command

1. Obtain explicit owner approval for the exact migration, reviewed source snapshot, Worker commit, website commit, and deployment sequence.
2. Obtain and record ODbL review/approval and required attribution. Select only individually reviewed real records for publication. Keep unresolved identities and the Ramoji Film City entrance unroutable.
3. Independently inspect production migration history and schema drift using authorized read-only access. This session did not inspect live Supabase; project instructions prohibit it.
4. Produce reviewable import batches from the validated source artifact. The checked-in Worker accepts JSON batches of at most 500 records and 1.5 MB each; do not use the synthetic E2E fixture or manually alter source records.
5. Confirm exact expected counts and checksum before finalization. Finalization freezes the private snapshot; it does not publish it.
6. Confirm the prior deployed Worker and website version IDs and the rollback owner before release.
7. Resolve a Cloudflare read-only configuration anomaly before using the existing Worker credentials: one secret binding name contained secret-shaped text. The value was not intentionally requested or used. Have the owner verify the binding and rotate the affected secret if confirmed; do not copy it into source or logs.

## Command templates (do not run before approval)

Use the project-approved Supabase CLI linked to the intended project. First inspect migration history and preview changes; do not reset the database:

```powershell
supabase migration list --linked
supabase db push --dry-run
# After the explicit production migration approval only:
supabase db push
```

The offline staging migration is `supabase/migrations/20261125_offline_pbf_staging.sql`; verify the prerequisite collection-cycle migration `20261124_collection_cycles.sql` is present in the same reviewed migration set. A production migration must be approved separately from an application deployment.

Worker configuration is `worker/wrangler.toml`. Never place credentials in shell history, source, or `localise-config.js`. Do not issue individual `wrangler secret put` commands during preparation: each creates and immediately deploys a version. After all gates and explicit deployment approval, upload the reviewed code and required secrets as one non-deployed version from an owner-managed protected secret file, then promote that exact version:

```powershell
Set-Location worker
pnpm exec wrangler deploy --dry-run --config wrangler.toml --outdir ..\.overnight\worker-release-dry-run
# After explicit deployment approval only:
pnpm exec wrangler versions upload --config wrangler.toml --secrets-file '<owner-managed-protected-secret-file>'
# Record the version ID returned by upload, review it, then deploy that exact version after approval:
pnpm exec wrangler versions deploy '<approved-version-id>@100%' --config wrangler.toml
```

Avoid individual secret writes during preparation because they can deploy immediately. A single `versions upload --secrets-file` operation creates an undeployed code/config/secrets version; `versions deploy` activates the approved version. Never put the protected secret file in the repository or print its contents.

For each approved JSON batch (prepared from the source artifact by a reviewed exporter), post it to the private staging endpoint and verify its response before continuing:

```powershell
$workerOrigin = 'https://<approved-worker-host>'
Invoke-RestMethod -Uri "$workerOrigin/admin/import-offline-pbf" -Method Post `
  -Headers @{ Authorization = "Bearer $env:LOCALISE_ADMIN_TOKEN" } `
  -ContentType 'application/json' -InFile '.\<reviewed-batch>.json'
```

After all batch counts reconcile to the approved manifest, finalize the private snapshot:

```powershell
$body = @{ snapshot_id = 'sha256:<approved-source-sha256>' } | ConvertTo-Json -Compress
Invoke-RestMethod -Uri "$workerOrigin/admin/import-offline-pbf/finalize" -Method Post `
  -Headers @{ Authorization = "Bearer $env:LOCALISE_ADMIN_TOKEN" } `
  -ContentType 'application/json' -Body $body
```

Do not add any promotion/publication call until the publication review and approval gate is complete. The currently verified API has no automatic path from private PBF staging to public tourism rows.

The isolated site checkout does not have its own Wrangler package. Use the lockfile-installed CLI from `worker/`. The static site uses `localise-config.js` and `wrangler.jsonc`. Set only the reviewed public Worker origin; it must contain no server credential. Then dry-run and deploy the reviewed site commit:

All current `workers.dev` hosts are temporary pilot endpoints. The final release will use a new custom domain. Keep the website API origin in `localise-config.js`, Worker CORS allowed origins, and Supabase Auth redirect allowlists configurable per environment; do not bind release behavior to a preview or `workers.dev` host.

```powershell
Set-Location <collector-checkout-root>
# Edit .overnight\localise-website\localise-config.js to set tourismApiBaseUrl to the approved HTTPS Worker origin.
pnpm --dir worker exec wrangler deploy --dry-run --config ..\.overnight\localise-website\wrangler.jsonc --outdir ..\.overnight\localise-website\.wrangler-config\pilot-dry-run
# After explicit deployment approval only:
pnpm --dir worker exec wrangler deploy --config ..\.overnight\localise-website\wrangler.jsonc
```

Cloudflare documents `--dry-run` as compile-only and documents that `secret put` can immediately deploy a new Worker version. Review the [Wrangler deploy and secret commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/) before execution.

## Post-deployment smoke checks

1. Check `/health`, enabled Hyderabad city response, and public pagination at offsets `0` and `100`.
2. Confirm only reviewed/approved places appear, every public source has attribution and license, and source payload/internal review fields are absent.
3. Confirm staging table and import RPC calls fail for `anon` and `authenticated` over HTTP and database grants/RLS.
4. Check the public site on 390 px mobile and desktop widths: search, attraction ranking, categories, markers, attribution, nearby escapes, and unroutable unresolved places.
5. Test login/social only after the approved production Supabase URL, publishable key, provider configuration, redirect URLs, and social storage policies have been verified. Those production auth checks are not part of the local fixture evidence.

## Rollback

1. Revert the static asset deployment to the exact previously recorded site deployment version; disable the tourism feed in the rollback site configuration if the Worker/API is unhealthy.
2. Roll the Worker back to the exact previously recorded Worker version. Rotate/revoke the admin token if exposed or mishandled.
3. Preserve the additive staging tables and snapshot rows for diagnosis. Do not drop tables or delete imported records as rollback.
4. Do not undo approved public-record state automatically. Prepare a reviewed corrective migration if publication state needs correction.
5. Capture deployment IDs, health responses, migration IDs, and final row counts. Retry only after isolated tests and explicit owner approval.

## Current blockers

- No reviewed real tourism records have passed the licensing and human-publication gates; the 5,893 records remain private.
- Production Supabase migration history and auth-provider configuration were not inspected. Cloudflare secret values were not intentionally requested; one anomalous binding name needs owner review as described below.
- Login/social were not verified against a live auth provider; local runtime config is unset.
- The Localise frontend has an existing temporary-site deployment, but no Hyderabad real-record publication has occurred. The browser-approved canonical rows in local verification were isolated test fixtures only.

## Owner intervention required

1. In Cloudflare Dashboard, open Workers & Pages → `india-tourism-collector` → Settings → Variables and Secrets. Review binding names only; do not copy or send any secret values. Confirm the expected names are exactly `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and `ADMIN_TOKEN`. If any binding name contains token-like text or is malformed, treat the associated credential as exposed: rotate the Supabase service-role key, replace the correctly named Cloudflare secret, and verify the malformed binding is unused before removing it. Do not share the new values.
2. Have the authorized production database owner review migration history and schema drift, since this session cannot access live Supabase under repository instructions.
3. Approve ODbL treatment/attribution and select individually reviewed real place records. Current count eligible for public approval is zero; staged rows stay private until this review.
4. Once those gates pass, explicitly approve the exact production migration, snapshot import, Worker version, site commit, and deployment sequence in the release report. No blanket approval is assumed.

## Hyderabad real-data release addendum — 2026-11-26

### Verified cause of the empty places experience

Previously authorized read-only production inspection found `/public/cities` healthy and `/public/places` failing because the production schema lacks fields selected by the Worker (`tourism_city_places.is_current` and `tourism_places.importance_score`). The legacy 108 Hyderabad links were pending, so none passed the approved/active public filter. The separate 47,827-record Session B intake is not present in production. No production database, Worker, or website was changed in this implementation pass.

The local Worker now projects only safe public place/source fields, ranks by `tourism_places.importance_score` before link relevance, and returns generic JSON 502 on database errors. Places can be displayed with map pins while `route_ready=false`; map directions remain gated. A narrow additive compatibility migration was added rather than coupling the public API fix to the broader collection-cycle migration.

### Exact migration proposal for owner review

The following files were applied on a fresh isolated PostgreSQL database and verified there. Production application is not authorized by this report:

1. `supabase/migrations/20261125_offline_pbf_staging.sql` — private snapshot staging and service-role-only importer RPCs; RLS enabled, no publication.
2. `supabase/migrations/20261126_route_readiness.sql` — adds `route_ready=false` and requires approved+active state for any route-ready row.
3. `supabase/migrations/20261127_public_places_api_compat.sql` — adds `tourism_city_places.is_current=true` and `tourism_places.importance_score=0` with a 0–100 constraint. Existing rows remain subject to their pending review state.

The separate `20261124_collection_cycles.sql` is excluded from this narrow website repair. It changes collector semantics and its own header requires a coordinated Worker release before collection resumes. The production owner must first check migration history and take a database backup/restore point, then review the exact migration diff and schema state.

### Data and licensing proposal

The current candidate package is derived from the frozen Session B source snapshot `localise-f8973357b9ba729edf052254379162b6dd6d6399b9037963a971cd28bd57862f`, dated `2026-11-23T21:21:17Z`. It contains 500 unique source identities: 100 importance-ranked attraction candidates, 200 restaurant candidates, and 200 accommodation candidates; categories overlap. Snapshot SHA-256 is `7199012dd8a39f28547b6fcebbee4780543971cf4ab2aebe0e5c838bc06d5380`. The current source-key set exactly matched between package and isolated database (SHA-256 `32022ab99411d712db2d6a3af221404f489c5dc25ba0d8e97035977743fecc04`). These 500 records have been persisted twice idempotently in isolated staging and finalized as 500 review-only / 0 quarantine / 0 itinerary-ready. This is a candidate count, not a public approval count.

**Real records cleared for publication: 0.** The source set uses OpenStreetMap ODbL-1.0 and requires visible `© OpenStreetMap contributors` attribution. Owner/legal review of ODbL use is still required before public distribution. No article text has been copied. Eleven Hyderabad landmark identity/significance notes have individual official-source references; nine more candidates have only list-level references. No historical summary has reuse clearance for publication yet, so the release-ready sourced-summary count is 0. Nearby-escape publication count is 0; Ramoji Film City entrance coordinates remain unresolved.

The 500-candidate import uses the existing authorization-gated private importer in five 100-record batches. Expected first import is 500 inserted; exact replay is 0 inserted / 500 existing; finalization is 500 review-only / 0 quarantine. Importer finalization does not approve or publish. No bridge from private staging to canonical public place rows exists, so an explicit, separately reviewed publication workflow is still needed after owner/editorial decisions. Do not import these candidates directly into public tables or bypass review.

### Verified isolated website behavior

Edge/Playwright loaded the existing website from its isolated checkout and fetched its API through the actual local Worker HTTP adapter, PostgREST 16.6, and PostgreSQL 17.12. A seven-row source-derived disposable fixture rendered five attractions, one restaurant, and one accommodation record with OSM attribution; it was not the release candidate data. Search, category filters, importance order, five map pins, and 390 px / 1440 px layouts passed; every HTTP API response was 200 and neither viewport overflowed. A map-legend blank-link issue was repaired. All fixture places were correctly displayed as map pins only because `route_ready=false`.

Itineraries remain unavailable because verified visit durations, hours, and routing are absent. Current auth provider configuration/client was unavailable in the isolated browser; only login-dialog and social-panel navigation were exercised. Live login and social posting are release blockers, not passed functionality.

### Approval bundle and rollback

Before a release, the owner must approve in one written response: (a) applying exactly the three migration files above after migration-history/backup verification, (b) ODbL treatment and attribution, (c) the individually reviewed per-record publication manifest (currently zero records approved), (d) the exact Worker source/version and required server-side bindings, and (e) updating the existing Localise site's configurable API origin and deploying its reviewed commit. The current candidate snapshot may be imported only into private staging; approval of the importer does not approve public publication.

The reviewed code checkpoints are collector commit `d2c0740` and existing Localise checkout commit `3afacd2`. The site's `localise-config.js` and the collector `worker/wrangler.toml` still contain user-owned uncommitted changes and were excluded from both commits; review those existing changes before any hosted release build. The latest Worker Wrangler dry-run is blocked by sandbox filesystem traversal before bundling. Do not broaden access to the user profile. Use the supported hosted CI runner for the approved release build; no Worker upload or site deployment was performed in this pass.

Keep the previous Worker and website version IDs as rollback targets. If the API health check fails, restore the prior Worker version; if site rendering fails, restore the prior existing `localise` Worker site version or switch its API origin back. Leave additive schema and private staging rows in place for investigation; use reviewed forward fixes rather than deleting data. No deployment or production migration was performed here.

## Automated editorial package — 2026-11-26

Start at [`outputs/session-a-hyderabad-editorial-2026-11-26/README.md`](../outputs/session-a-hyderabad-editorial-2026-11-26/README.md), then review [`Hyderabad_Candidate_Approval.csv`](../outputs/session-a-hyderabad-editorial-2026-11-26/Hyderabad_Candidate_Approval.csv), [`Hyderabad_Historical_Summary_Drafts.csv`](../outputs/session-a-hyderabad-editorial-2026-11-26/Hyderabad_Historical_Summary_Drafts.csv), [`ODbL_and_Reuse_Approval.md`](../outputs/session-a-hyderabad-editorial-2026-11-26/ODbL_and_Reuse_Approval.md), and [`Production_API_Repair_Approval.md`](../outputs/session-a-hyderabad-editorial-2026-11-26/Production_API_Repair_Approval.md).

The 500-row CSV is grouped and sorted: four conditional browse-only attraction proposals; 496 records requiring targeted evidence; zero excluded from that candidate package. Category memberships overlap (100 attraction, 202 food, 200 accommodation). Import/identity verification reconciles all 500 unique source keys with the isolated staged set; package checksum is `7199012dd8a39f28547b6fcebbee4780543971cf4ab2aebe0e5c838bc06d5380`. No CSV owner approval is filled. Four concise historical text drafts are separately identified and not yet licensing/editorially approved. There are no verified customer ratings, review counts, accommodation price tiers, cleared images, itinerary-ready records or navigation-ready records. All source rows remain private until an authorized catalog publication.

Hosted build-only verification passed for exact revisions `d2c0740` and `3afacd2` through draft pull requests. Worker dependency install, tests, typecheck and Wrangler dry-run passed; Worker deploy job was skipped. Website Node tests and asset-exclusion verification passed; website deploy job was skipped. Evidence is retained in [collector PR #2](https://github.com/Muk-R/india-tourism-collector/pull/2) and [website PR #2](https://github.com/Muk-R/localise/pull/2). Both remain draft/unmerged. No production migration or release was performed.

## Current authorized pilot release checkpoint — 2026-11-26

The latest owner message authorizes the four-record browse-only pilot after mandatory checks. This supersedes earlier statements that no owner publication authorization exists; it does not waive backup, schema compatibility, licensing, or validation prerequisites.

### Implemented and isolated-test evidence

Added authenticated Worker routes `/admin/promote-offline-pbf` and `/admin/rollback-offline-pbf-publication`, OpenAPI contracts, and `20261128_offline_pbf_publication.sql`. Promotion selects exact approved OSM source keys from finalized staging and reads names/coordinates/provenance there. It requires source attribution `© OpenStreetMap contributors`, license `ODbL-1.0`, the canonical OSM feature URL and valid coordinates; unknown request fields and route readiness are rejected. Transactions, idempotency conflicts, audit rows and state-checked rollback are implemented. `ADMIN_ACTOR_ID` is supplied to the existing Worker deployment command as the non-secret service identity `localise-pilot-admin`.

On a fresh isolated PostgreSQL 17.12/PostgREST 16.6 database, actual Worker HTTP calls imported five clearly synthetic staging rows, promoted only the four authorized candidate fixture identities, denied anonymous staging/import/promotion access, rejected replay changes and a mixed valid/invalid batch atomically, then rolled back all four. The successful first promotion returned 4; identical replay returned 0 new / 4 existing; rollback returned 4 and repeated rollback was idempotent. Direct database counts at the publication checkpoint were 4 approved browse-only rows, 0 route-ready rows, 4 distinct audit items, and the fifth unapproved record still review-only and absent from canonical public tables. Test data was rolled back; no production records changed.

Full focused Worker tests pass 37/37; TypeScript typecheck and `git diff --check` pass. Existing website API tests pass 8/8; its API adapter retrieved the four isolated records in importance order with attribution, food/stays count 0, and all four non-navigable. Browser rendering for this exact code/data candidate was not verified: Browser Act/Playwright is unavailable, and the installed Edge headless attempt failed to complete in the restricted environment. Do not treat previous browser screenshots as verification of this release.

### Production read-only findings and release hold

The Supabase project reference matches the owner-designated `localise-tourism-pilot`. Read-only metadata showed the production schema has RLS enabled and the public approved-read policies, but lacks the fields required by the current places endpoint (`tourism_places.route_ready`, `importance_score`, and `tourism_city_places.is_current`) as well as the offline staging and publication audit tables. The migration-history list is empty, so verify the current baseline carefully. No production database rows or secrets were read. The available Supabase tools have no backup/snapshot operation; no migration or other production mutation was performed.

The production migration sequence tested locally is `20261124_collection_cycles.sql` → `20261125_offline_pbf_staging.sql` → `20261126_route_readiness.sql` → `20261127_public_places_api_compat.sql` → `20261128_offline_pbf_publication.sql`. Applying this in production remains gated on a current restorable backup and confirming migration-history/baseline compatibility. Then the Worker version must be deployed, the four reviewed staging identities imported and promoted once with an audit approval reference, and the existing website Worker deployed/configured to the same API origin. Smoke-test `/health`, `/public/cities`, `/public/places`, visible OSM attribution, four map labels, unroutable navigation, and mobile/desktop display. Roll back the four-record publication with its idempotency key and rollback reference if catalog checks fail; restore prior Worker and website versions for critical deployment regressions. Preserve additive database/audit rows during rollback.

### Manual logical-backup gate — 2026-11-26

Supabase officially recommends `supabase db dump` for Free Plan logical backups. The documented export separates role-only, schema and data dumps; migration history in `supabase_migrations` requires explicit schema and data dumps. The CLI defaults exclude managed `auth`, `storage` and extension schemas, and do not include data or custom roles unless requested. Supabase Storage object bytes are not part of a database dump and require a separate Storage API export. Custom changes to managed `auth`/`storage` schemas require separate handling. See [Supabase backup and restore](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore) and [database backups](https://supabase.com/docs/guides/platform/backups).

Local tooling inspection found PostgreSQL `pg_dump`, `pg_restore` and `psql` 17.12, matching the project's PostgreSQL 17.12; Supabase CLI and Docker are not available on PATH. The local PostgreSQL process is available for a future isolated restore test. A read-only size query returned 11,990,707 bytes; no row contents were queried. C: has 87.7 GiB free. A dedicated backup directory was created outside Git at `C:\Users\Mukesh Reddy\AppData\Local\Localise\Backups`; its inherited ACL has no broad Users/Everyone read entry.

No logical dump or restoration test was performed: the Supabase connector can query metadata but cannot export a database dump, and no database connection password/URL is available to the local PostgreSQL client. Do not treat the project API/Worker secret as a PostgreSQL password. Next, make an authenticated Postgres connection available to this execution environment through a protected process-scoped mechanism (do not send credentials in chat). Then create timestamped role/schema/data/history exports in the private directory, hash each file, restore to a new isolated database, and verify schema, counts, policies, functions and grants before declaring `BACKUP READY`. Production remains untouched.

The owner subsequently configured process-scoped `PGPASSWORD`. The elevated PostgreSQL client inherited it (presence checked without reading its value) and resolved the project host, but PostgreSQL rejected authentication for role `postgres` with `FATAL: password authentication failed`. The normal sandboxed client is blocked from TCP by the sandbox. No password was exposed, and no dump/restore began. The remaining blocker is a valid database password in the process-scoped variable; ensure it is the project's PostgreSQL password, not a Supabase API secret. Retry the same read-only connection check before exporting.

### Hosted build-only checkpoint

Draft [collector PR #3](https://github.com/Muk-R/india-tourism-collector/pull/3) passed its hosted `verify` job for proposed commit `4bf49a2d4e9e60c5243a267c8d05754b5126b86c`: frozen pnpm install, Worker tests, TypeScript typecheck and Wrangler dry-run all succeeded. The deploy job was skipped. The PR remains unmerged. No production changes have been made because the required restorable backup has not been created or confirmed.

### Backup execution update — 2026-11-26

The owner supplied working process-scoped `PGPASSWORD` and confirmed the Session pooler parameters. TLS authentication succeeded; the read-only query returned `postgres` for user and database on PostgreSQL 17.12. A timestamped database archive and passwordless roles export were written outside Git, ACL checked, listed and independently hashed. Archive: 463,215 bytes, SHA-256 `B69CB2442DE66ECC140EF5B57F3E3E31A9BCD58A4F74D066AAE5584C9E922056`; roles export: 5,900 bytes, SHA-256 `F3909FC5A0ED8E5FDEE352F3AF0551F5F3ACF401247284AE39EA6050177805BA`. The 667-entry TOC includes auth, storage and public schemas, table data, functions and policies. Storage object bytes are separate; migration history schema was not present. Role passwords were excluded.

Full restore verification is blocked. In a fresh isolated loopback PostgreSQL 17.12 cluster, role replay failed on Supabase-managed grantor permissions (`supabase_admin`), and archive restore requires the absent `supabase_vault` extension. The disposable cluster was stopped and retained. No restored counts or complete object checks can be claimed, so the backup is **NOT READY** for the release gate. Required next step is an approved isolated Supabase-compatible restore runtime with these extensions and role semantics; never restore against production.

Read-only live GET checks: Localise `200`, Worker health `200`, cities `200`, valid-city places `500`. The API health and cities routes remain functional; the places error is consistent with previously confirmed schema drift, not a password-related outage. No production records, schema, secrets or deployments were changed.

### Isolated restore runtime assessment — 2026-11-26

The archive and roles export remain byte-for-byte unchanged by checksum. PostgreSQL 17.12 client/server versions match, but this machine has no Supabase CLI, Docker executable, Docker Desktop installation, or WSL distribution; WSL reports it is not installed. The installed PostgreSQL extension directory has no `supabase_vault` control file. Current available RAM is 1.1 GiB, below Supabase's 7 GiB recommendation for its full local stack; C: reports 86.3 GiB free. A standard local PostgreSQL restore is not compatible because the archive expects Supabase extension/platform role behavior. No Docker/WSL installation, Supabase stack start, or additional heavyweight process was attempted.

Supabase's documented Windows local route requires a Docker-compatible container manager. Its experimental no-Docker process runtime is limited to Linux and macOS on Apple silicon. A hosted restore target is a separate option, not provisioned: current official pricing lists Free as 500 MB database / 500 MB RAM and up to two active free projects across owned/admin organizations; actual remaining quota is unknown. Paid compute can add charges. A new project would receive a copy of sensitive database/auth data and needs explicit owner authorization, a verified capacity/cost decision, Supabase extensions/platform roles and configuration, separate Storage-object handling, and documented Vault root-key continuity if encrypted Vault data must remain decryptable. The backup excludes that root key. No data was uploaded.

### PostgreSQL-only container reassessment — 2026-11-26

The archive and roles export remain unchanged (SHA-256 `B69CB2442DE66ECC140EF5B57F3E3E31A9BCD58A4F74D066AAE5584C9E922056` and `F3909FC5A0ED8E5FDEE352F3AF0551F5F3ACF401247284AE39EA6050177805BA`). Current readings: 4.8 GiB available RAM, 87.2 GiB free C:. The official `supabase/postgres:17.12.0.005` image corresponds to PostgreSQL 17.12 and is 318.3 MB compressed for amd64. Supabase's PG17 schema includes `supabase_vault`; its documented database image includes Supabase extensions, managed roles and seed migrations. It is the preferred zero-cost restore candidate over the complete local stack. Image unpacked disk use and runtime memory are not measured. Source confirms role initialization and elevated `supabase_admin`, but exact restore of this roles export against pre-existing managed roles, grantors, extensions, ownership and application permissions remains unverified pending an actual container restore. Do not replay the role file blindly or omit roles silently.

No Docker executable/Desktop or WSL distribution is available, so no runtime was installed or image pulled. A temporary Free hosted project could fit the measured 11.99 MB DB within its 500 MB database limit and has 500 MB RAM, but copying auth/production data to it is not authorized; free-project quota is unknown, and paid compute may incur charges. The production database backup remains NOT READY until the full isolated restore and schema/data/function/index/constraint/RLS/grant verification passes. No production changes, remote upload, deployment or deletion occurred.

Vault recovery note: metadata-only TOC inspection found one Vault table-data entry; no private values were inspected. The encrypted database archive does not include Supabase's project encryption root key. A successful restore of the rows is not proof of decryptability; to verify Vault content recovery, owner-authorized secure root-key continuity is required under Supabase's documented process. No root key was accessed or transferred.

### Safe restart handoff — 2026-11-26

No long-running process is active. No Docker image was pulled and no service was installed. Resume on branch `dev/session-a-hyderabad`; pre-handoff HEAD was `44f94c8e94fc8b8f5a75b4bb9d5318f50fbbac1b`. The backup/progress checkpoint is being saved as a local commit. Preserve separate existing worktree changes `worker/wrangler.toml` (modified) and `outputs/` (untracked); they are excluded from the checkpoint commit and were not inspected or altered. Backup artifacts remain private outside Git under `C:\Users\Mukesh Reddy\AppData\Local\Localise\Backups\localise-tourism-pilot-20261126T081719Z`; verified hashes are in this document above and in the sanitized manifest. Do not move, overwrite, stage or delete them.

After Windows restart, resume from this worktree, run `git status --short --branch` and `git log -1 --oneline`, then verify the Docker-compatible runtime with `docker info`, available memory/disk, and both backup hashes. Use only a loopback-isolated PostgreSQL-only Supabase image pinned to `supabase/postgres:17.12.0.005`; do not start the full Supabase stack. Verify seeded roles and reconcile the roles export explicitly before restore. The restore remains incomplete until schema/data/object/RLS/grant checks pass. The archive contains a Vault table-data entry; full decryptability verification needs owner-authorized secure root-key continuity. Do not copy production data to hosted infrastructure without separate approval. No production migrations, deployments, publications, or changes occurred. A Codex conversation/session ID was not exposed by the available tools.

### Verified continuation — 2026-11-26

Website-only release (owner-authorized): PR #2's reviewed source commit `3afacd2c6af927c6656797cd1d5269187c885c11` was merged to `dev/session-a-hyderabad` as `64a1c803966dc2ce212add11335795671b5ffc7b`. GitHub Actions run `45812537582` completed successfully: focused Node tests, static asset exclusions, deployment of the existing Worker `localise`, and post-deployment website/API health checks passed. Cloudflare confirms deployment `99f1dddf-6e7f-4efd-8367-d91a1cb40f00`, active version `2d6fc1d7-b01a-4323-bb9f-2fd57ac16d5f` at 100%. Temporary site: `https://localise.promoacc123123.workers.dev/`. The schema asset exclusion is covered by CI and its health check. Direct HTTP verification from this local sandbox was blocked by network policy; hosted post-deploy health checks are the successful live evidence. No database migration or record publication was run.

Database logical backup restore (isolated only): original `.pgdump` and roles export remain unchanged at the private backup location. Verified sizes/SHA-256: archive 463,215 bytes, `B69CB2442DE66ECC140EF5B57F3E3E31A9BCD58A4F74D066AAE5584C9E922056`; roles export 5,900 bytes, `F3909FC5A0ED8E5FDEE352F3AF0551F5F3ACF401247284AE39EA6050177805BA`. A PostgreSQL 17.12 Supabase-only container, capped at 2 GiB/2 CPUs, with no network and no published ports, restored the archive. The missing `supabase_realtime_admin` role was reconciled only in that local cluster with no login, superuser, create-db, create-role, or RLS-bypass privileges. The deferred `ensure_rls` event trigger was restored as its source owner `postgres`, then that role's superuser attribute was returned to NOSUPERUSER.

Restore checks: 10 non-system schemas, 50 user tables, 30 roles, five extensions (including `supabase_vault`), 751 rows across nine populated tables, 46 archive table-data entries, 264 rows across Auth/Storage/Realtime migration histories, 32 RLS-enabled tables and three policies. Invalid indexes: 0. Anonymous staging/import/quarantine table grants: 0. The only unvalidated constraint is the source `realtime.messages.messages_payload_exclusive` CHECK, explicitly `NOT VALID`; the restored table has zero rows violating its predicate. `pg_amcheck` could not run because this image does not provide the `amcheck` extension; catalog, index-validity, constraint and predicate checks passed. Restored Auth users, `vault.secrets` rows and `storage.objects` rows are all zero. Storage object bytes and Supabase project-level configuration are outside a PostgreSQL logical dump; there were no referenced Storage objects in this database to restore. Supabase's Vault root key is not in the dump; no Vault rows exist in this snapshot, so current database restore does not require Vault decryption. Keep a separate secure procedure for any future Vault data and external Storage files.

The project metadata in this checkpoint does not represent a production database migration or publication. Session B's multi-city contract remains deferred; the existing schema keeps city identity in `tourism_cities`/`city_id` and uses per-city collection-cycle links. Future integration should retain source identity `(source, source_id)` separately from canonical place identity and preserve per-city membership, without changing Session B's worktree.

### Live content publication readiness — 2026-11-26

The website-only release is live, but Hyderabad content remains empty. The restored production-schema copy has 108 Hyderabad links, all `pending`, zero approved/active places, and no offline staging tables. The public places Worker requires `tourism_city_places.is_current` and `tourism_places.importance_score`; both were absent from the restored baseline. The four-migration additive chain (staging, route readiness, API compatibility, audited publication) passed against a separate isolated clone. Its API-compatibility fields were present after migration; anonymous staging reads and anonymous promotion execution were denied; no rows were published in that clone.

The existing approval package screens 500 unique source identities: 100 attraction memberships, 202 food memberships and 200 accommodation memberships (overlap retained). It proposes four browse-only attractions; 496 need further review. Mechanical screening found valid names, coordinates, source links, licensing metadata and provenance for the 500; this does not clear business operation, food/dietary claims, accommodation price tiers, route points or itinerary facts. Must-Try food verified: 0. Budget/mid-range/premium stays confirmed: 0/0/0. Four historical-summary drafts exist and none is cleared. Nearby escapes: 36 candidates and zero individually approved; Ramoji entrance remains unresolved. Images, customer ratings, navigation and itinerary-ready records: 0.

Publication remains blocked by two release inputs: the original 500-row importable JSONL matching `sha256:7199012dd8a39f28547b6fcebbee4780543971cf4ab2aebe0e5c838bc06d5380` is absent from this assigned worktree (the CSV is not a safe substitute for original tags/geometry), and the owner/legal decision on ODbL public-database reuse/share-alike terms is not recorded. No new collection was started. The consolidated counts, four conditional landmark decisions, exact migration order and remaining approval items are in [`Hyderabad_Live_Publication_Readiness.md`](../outputs/session-a-hyderabad-editorial-2026-11-26/Hyderabad_Live_Publication_Readiness.md). No production migration, import, promotion or deployment occurred during this review.

## Session A authorized pilot progress — 2026-11-26

### Owner licensing decision

The owner approved OpenStreetMap data under ODbL 1.0, including applicable database share-alike obligations and visible `© OpenStreetMap contributors` attribution linked to `https://www.openstreetmap.org/copyright`. The public Worker API exposes only approved, active, current records and their source URL, attribution, and license, using paginated JSON; this is the machine-readable public catalog. The Localise website now has a tested footer disclosure/link change on its separate frontend branch, pending release integration. OSM staging remains private. Independently sourced text, images, application code, user information, and social content are separate; no Wikipedia article text or images were added to the OSM dataset.

The decision applies to future city intake. Session B's repository/PR channel could not be identified, so the decision and the verified source-provenance contract are recorded here pending a direct coordination channel. No Session B worktree was changed. A tested footer disclosure was committed to `dev/frontend` by the website specialist, but that branch is on `Muk-R/india-tourism-collector`, not the actual `Muk-R/localise` target; it has not been merged or deployed and must be ported to the real website repository before its release.

### Production database release evidence

- Candidate source artifact `records.jsonl`: 500 lines, 500 unique source identities; SHA-256 `7199012dd8a39f28547b6fcebbee4780543971cf4ab2aebe0e5c838bc06d5380`. No new extraction was run.
- Production migration history was reconciled before writes. The four approved migrations were present. Production compatibility checks found the earlier attribution literal was double-encoded in the deployed RPC/constraints, despite the reviewed source and dataset using the correct U+00A9 character. The resulting first batch attempt failed atomically with zero rows inserted.
- Added and tested `20261126143000_offline_pbf_attribution_encoding_repair.sql`; it normalizes only malformed OSM attribution values, fixes staging constraints, and repairs the importer/promotion function literals. Applied successfully after isolated regression against a clone containing 500 staging rows and 84 OSM source rows.
- Added and isolated-tested `20261126150000_offline_pbf_wikidata_reconciliation.sql`. It extends publication audit state so an exact pending Wikidata canonical match can receive its verified OSM source identity without creating a duplicate, and rollback restores prior fields and links. It also qualifies `pgcrypto.digest` in the restricted function search path. Regression verified 4 publications, 4-record idempotent replay, browse-only/attributed records, and rollback restoring both original pending Wikidata records and the inserted rows' inactive state.
- Both new additive migrations were applied to production only after the isolated tests passed. Anonymous and authenticated roles remain unable to read staging or execute publication RPCs.
- The five existing production intake batches imported all 500 records; finalization returned 500 total, 500 review-only, 0 quarantined. Production SQL reconciliation confirmed 500 distinct source keys, 500 correct ODbL attribution/license pairs, and 0 itinerary-ready rows.
- The authorized Phase 1 publication RPC returned `published_count=4`, `existing_count=0`, `idempotent_replay=false`. It published Charminar (`way/238186115`), Golconda Fort (`relation/9128913`), Chowmahalla Palace (`way/116031164`), and Salar Jung Museum (`way/238284090`). Charminar and Golconda are attached to their exact pending Wikidata canonicals; the source identities remain separate in `tourism_place_sources`. The two existing Wikipedia-derived descriptions were cleared from the public representation; no historical summary was supplied. All four rows have `route_ready=false` and are not itinerary-ready.
- Database publication is verified; public HTTP/API and live website visibility are **pending** Worker/site release and smoke checks. Until those pass, publicly visible record counts remain unknown (not assumed to be four).

### Immediate remaining work

1. Deploy the compatible tourism Worker version through the `hyderabad-pilot` GitHub Actions workflow and verify `/public/places` returns the four reviewed rows with source attribution and no Wikipedia text.
2. Integrate the tested OSM copyright/ODbL footer commit from the isolated `Muk-R/localise` frontend branch and deploy to the existing Localise URL only after the release checks pass.
3. Perform live mobile and desktop smoke checks for the four attractions, map pins, search, and route-disabled state.
4. Continue evidence review for the remaining 496 candidates in category-focused batches. No food, accommodation, or escape records have been approved or published from this 500-row candidate package. Keep Ramoji Film City unroutable pending entrance verification.

### Rollback

The production database backup and isolated restore verification are documented earlier in this checkpoint. The four-record publication can be reversed by its audited idempotency key through `rollback_offline_pbf_publication`; the RPC preserves records and source/audit rows, retires city links, and restores the prior fields of the two reused canonical rows. Worker/site rollback remains to use the previous recorded Cloudflare versions; do not reverse the additive migrations or delete staging/audit data as a routine rollback.

### Authorized Hyderabad pilot release and continued review — 2026-11-26

Production compatibility and publication evidence:
- Recovered the existing 500-row records.jsonl unchanged; SHA-256 is 7199012dd8a39f28547b6fcebbee4780543971cf4ab2aebe0e5c838bc06d5380.
- Reconciled production migration history before applying the two tested additive fixes. Five existing import batches persisted all 500 unique candidates: 500 staged, 500 with unique OSM keys, 500 initially review-only, 0 quarantined, 0 itinerary-ready.
- Promoted only Charminar, Golconda Fort, Chowmahalla Palace, and Salar Jung Museum after exact-identity reconciliation. Public catalog count is 4; the remaining 496 source candidates remain protected from publication.
- Applied release commit 5bb16e5449fc7c853456279895f01f93897a1350 through Localise PR #3. GitHub Actions run 45836686829 completed successfully. Cloudflare Localise deployment 9e64d26a-5006-41b5-8610-c254cd86299c, version 3bff492a-0c4e-41b5-b135-0476f8fae9b6, is active at 100%.
- Read-only live checks: website root HTTP 200; public API HTTP 200 with 4 approved records and ODbL-attributed OSM source identities; site API configuration HTTP 200 and points to the temporary Hyderabad Worker; visible ODbL notice/link is present; /supabase-schema.sql returns HTTP 404.
- Records have no copied Wikipedia descriptions. The API omits route_ready; website routing requires route_ready === true, so all four stay browse-only and unroutable. No Worker version promotion was needed for basic browse API compatibility; active tourism Worker version remains 833816b9-eef3-4191-91a8-f56f212306e5.
- Browser-rendered mobile/desktop verification was not available in this session: BrowserAct, uv, Playwright, and a local browser executable were not installed. HTTP and deployment verification is complete; do not claim a rendered browser test.

Remaining candidate review:
- A new, owner-approval-blank five-attraction batch is at outputs/session-a-hyderabad-editorial-2026-11-26/Hyderabad_Attraction_Batch_02.csv. Four browse-only proposals are Hussain Sagar, B. M. Birla Science Museum, Chilkur Balaji Temple, and NTR Gardens; Falaknuma Palace remains additional-review because public visitor access is not confirmed. Historical descriptions are independent drafts with primary-source URLs; no descriptions, images, hours, fees, ratings, or visit durations were published.
- Food review: 202 candidate memberships (including 2 cross-category overlaps); 0 evidenced Must-Try classifications, 87 with cuisine tags, none with verified dietary claims. Everyday Dining remains candidate-only.
- Accommodation review: 200 candidates, all price tiers unconfirmed; 0 verified customer ratings/review counts. Geographic area is missing for 196/200 stays and 189/202 food candidates. Do not present OSM importance signals as popularity or customer ratings.
- No additional extraction ran. The 5,893-row local dataset and the 500-row release source are separate; only the 500 candidate package was imported into production staging. Session B was not modified.

Next: continue batch review from the existing candidate package; obtain consolidated approval before publishing any additional records. A rendered mobile/desktop test still needs an available browser runtime. Ramoji Film City remains unroutable pending entrance verification.

Attribution byte check: a read-only fetch parsed from raw UTF-8 returned all four ODbL sources with the expected attribution string beginning U+00A9 (code point 169); the earlier mojibake was PowerShell legacy decoding, not stored/API data corruption.

### Hyderabad attraction-detail deployment — 2026-11-26

- Added reusable attraction detail panels across approved attraction cards and map markers. The panel supports responsive sheet/dialog sizing, image-gallery snapping, attribution, safe source URLs, Asia/Kolkata weekly timing evaluation, dismissal gestures, and strict route/itinerary readiness gates. Unknown images, history, hours, fees, last entry, and durations remain explicitly unavailable.
- Website commit `6790598b30534fd0d632c8efcc414a4709afcab9` was reconciled with current Localise `main` and released as squash commit `d6835ed742450e60053c898d678d04e9fcdd94b7` through PR #4. Deployment run `45851340585` succeeded. Cloudflare reports deployment `842d6c3f-e54d-4d81-af9a-525395ea3aad`, active version `486f06b7-8362-4370-ac13-5b1b0b38d3f8` at 100%.
- Local validation: website tests 14/14 passed. Existing Microsoft Edge and Playwright ran isolated loopback checks at 390×844 and 1440×900; detail opening/closing, swipe and pagination behavior, labeled map markers, search, route gating, login dialog, social-tab navigation and responsive sizing passed. Data in this browser test was an isolated fixture, not a live database response. Live browser access from this sandbox returned `ERR_NETWORK_ACCESS_DENIED`; the deployment workflow has no browser smoke step, so live rendered behavior remains unverified.
- Worker route contract fix commit `0b34a1bad9ed2f0194934ee36bfc43499f6c070c` ensures `route_ready` is always an explicit boolean and strips raw source payloads. Hosted verify passed: 38 Worker tests, typecheck and Wrangler dry-run. Deployment job `45848803405` failed before upload because the GitHub Actions environment `hyderabad-pilot` has no `CLOUDFLARE_API_TOKEN`. Cloudflare confirms Worker `india-tourism-collector` remains on version `833816b9-eef3-4191-91a8-f56f212306e5` at 100%. No rollback was needed because no Worker version was uploaded.
- Public counts remain based on the previously successful live API/site check: 4 attractions, 0 restaurants, 0 stays, 0 nearby escapes. Among the 4 attractions, published historical summaries: 0; licensed images: 0; verified visitor timings: 0; route-ready/itinerary-ready: 0. The public catalog is unchanged by the website-only deployment.
- Dataset counts: 5,893 unique collected source entities (2,031 attraction, 2,133 food, 724 accommodation, 1,010 transport category memberships; five cross-category overlaps), of which 4,153 named records are review-only and 1,740 nameless records are quarantined. The separate 500-row candidate package has 500 unique staged records (100 attraction, 202 food, 200 accommodation memberships, with two cross-category overlaps), 500 review-only and 0 quarantine; only the four previously approved attractions have been promoted. The other 496 remain private because identity/editorial review is incomplete. No collection was repeated.
- Browser-tested functionality covers the modal and frontend flow only. Actual sign-in/OTP completion, social posting, licensed production gallery content, food/stay browsing with records, realistic itinerary scheduling, and a fresh live response check after this website deployment remain unverified or unavailable. No restaurant, accommodation, escape or new summary was published in this release.

Owner action to unblock Worker deployment: in GitHub repository `Muk-R/india-tourism-collector`, open **Settings → Environments → hyderabad-pilot**, add the existing Cloudflare Workers Scripts Edit token as the `CLOUDFLARE_API_TOKEN` environment secret, then rerun failed job `Deploy tourism Worker` from Actions run `45848803405`. Do not paste the token into chat, the repository, or a workflow log.
## Latest pilot publication and card update — 2026-11-26

- Production schema now includes the tested heritage detail fields from migration `20261126164621_heritage_card_content_20261126`; verified fee encoding correction was applied in additive migration `heritage_fee_encoding_20261126`. Both changes were checked against the current production schema; the first only adds constrained columns and enriches the four previously approved source identities, the second only rewrites two already verified fee strings to ASCII `INR` notation.
- The finalised original candidate snapshot `sha256:7199012dd8a39f28547b6fcebbee4780543971cf4ab2aebe0e5c838bc06d5380` remains 500 rows, 500 unique identities. Publication used the service-role-only audited RPC, not direct canonical-table inserts. New published browse-only records: 81 attractions, 200 Everyday Dining candidates, and 200 accommodation candidates. Four earlier approved landmarks remain public; total **485**: 85 attractions, 200 food, 200 stays. The two food/accommodation overlapping OSM features were represented once as accommodation. No nearby escapes were included.
- Nineteen attraction candidates did not pass identity-collision checks and remain unpromoted for source reconciliation. No source record was renamed, merged or editorially scored. The 81 new attractions have importance score 0 (unranked); accommodation price tiers, guest ratings, food cuisines/diet labels and current operating status remain unconfirmed where source evidence was unavailable. All newly published records are browse-only, have ODbL attribution and source links, and retain `route_ready=false`.
- Four landmarks (Charminar, Golconda Fort, Chowmahalla Palace, Salar Jung Museum) each have three independent, cited historical facts, licensed CC BY-SA 4.0 Commons image metadata and source-backed visiting information. Only Chowmahalla Palace has a source-verified recommended duration (120 minutes). Fee labels display `INR` to avoid encoding corruption. Charminar's split-area schedule and Salar Jung's notified-holiday exceptions suppress `Open Now` status. Public API filters details to validated HTTPS source links and does not expose raw source payloads.
- Worker deploy run `45848803405`: verification and deploy succeeded; the prior worker revision is active as version `0e9f9dd9-e65a-436b-9337-5989720d9bc8` (deployment `a5dfa221-fbae-415d-b539-393a8e2db529`). This deployed version predates the newest heritage-field projection; the updated Worker source still needs its own hosted deploy.
- Focused checks on current source: Worker 38/38 and typecheck passed; Localise Node tests 15/15 passed. The frontend working tree now limits homepage Must-see cards to editorially ranked places while search and map include the browse-only attractions as unranked. These frontend and Worker edits have not yet been committed or deployed. Live API and browser verification of the new version remain pending.
- Safety gate remains: zero records are navigation-ready or itinerary-ready. Do not infer or publish entrance coordinates, fabricated hours, durations, ratings, hotel tiers, dietary claims, or historic prose for the other records. The old static itinerary view still shows no verified itinerary when the tourism API is configured.
