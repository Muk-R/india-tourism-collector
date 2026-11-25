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
- No public deployment has occurred. The only browser-approved rows were local synthetic fixtures.

## Owner intervention required

1. In Cloudflare Dashboard, open Workers & Pages → `india-tourism-collector` → Settings → Variables and Secrets. Review binding names only; do not copy or send any secret values. Confirm the expected names are exactly `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and `ADMIN_TOKEN`. If any binding name contains token-like text or is malformed, treat the associated credential as exposed: rotate the Supabase service-role key, replace the correctly named Cloudflare secret, and verify the malformed binding is unused before removing it. Do not share the new values.
2. Have the authorized production database owner review migration history and schema drift, since this session cannot access live Supabase under repository instructions.
3. Approve ODbL treatment/attribution and select individually reviewed real place records. Current count eligible for public approval is zero; staged rows stay private until this review.
4. Once those gates pass, explicitly approve the exact production migration, snapshot import, Worker version, site commit, and deployment sequence in the release report. No blanket approval is assumed.
