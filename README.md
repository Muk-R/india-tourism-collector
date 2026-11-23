# India Tourism Collector

Cloudflare Worker + Supabase ingestion backend for discovering tourist places around Indian cities using OpenStreetMap, Wikidata, and Wikipedia.

## Pilot behavior

- Collection is manual. No cron trigger is enabled.
- Discovery stores up to 100 OSM and 100 Wikidata candidates per city in `tourism_collection_items`.
- Each Worker request claims and processes at most five queue items.
- Items have retry state and are claimed atomically. A Worker interrupted for more than ten minutes can have its items reclaimed.
- Repeated discovery is idempotent for a city/source/source ID. Existing place, source, and city-link upserts also prevent duplicate records.
- New places stay `pending` until an administrator approves them.
- Candidate image URLs are kept inside admin-only Wikipedia source metadata. `tourism_places.image_url` remains empty until a person verifies and approves the image licence.
- The relevance score reflects source completeness; it is not a review score or rating.

## Contents

- `supabase/schema.sql`: application tables, RLS, deduplication RPCs, queue table, and atomic queue claim RPC.
- `worker/src/index.ts`: discovery, bounded queue processing, review endpoints, public read endpoints.
- `worker/wrangler.toml`: Worker configuration. Add a real contact email to `USER_AGENT` before deployment.
- `scripts/seed_cities.py`: imports GeoNames cities or a curated CSV. It reads `SUPABASE_URL` and `SUPABASE_SECRET_KEY` from the environment.
- `scripts/run_batch.py`: sequentially calls the Worker in small batches.

## 1. Prepare Supabase

Use a separate staging Supabase project for the pilot. Run `supabase/schema.sql` in **SQL Editor → New query**. It is safe to rerun: the queue table, discovered timestamp, and claim function use idempotent DDL.

The Worker supports modern Supabase secret API keys (`sb_secret_...`) through the `apikey` header. A legacy `service_role` JWT also works and is sent as a Bearer token for compatibility. Keep either key only in server-side secrets.

## 2. Install and configure the Worker

From `worker/`:

```powershell
pnpm install
pnpm run typecheck
```

Edit `wrangler.toml` and replace the `USER_AGENT` marker with a real project contact address, for example `LocaliseTourismCollector/1.0 (mailto:you@example.com)`.

Authenticate Wrangler separately from the `cf` CLI, then upload the secrets when prompted:

```powershell
pnpm exec wrangler login
pnpm exec wrangler secret put SUPABASE_URL
pnpm exec wrangler secret put SUPABASE_SECRET_KEY
pnpm exec wrangler secret put ADMIN_TOKEN
pnpm exec wrangler deploy
```

Generate a random admin token and keep it private. Do not put it in the website or commit it. The provided `.dev.vars.example` is a template; copy it to `.dev.vars` only for local development and keep that file out of source control.

## 3. Add pilot cities

For a five-city pilot, add only Hyderabad, Mumbai, Delhi, Jaipur, and Varanasi to the staging database. You can insert them from SQL Editor or use a curated CSV with `scripts/seed_cities.py`. The GeoNames default is population based, not a tourism ranking. Review city centres and radii before collection.

## 4. Collect a city in resumable chunks

Check the city UUIDs:

```sql
select id, name, collection_status, collection_discovered_at
from public.tourism_cities
where is_enabled = true
order by name;
```

Call the Worker repeatedly for one city. The first call discovers candidates and processes at most five. Later calls continue with the next available queue items:

```powershell
$WorkerUrl = "https://YOUR-WORKER.workers.dev"
$AdminToken = "YOUR_ADMIN_TOKEN"
$CityId = "CITY_UUID"
Invoke-RestMethod -Method Post `
  -Uri "$WorkerUrl/admin/collect-city/$CityId?radiusKm=30" `
  -Headers @{ Authorization = "Bearer $AdminToken" }
```

The response includes `processed`, `remaining`, queue counts, and item errors. Call again while `remaining` is greater than zero. Failed items retry after a delay, up to three attempts. A stuck `processing` claim can be reclaimed after ten minutes.

To rediscover a city from current source data, call the same endpoint with `&rediscover=true`. This removes that city's queue rows and creates a new discovery cycle; canonical places remain protected by the existing upserts.

For a sequential run across enabled pending/processing cities, use `scripts/run_batch.py`. The `--cities-per-call` option is retained for compatibility; each request processes one five-item batch.

## 5. Review and approve places

List pending places and their source records:

```powershell
Invoke-RestMethod -Uri "$WorkerUrl/admin/review?city_id=$CityId&status=pending&limit=50" `
  -Headers @{ Authorization = "Bearer $AdminToken" }
```

After checking the name, category, coordinates, description, and source links, approve or reject a place:

```powershell
Invoke-RestMethod -Method Post `
  -Uri "$WorkerUrl/admin/review/PLACE_UUID" `
  -Headers @{ Authorization = "Bearer $AdminToken"; "Content-Type" = "application/json" } `
  -Body '{"review_status":"approved"}'
```

Use `"rejected"` to reject it. The admin token must remain out of browser code. Candidate image URLs appear only in admin source metadata; verify image author and licence before copying them into the public `image_url`, `image_author`, and `image_license` fields.

## Endpoints

- `GET /health`
- `GET /public/cities`
- `GET /public/places?city_id=CITY_UUID&limit=100` (approved places only)
- `GET /admin/stats` (Bearer `ADMIN_TOKEN`)
- `GET /admin/review?city_id=CITY_UUID&status=pending&limit=50` (Bearer `ADMIN_TOKEN`)
- `POST /admin/review/PLACE_UUID` with `{"review_status":"approved"|"rejected"}` (Bearer `ADMIN_TOKEN`)
- `POST /admin/collect-city/CITY_UUID?radiusKm=30` (Bearer `ADMIN_TOKEN`)
- `POST /admin/collect-city/CITY_UUID?radiusKm=30&rediscover=true` (start a fresh discovery cycle)
- `POST /admin/collect?radiusKm=30` (one five-item batch from the next pending/processing city)

## Attribution and limits

- OpenStreetMap: credit “© OpenStreetMap contributors” and comply with ODbL.
- Wikidata: CC0.
- Wikipedia text: CC BY-SA; attribute the article/contributors and follow share-alike requirements.
- Wikipedia image files have individual licences. The Worker stores an image candidate for administrators but does not verify its licence or author.
- GeoNames city seed: CC BY 4.0; attribute GeoNames.
- Overpass and Wikidata are shared services. Run the pilot sequentially and respect their service limits.

This package is not deployed or connected to any Cloudflare or Supabase account. The collector remains separate from the Localise website until its public API data has been reviewed.
