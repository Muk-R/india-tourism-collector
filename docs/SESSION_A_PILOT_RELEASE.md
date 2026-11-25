# Session A Hyderabad pilot release preparation

Status: **not deployed**. The local Worker/PostgREST/PostgreSQL/site integration is verified. Production configuration and credentials were not inspected or changed. Public release is gated on data licensing and human review.

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
