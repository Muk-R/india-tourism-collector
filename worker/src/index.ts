interface Env {
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  ADMIN_TOKEN: string;
  DEFAULT_RADIUS_KM: string;
  OVERPASS_URL: string;
  WIKIDATA_SPARQL_URL: string;
  USER_AGENT: string;
}

interface City {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radius_km: number;
  collection_status: string;
  collection_discovered_at: string | null;
  collection_discovery_error: string | null;
}

interface QueueItem {
  id: string;
  city_id: string;
  source_name: "openstreetmap" | "wikidata";
  source_id: string;
  raw_payload: any;
  status: "pending" | "processing" | "completed" | "failed";
  attempts: number;
  available_at: string;
  claimed_at: string | null;
  last_error: string | null;
}

type Place = Record<string, any> & {
  canonical_name: string;
  latitude: number;
  longitude: number;
};

interface WikiInfo {
  title: string;
  pageId: number;
  url: string;
  extract: string;
  imageCandidate: string | null;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization,content-type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};
const MAX_ITEMS_PER_INVOCATION = 5;
const MAX_DISCOVERY_ITEMS_PER_SOURCE = 100;
const MAX_ATTEMPTS = 3;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
const encode = (value: string) => encodeURIComponent(value);
const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const str = (value: any) => (typeof value === "string" ? value.trim() : "");

async function db(env: Env, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("apikey", env.SUPABASE_SECRET_KEY);
  headers.set("Content-Type", "application/json");

  // New Supabase secret API keys are not JWTs; send them as apikey only.
  // Legacy service_role keys still need the Bearer header to select that role.
  if (!env.SUPABASE_SECRET_KEY.startsWith("sb_secret_")) {
    headers.set("Authorization", `Bearer ${env.SUPABASE_SECRET_KEY}`);
  }
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers,
  });
  if (!response.ok) {
    throw new Error(`Supabase ${response.status}: ${(await response.text()).slice(0, 400)}`);
  }
  if (response.status === 204) return null;
  const body = await response.text();
  return body ? JSON.parse(body) : null;
}

function score(place: Place) {
  return (
    (place.wikidata_id ? 30 : 0) +
    (place.wikipedia_url ? 25 : 0) +
    (place.description ? 20 : 0) +
    (place.image_url ? 10 : 0) +
    (place.website_url ? 5 : 0) +
    (place.osm_id ? 10 : 0)
  );
}

function category(tags: any) {
  return (
    tags.historic ||
    tags.tourism ||
    (tags.amenity === "place_of_worship" ? "religious_site" : tags.leisure || tags.natural || "attraction")
  );
}

function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const radians = (value: number) => (value * Math.PI) / 180;
  const deltaLat = radians(lat2 - lat1);
  const deltaLon = radians(lon2 - lon1);
  const halfChord =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(deltaLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(halfChord));
}

async function savePlace(
  env: Env,
  city: City,
  place: Place,
  source: QueueItem["source_name"],
  sourceId: string,
  sourceUrl: string,
  sourcePayload: unknown,
  wiki: WikiInfo | null,
) {
  place.quality_score = score(place);
  const result = await db(env, "rpc/upsert_tourism_place", {
    method: "POST",
    body: JSON.stringify({ p: place }),
  });
  const placeId = result as string;
  const attribution = source === "openstreetmap" ? "© OpenStreetMap contributors" : "Wikidata contributors";
  const license = source === "openstreetmap" ? "ODbL" : "CC0";

  await db(env, "tourism_place_sources?on_conflict=source_name,source_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([
      {
        place_id: placeId,
        source_name: source,
        source_id: sourceId,
        source_url: sourceUrl,
        attribution,
        license,
        payload: sourcePayload,
      },
    ]),
  });

  // Keep the candidate image URL in the admin-only source record. The public
  // tourism_places.image_url stays empty until a human verifies its licence.
  if (wiki) {
    await db(env, "tourism_place_sources?on_conflict=source_name,source_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([
        {
          place_id: placeId,
          source_name: "wikipedia",
          source_id: wiki.url,
          source_url: wiki.url,
          attribution: "Wikipedia contributors",
          license: "CC BY-SA",
          payload: {
            page_id: wiki.pageId,
            candidate_image_url: wiki.imageCandidate,
          },
        },
      ]),
    });
  }

  await db(env, "tourism_city_places?on_conflict=city_id,place_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([
      {
        city_id: city.id,
        place_id: placeId,
        distance_km: distanceKm(city.latitude, city.longitude, place.latitude, place.longitude),
        relevance_score: place.quality_score,
      },
    ]),
  });
}

function wikipediaTarget(value: string): { language: string; title: string } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const separator = trimmed.indexOf(":");
  if (separator < 0) return { language: "en", title: trimmed };
  const language = trimmed.slice(0, separator).toLowerCase();
  if (!/^[a-z0-9-]{1,16}$/.test(language)) return null;
  return { language, title: trimmed.slice(separator + 1) };
}

async function getWiki(title: string, env: Env, language = "en"): Promise<WikiInfo | null> {
  if (!title) return null;
  const hostLanguage = /^[a-z0-9-]{1,16}$/.test(language) ? language : "en";
  const host = `${hostLanguage}.wikipedia.org`;
  const apiUrl = `https://${host}/w/api.php?action=query&prop=extracts|pageimages|info&inprop=url&exintro=1&explaintext=1&piprop=thumbnail&pithumbsize=900&redirects=1&format=json&titles=${encode(title)}`;
  const response = await fetch(apiUrl, { headers: { "user-agent": env.USER_AGENT } });
  if (!response.ok) return null;
  const data: any = await response.json();
  const page: any = Object.values(data.query?.pages || {})[0];
  if (!page || page.missing !== undefined) return null;
  return {
    title: str(page.title) || title,
    pageId: Number(page.pageid) || 0,
    url: str(page.fullurl),
    extract: str(page.extract).slice(0, 4000),
    imageCandidate: str(page.thumbnail?.source) || null,
  };
}

async function discoverCity(env: Env, city: City, radiusKm: number) {
  const candidates: Array<{
    city_id: string;
    source_name: QueueItem["source_name"];
    source_id: string;
    raw_payload: unknown;
  }> = [];
  const errors: string[] = [];
  let osmCount = 0;
  let wikidataCount = 0;

  try {
    const query = `[out:json][timeout:60];(nwr(around:${radiusKm * 1000},${city.latitude},${city.longitude})["tourism"~"attraction|museum|gallery|viewpoint|theme_park|zoo|aquarium|artwork|information"];nwr(around:${radiusKm * 1000},${city.latitude},${city.longitude})["historic"];nwr(around:${radiusKm * 1000},${city.latitude},${city.longitude})["amenity"="place_of_worship"];nwr(around:${radiusKm * 1000},${city.latitude},${city.longitude})["leisure"~"park|garden"];nwr(around:${radiusKm * 1000},${city.latitude},${city.longitude})["natural"~"waterfall|beach|cave|peak|hot_spring"];);out center tags ${MAX_DISCOVERY_ITEMS_PER_SOURCE};`;
    const response = await fetch(env.OVERPASS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": env.USER_AGENT,
      },
      body: `data=${encode(query)}`,
    });
    if (!response.ok) throw new Error(`Overpass HTTP ${response.status}`);
    const elements: any[] = ((await response.json()) as any).elements || [];
    for (const element of elements.slice(0, MAX_DISCOVERY_ITEMS_PER_SOURCE)) {
      const tags = element.tags || {};
      const latitude = element.lat ?? element.center?.lat;
      const longitude = element.lon ?? element.center?.lon;
      const name = str(tags.name || tags["name:en"] || tags["name:hi"]);
      if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
      candidates.push({
        city_id: city.id,
        source_name: "openstreetmap",
        source_id: `${element.type}/${element.id}`,
        raw_payload: element,
      });
      osmCount++;
    }
  } catch (error: any) {
    errors.push(`OSM: ${error?.message || String(error)}`);
  }

  try {
    await pause(1500);
    const sparql = `SELECT ?item ?itemLabel ?itemDescription ?coord ?article WHERE { SERVICE wikibase:around { ?item wdt:P625 ?coord. bd:serviceParam wikibase:center "Point(${city.longitude} ${city.latitude})"^^geo:wktLiteral; wikibase:radius "${radiusKm}". } ?item wdt:P31/wdt:P279* ?type. VALUES ?type { wd:Q570116 wd:Q839954 wd:Q4989906 wd:Q33506 wd:Q811979 wd:Q22698 wd:Q17350442 wd:Q24354 wd:Q23413 } OPTIONAL { ?article schema:about ?item; schema:isPartOf <https://en.wikipedia.org/>. } SERVICE wikibase:label { bd:serviceParam wikibase:language "en,hi". } } LIMIT ${MAX_DISCOVERY_ITEMS_PER_SOURCE}`;
    const response = await fetch(`${env.WIKIDATA_SPARQL_URL}?query=${encode(sparql)}&format=json`, {
      headers: { accept: "application/sparql-results+json", "user-agent": env.USER_AGENT },
    });
    if (!response.ok) throw new Error(`Wikidata HTTP ${response.status}`);
    const bindings: any[] = ((await response.json()) as any).results?.bindings || [];
    for (const binding of bindings.slice(0, MAX_DISCOVERY_ITEMS_PER_SOURCE)) {
      const sourceId = str(binding.item?.value).split("/").pop();
      const point = str(binding.coord?.value).match(/Point\(([-\d.]+)\s+([-\d.]+)\)/);
      if (!sourceId || !point) continue;
      candidates.push({
        city_id: city.id,
        source_name: "wikidata",
        source_id: sourceId,
        raw_payload: binding,
      });
      wikidataCount++;
    }
  } catch (error: any) {
    errors.push(`Wikidata: ${error?.message || String(error)}`);
  }

  if (candidates.length > 0) {
    await db(
      env,
      "tourism_collection_items?on_conflict=city_id,source_name,source_id",
      {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify(candidates),
      },
    );
  }

  if (errors.length === 2 && candidates.length === 0) {
    throw new Error(errors.join(" | "));
  }
  await db(env, `tourism_cities?id=eq.${encode(city.id)}`, {
    method: "PATCH",
    body: JSON.stringify({
      collection_status: "processing",
      collection_discovered_at: new Date().toISOString(),
      collection_discovery_error: errors.join(" | ") || null,
      last_error: errors.join(" | ") || null,
    }),
  });
  return { osmCount, wikidataCount, errors };
}

async function processItem(env: Env, city: City, item: QueueItem) {
  if (item.source_name === "openstreetmap") {
    const element = item.raw_payload || {};
    const tags = element.tags || {};
    const latitude = element.lat ?? element.center?.lat;
    const longitude = element.lon ?? element.center?.lon;
    const name = str(tags.name || tags["name:en"] || tags["name:hi"]);
    if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error("OSM item is missing a name or valid coordinates");
    }
    const wikiTarget = wikipediaTarget(str(tags.wikipedia));
    const wiki = wikiTarget ? await getWiki(wikiTarget.title, env, wikiTarget.language) : null;
    const place: Place = {
      canonical_name: name,
      latitude,
      longitude,
      category: category(tags),
      subcategory: tags.tourism || tags.historic || tags.amenity || tags.leisure || tags.natural,
      address:
        [tags["addr:housenumber"], tags["addr:street"], tags["addr:city"], tags["addr:state"]]
          .filter(Boolean)
          .join(", ") || undefined,
      website_url: tags.website || tags["contact:website"],
      phone: tags.phone || tags["contact:phone"],
      wikidata_id: tags.wikidata,
      description: wiki?.extract || undefined,
      description_source: wiki ? "Wikipedia" : undefined,
      description_license: wiki ? "CC BY-SA" : undefined,
      osm_type: element.type,
      osm_id: element.id,
      // Image candidates are stored in the admin-only source payload by savePlace.
      image_url: undefined,
      image_source_url: undefined,
      wikipedia_url:
        wiki?.url ||
        (wikiTarget
          ? `https://${wikiTarget.language}.wikipedia.org/wiki/${encode(wikiTarget.title.replace(/ /g, "_"))}`
          : undefined),
    };
    await savePlace(
      env,
      city,
      place,
      item.source_name,
      item.source_id,
      `https://www.openstreetmap.org/${item.source_id}`,
      element,
      wiki,
    );
    return { source: item.source_name, wikipedia: wiki ? 1 : 0 };
  }

  const binding = item.raw_payload || {};
  const point = str(binding.coord?.value).match(/Point\(([-\d.]+)\s+([-\d.]+)\)/);
  if (!point) throw new Error("Wikidata item is missing valid coordinates");
  const latitude = Number(point[2]);
  const longitude = Number(point[1]);
  const articleUrl = str(binding.article?.value);
  let title = "";
  let language = "en";
  if (articleUrl) {
    try {
      const article = new URL(articleUrl);
      language = article.hostname.split(".")[0];
      title = decodeURIComponent(article.pathname.split("/wiki/")[1] || "").replace(/_/g, " ");
    } catch {
      title = "";
    }
  }
  const wiki = title ? await getWiki(title, env, language) : null;
  const place: Place = {
    canonical_name: str(binding.itemLabel?.value) || item.source_id,
    latitude,
    longitude,
    category: "wikidata_attraction",
    wikidata_id: item.source_id,
    wikipedia_url: wiki?.url || articleUrl || undefined,
    description: wiki?.extract || str(binding.itemDescription?.value) || undefined,
    description_source: wiki ? "Wikipedia" : "Wikidata",
    description_license: wiki ? "CC BY-SA" : "CC0",
    image_url: undefined,
    image_source_url: undefined,
  };
  await savePlace(
    env,
    city,
    place,
    item.source_name,
    item.source_id,
    `https://www.wikidata.org/wiki/${item.source_id}`,
    binding,
    wiki,
  );
  return { source: item.source_name, wikipedia: wiki ? 1 : 0 };
}

async function queueSummary(env: Env, cityId: string) {
  const items = (await db(
    env,
    `tourism_collection_items?select=status,attempts,available_at,claimed_at&city_id=eq.${encode(cityId)}&limit=1000`,
  )) as QueueItem[];
  const summary = { pending: 0, processing: 0, retryable: 0, failed: 0, completed: 0 };
  for (const item of items || []) {
    if (item.status === "pending") summary.pending++;
    else if (item.status === "processing") summary.processing++;
    else if (item.status === "completed") summary.completed++;
    else if (item.status === "failed") {
      summary.failed++;
      if (item.attempts < MAX_ATTEMPTS) summary.retryable++;
    }
  }
  return summary;
}

async function updateRun(env: Env, runId: string | undefined, values: Record<string, unknown>) {
  if (!runId) return;
  await db(env, `tourism_ingestion_runs?id=eq.${encode(runId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      ...values,
      finished_at: values.status === "running" ? null : new Date().toISOString(),
    }),
  });
}

async function collectCity(env: Env, city: City, radiusKm: number, rediscover = false) {
  const runRows = (await db(env, "tourism_ingestion_runs", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify([{ city_id: city.id, radius_km: radiusKm, status: "running" }]),
  })) as any[];
  const runId = runRows?.[0]?.id as string | undefined;

  if (rediscover) {
    await db(env, `tourism_collection_items?city_id=eq.${encode(city.id)}`, { method: "DELETE" });
    await db(env, `tourism_cities?id=eq.${encode(city.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ collection_status: "pending", collection_discovered_at: null, collection_discovery_error: null, last_error: null }),
    });
    city.collection_discovered_at = null;
    city.collection_discovery_error = null;
    city.collection_status = "pending";
  } else if (city.collection_status === "completed") {
    await updateRun(env, runId, { status: "failed", error_message: "City is already complete; pass rediscover=true to start a new cycle." });
    return json({ error: "City is already complete. Use rediscover=true to start a new discovery cycle." }, 409);
  }

  let discovery = { osmCount: 0, wikidataCount: 0, errors: [] as string[] };
  if (!city.collection_discovered_at) {
    try {
      discovery = await discoverCity(env, city, radiusKm);
    } catch (error: any) {
      const message = error?.message || String(error);
      await db(env, `tourism_cities?id=eq.${encode(city.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ collection_status: "failed", collection_discovered_at: null, collection_discovery_error: null, last_error: message }),
      });
      await updateRun(env, runId, { status: "failed", error_message: message });
      return json({ city: city.name, status: "failed", error: message }, 502);
    }
  }

  const claimed = (await db(env, "rpc/claim_tourism_collection_items", {
    method: "POST",
    body: JSON.stringify({ p_city_id: city.id, p_limit: MAX_ITEMS_PER_INVOCATION }),
  })) as QueueItem[];
  let processed = 0;
  let wikipediaCount = 0;
  const itemErrors: Array<{ item_id: string; error: string }> = [];

  for (const item of claimed || []) {
    try {
      const result = await processItem(env, city, item);
      await db(env, `tourism_collection_items?id=eq.${encode(item.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "completed", processed_at: new Date().toISOString(), claimed_at: null, last_error: null }),
      });
      processed++;
      wikipediaCount += result.wikipedia;
    } catch (error: any) {
      const message = (error?.message || String(error)).slice(0, 1000);
      const retryMinutes = Math.min(60, 5 * 2 ** Math.max(0, item.attempts - 1));
      await db(env, `tourism_collection_items?id=eq.${encode(item.id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: "failed",
          available_at: new Date(Date.now() + retryMinutes * 60_000).toISOString(),
          claimed_at: null,
          last_error: message,
        }),
      });
      itemErrors.push({ item_id: item.id, error: message });
    }
  }

  const summary = await queueSummary(env, city.id);
  const remaining = summary.pending + summary.processing + summary.retryable;
  const discoveryErrors = discovery.errors.length ? discovery.errors : city.collection_discovery_error ? [city.collection_discovery_error] : [];
  const status = remaining > 0 ? "processing" : summary.failed > 0 || discoveryErrors.length > 0 ? "partial" : "completed";
  const errors = [...discoveryErrors, ...itemErrors.map((item) => `${item.item_id}: ${item.error}`)];
  await db(env, `tourism_cities?id=eq.${encode(city.id)}`, {
    method: "PATCH",
    body: JSON.stringify({
      collection_status: status,
      last_collected_at: remaining === 0 ? new Date().toISOString() : undefined,
      last_error: errors.join(" | ") || null,
    }),
  });
  await updateRun(env, runId, {
    status: remaining > 0 ? "running" : status === "partial" ? "partial" : "completed",
    osm_count: (claimed || []).filter((item) => item.source_name === "openstreetmap").length,
    wikidata_count: (claimed || []).filter((item) => item.source_name === "wikidata").length,
    wikipedia_count: wikipediaCount,
    inserted_count: processed,
    error_message: errors.join(" | ") || null,
  });

  return json({
    city: city.name,
    status,
    discovered: { osm: discovery.osmCount, wikidata: discovery.wikidataCount },
    processed,
    remaining,
    queue: summary,
    errors,
  });
}

async function getCity(env: Env, cityId: string): Promise<City | null> {
  const rows = (await db(
    env,
    `tourism_cities?select=id,name,latitude,longitude,radius_km,collection_status,collection_discovered_at,collection_discovery_error&id=eq.${encode(cityId)}&limit=1`,
  )) as City[];
  return rows?.[0] || null;
}

async function collectNextCity(env: Env, radiusKm?: number) {
  const rows = (await db(
    env,
    "tourism_cities?select=id,name,latitude,longitude,radius_km,collection_status,collection_discovered_at,collection_discovery_error&is_enabled=eq.true&collection_status=in.(pending,processing)&order=population.desc.nullslast,name.asc&limit=1",
  )) as City[];
  const city = rows?.[0];
  if (!city) return json({ status: "idle", message: "No pending or processing cities." });
  const radius = Math.max(10, Math.min(50, radiusKm || city.radius_km || Number(env.DEFAULT_RADIUS_KM) || 40));
  return collectCity(env, city, radius);
}

function isAdmin(request: Request, env: Env) {
  return request.headers.get("authorization") === `Bearer ${env.ADMIN_TOKEN}`;
}

async function reviewPlaces(request: Request, env: Env, url: URL) {
  const cityId = url.searchParams.get("city_id") || "";
  if (!UUID_RE.test(cityId)) return json({ error: "A valid city_id UUID is required." }, 400);
  const limitValue = Number(url.searchParams.get("limit") || 50);
  const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(100, limitValue)) : 50;
  const status = url.searchParams.get("status") || "pending";
  if (!new Set(["pending", "approved", "rejected"]).has(status)) {
    return json({ error: "status must be pending, approved, or rejected." }, 400);
  }
  const rows = await db(
    env,
    `tourism_city_places?select=distance_km,relevance_score,place:tourism_places!inner(id,canonical_name,category,subcategory,latitude,longitude,address,description,description_source,description_license,website_url,phone,wikipedia_url,image_url,image_author,image_license,review_status,sources:tourism_place_sources(source_name,source_id,source_url,attribution,license,payload))&city_id=eq.${encode(cityId)}&place.review_status=eq.${status}&order=relevance_score.desc&limit=${limit}`,
  );
  return json(rows);
}

async function updateReview(request: Request, env: Env, placeId: string) {
  if (!UUID_RE.test(placeId)) return json({ error: "A valid place UUID is required." }, 400);
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Request body must be JSON." }, 400);
  }
  const reviewStatus = body?.review_status;
  if (reviewStatus !== "approved" && reviewStatus !== "rejected") {
    return json({ error: "review_status must be approved or rejected." }, 400);
  }
  const rows = (await db(env, `tourism_places?id=eq.${encode(placeId)}&review_status=eq.pending`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ review_status: reviewStatus }),
  })) as any[];
  if (!rows?.length) return json({ error: "Pending place not found or already reviewed." }, 404);
  return json(rows[0]);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (url.pathname === "/health") return json({ ok: true, service: "india-tourism-collector" });

    if (url.pathname === "/public/cities" && request.method === "GET") {
      return json(
        await db(
          env,
          "tourism_cities?select=id,name,state_name,latitude,longitude,radius_km&is_enabled=eq.true&order=name.asc",
        ),
      );
    }
    if (url.pathname === "/public/places" && request.method === "GET") {
      const cityId = url.searchParams.get("city_id") || "";
      if (!UUID_RE.test(cityId)) return json({ error: "A valid city_id is required." }, 400);
      const requestedLimit = Number(url.searchParams.get("limit") || 100);
      const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(100, requestedLimit)) : 100;
      return json(
        await db(
          env,
          `tourism_city_places?select=distance_km,relevance_score,place:tourism_places!inner(*)&city_id=eq.${encode(cityId)}&place.review_status=eq.approved&place.is_active=eq.true&order=relevance_score.desc&limit=${limit}`,
        ),
      );
    }

    if (!isAdmin(request, env)) return json({ error: "Unauthorized" }, 401);

    if (url.pathname === "/admin/stats" && request.method === "GET") {
      const [cities, places, runs, queue] = (await Promise.all([
        db(env, "tourism_cities?select=collection_status&limit=1000"),
        db(env, "tourism_places?select=review_status&limit=1000"),
        db(env, "tourism_ingestion_runs?select=status&limit=1000"),
        db(env, "tourism_collection_items?select=status&limit=1000"),
      ])) as any[][];
      const count = (rows: any[], key: string) =>
        (rows || []).reduce((result: Record<string, number>, row: any) => {
          result[row[key]] = (result[row[key]] || 0) + 1;
          return result;
        }, {});
      return json({ cities: count(cities, "collection_status"), places: count(places, "review_status"), runs: count(runs, "status"), queue: count(queue, "status") });
    }
    if (url.pathname === "/admin/review" && request.method === "GET") {
      return reviewPlaces(request, env, url);
    }
    const reviewMatch = url.pathname.match(/^\/admin\/review\/([0-9a-f-]+)$/i);
    if (reviewMatch && request.method === "POST") {
      return updateReview(request, env, reviewMatch[1]);
    }
    if (url.pathname === "/admin/collect" && request.method === "POST") {
      const radius = Number(url.searchParams.get("radiusKm"));
      return collectNextCity(env, Number.isFinite(radius) && radius > 0 ? radius : undefined);
    }
    const collectMatch = url.pathname.match(/^\/admin\/collect-city\/([0-9a-f-]+)$/i);
    if (collectMatch && request.method === "POST") {
      const city = await getCity(env, collectMatch[1]);
      if (!city) return json({ error: "City not found." }, 404);
      const requestedRadius = Number(url.searchParams.get("radiusKm"));
      const radius = Math.max(
        10,
        Math.min(
          50,
          Number.isFinite(requestedRadius) && requestedRadius > 0
            ? requestedRadius
            : city.radius_km || Number(env.DEFAULT_RADIUS_KM) || 40,
        ),
      );
      return collectCity(env, city, radius, url.searchParams.get("rediscover") === "true");
    }
    return json({ error: "Not found" }, 404);
  },
};
