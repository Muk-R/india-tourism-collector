import {
  buildOverpassQuery,
  completePendingTile,
  createTileCursor,
  deduplicateCandidates,
  normalizeOsmCandidate,
  subdividePendingTile,
  validateBoundingBox,
  type BoundingBox,
  type DiscoveryKind,
  type OSMElement,
  type TileCursor,
} from './tourism-data/catalog.ts';
import { mapPbfStageRecord, type PbfStageRecord } from './pbf-stage-contract.ts';
import { validatePromotionRequest, validatePublicationRollback } from './offline-publication.ts';
import { classifyTourismPlace } from './tourism-data/taxonomy.ts';

interface Env {
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  SUPABASE_PROJECT_REF?: string;
  DB_DIAGNOSTICS?: string;
  ALLOW_LOCAL_HTTP?: string;
  ADMIN_TOKEN: string;
  ADMIN_ACTOR_ID?: string;
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
  active_collection_cycle_id?: string | null;
}

interface QueueItem {
  id: string;
  city_id: string;
  source_name: "openstreetmap" | "wikidata";
  source_id: string;
  raw_payload: any;
  status: "pending" | "processing" | "completed" | "failed" | "exhausted" | "superseded";
  attempts: number;
  available_at: string;
  lease_token: string | null;
  lease_expires_at: string | null;
  priority_score: number;
  priority_reasons: string[];
  last_error: string | null;
}

type SourceName = QueueItem["source_name"];

interface CycleClaim {
  cycle_id: string;
  city_id: string;
  radius_km: number;
  lease_token: string;
  lease_expires_at: string;
  cycle_status: string;
}

interface CycleSource {
  cycle_id: string;
  source_name: SourceName;
  status: string;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  lease_token: string | null;
  lease_expires_at: string | null;
  cursor: unknown;
  pages_completed: number;
  items_discovered: number;
  is_complete: boolean;
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
const MAX_DISCOVERY_PAGES_PER_SOURCE_PER_INVOCATION = 3;
const WIKIDATA_PAGE_SIZE = 250;
// The persistence RPC accepts at most 2,000 page items. Subdivide below that
// limit so large tiles cannot make cursor progress fail at commit time.
const MAX_OSM_ELEMENTS_PER_PAGE = 1_800;
const MAX_OSM_SUBDIVISION_DEPTH = 4;
const LEASE_SECONDS = 600;
const MAX_RETRY_AFTER_MS = 30_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
const encode = (value: string) => encodeURIComponent(value);
const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const str = (value: any) => (typeof value === "string" ? value.trim() : "");

export function retryAfterDelay(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const header = value.trim();
  if (/^\d+$/.test(header)) {
    return Math.min(MAX_RETRY_AFTER_MS, Number(header) * 1000);
  }
  if (!/(?:GMT|UTC)$/i.test(header)) return undefined;
  const date = Date.parse(header);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - now));
}

export async function fetchWithRetry(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  attempts = 3,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let retryDelay = 500 * 2 ** attempt;
    try {
      const response = await fetch(input, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status !== 408 && response.status !== 429 && response.status < 500) return response;
      if (attempt === attempts - 1) return response;
      if (response.status === 429 || response.status === 503) {
        retryDelay = retryAfterDelay(response.headers.get("Retry-After")) ?? retryDelay;
      }
      await response.body?.cancel();
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) throw error;
    }
    await pause(retryDelay);
  }
  throw lastError instanceof Error ? lastError : new Error("Request failed after retries.");
}


type DbDiagnosticContext = { requestId: string; operation: "public_cities" | "public_places" };

function emitDbDiagnostic(env: Env, context: DbDiagnosticContext | undefined, stage: string, details: Record<string, unknown> = {}) {
  if (env.DB_DIAGNOSTICS !== "true" || !context) return;
  console.log("tourism_db_stage", { request_id: context.requestId, operation: context.operation, stage, ...details });
}

function diagnosticRequestId(request: Request): string {
  const ray = request.headers.get("cf-ray") || "";
  return /^[a-f0-9]{16}(?:-[A-Z]{3})?$/i.test(ray) ? ray : crypto.randomUUID();
}

function credentialFormat(value: unknown) {
  if (typeof value !== "string" || !value) return { kind: "missing", format_valid: false };
  if (value.startsWith("sb_secret_")) {
    return { kind: "sb_secret", format_valid: /^sb_secret_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{8}$/.test(value) };
  }
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
    return { kind: "legacy_jwt", format_valid: true };
  }
  return { kind: "other", format_valid: false };
}

function networkExceptionCategory(error: unknown): string {
  if (!(error instanceof Error)) return "unknown_exception";
  if (error.name === "TimeoutError" || error.name === "AbortError") return "timeout";
  const cause = (error as Error & { cause?: unknown }).cause;
  const code = cause && typeof cause === "object" && "code" in cause ? (cause as { code?: unknown }).code : undefined;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT") return "connection";
  if (code === "CERT_HAS_EXPIRED" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") return "tls";
  if (error instanceof TypeError) return "fetch_type_error";
  return "network_exception";
}

async function db(env: Env, path: string, init: RequestInit = {}, diagnostic?: DbDiagnosticContext) {
  const hasUrl = typeof env.SUPABASE_URL === "string" && env.SUPABASE_URL.length > 0;
  const hasCredential = typeof env.SUPABASE_SECRET_KEY === "string" && env.SUPABASE_SECRET_KEY.length > 0;
  emitDbDiagnostic(env, diagnostic, "bindings", { supabase_url_present: hasUrl, supabase_secret_key_present: hasCredential });
  if (!hasUrl || !hasCredential) {
    emitDbDiagnostic(env, diagnostic, "configuration_failure", { category: "required_binding_missing" });
    throw new Error("Required Supabase binding is missing.");
  }

  let supabaseUrl: URL;
  try {
    supabaseUrl = new URL(env.SUPABASE_URL);
  } catch {
    emitDbDiagnostic(env, diagnostic, "url_validation", { valid: false, category: "invalid_url" });
    throw new Error("Supabase URL is invalid.");
  }
  const localLoopbackHttp = env.ALLOW_LOCAL_HTTP === "true" && supabaseUrl.protocol === "http:" &&
    (supabaseUrl.hostname === "127.0.0.1" || supabaseUrl.hostname === "localhost");

  const validUrl = !(
    (supabaseUrl.protocol !== "https:" && !localLoopbackHttp) ||
    !supabaseUrl.hostname ||
    supabaseUrl.username ||
    supabaseUrl.password ||
    supabaseUrl.pathname !== "/" ||
    supabaseUrl.search ||
    supabaseUrl.hash
  );
  const expectedProject = env.SUPABASE_PROJECT_REF;
  const projectRefValid = !expectedProject || /^[a-z0-9]{20}$/i.test(expectedProject);
  const projectMatch = expectedProject && projectRefValid
    ? supabaseUrl.hostname.toLowerCase() === `${expectedProject.toLowerCase()}.supabase.co`
    : null;
  emitDbDiagnostic(env, diagnostic, "url_validation", {
    valid: validUrl,
    project_match: projectMatch,
    expected_project_ref_configured: Boolean(expectedProject),
  });
  if (!validUrl || !projectRefValid || projectMatch === false) {
    const category = !validUrl ? "invalid_url" : !projectRefValid ? "invalid_expected_project_ref" : "project_mismatch";
    emitDbDiagnostic(env, diagnostic, "configuration_failure", { category });
    throw new Error("SUPABASE_URL must be an HTTPS origin without credentials or URL parameters.");
  }

  const format = credentialFormat(env.SUPABASE_SECRET_KEY);
  emitDbDiagnostic(env, diagnostic, "credential_format", format);
  const headers = new Headers(init.headers);

  headers.set("apikey", env.SUPABASE_SECRET_KEY);
  headers.set("Content-Type", "application/json");

  // New Supabase secret API keys are not JWTs; send them as apikey only.
  // Legacy service_role keys still need the Bearer header to select that role.
  if (!env.SUPABASE_SECRET_KEY.startsWith("sb_secret_")) {
    headers.set("Authorization", `Bearer ${env.SUPABASE_SECRET_KEY}`);
  }
  emitDbDiagnostic(env, diagnostic, "fetch_start", { upstream: "supabase_rest", method: init.method || "GET" });
  let response: Response;
  try {
    response = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
      ...init,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    emitDbDiagnostic(env, diagnostic, "fetch_exception", { category: networkExceptionCategory(error) });
    throw error;
  }

  if (!response.ok) {
    const responseBody = (await response.text()).slice(0, 400);
    let upstreamCode: string | undefined;
    try {
      const parsed = JSON.parse(responseBody);
      if (typeof parsed?.code === "string" && /^[A-Z0-9]{4,16}$/.test(parsed.code)) upstreamCode = parsed.code;
    } catch { /* Keep the upstream response body out of diagnostics. */ }
    emitDbDiagnostic(env, diagnostic, "upstream_response", {
      status: response.status,
      category: "http_error",
      ...(upstreamCode ? { code: upstreamCode } : {}),
    });
    const error = new Error(`Supabase ${response.status}: ${responseBody}`) as Error & { upstreamStatus: number; upstreamCode?: string };
    error.upstreamStatus = response.status;
    error.upstreamCode = upstreamCode;
    throw error;
  }
  emitDbDiagnostic(env, diagnostic, "upstream_response", { status: response.status, category: "success" });
  if (response.status === 204) return null;
  const body = await response.text();
  try {
    return body ? JSON.parse(body) : null;
  } catch (error) {
    emitDbDiagnostic(env, diagnostic, "response_parse_failure", { category: "invalid_json" });
    throw error;
  }
}

function safeDatabaseDiagnostic(error: unknown) {
  if (error && typeof error === "object" && "upstreamStatus" in error) {
    const status = (error as { upstreamStatus?: unknown }).upstreamStatus;
    const code = (error as { upstreamCode?: unknown }).upstreamCode;
    return {
      kind: "postgrest_http",
      ...(typeof status === "number" ? { status } : {}),
      ...(typeof code === "string" && /^[A-Z0-9]{4,16}$/.test(code) ? { code } : {}),
    };
  }
  if (error instanceof TypeError) return { kind: "fetch_or_configuration" };
  if (error instanceof SyntaxError) return { kind: "invalid_upstream_json" };
  return { kind: "database_request" };
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

export function scoreImportance(source: SourceName, payload: any): { score: number; reasons: string[] } {
  const tags = source === "openstreetmap" ? payload?.tags || {} : {};
  const sitelinks = Number(payload?.sitelinks?.value || 0);
  const reasons: string[] = [];
  let value = source === "wikidata" ? 58 : 45;

  if (source === "wikidata" && payload?.designation?.value) {
    value = Math.max(value, 96);
    reasons.push("heritage_designation");
  }
  if (source === "wikidata" && payload?.inception?.value) {
    value = Math.max(value, 66);
    reasons.push("historical_record");
  }
  if (tags.heritage || tags["heritage:operator"] || tags["ref:whc"]) {
    value = Math.max(value, 96);
    reasons.push("heritage_designation");
  }
  if (tags.historic && tags.historic !== "yes" && tags.historic !== "no") {
    value = Math.max(value, 84);
    reasons.push("historic_attraction");
  } else if (tags.historic === "yes") {
    value = Math.max(value, 72);
    reasons.push("historic_site");
  }
  if (tags.natural === "waterfall" || tags.waterway === "waterfall") {
    value = Math.max(value, 78);
    reasons.push("waterfall");
  }
  if (tags.natural === "peak" || tags.natural === "volcano") {
    value = Math.max(value, 76);
    reasons.push("mountain_or_peak");
  }
  if (tags.tourism === "viewpoint") {
    value = Math.max(value, 74);
    reasons.push("viewpoint");
  }
  if (tags.tourism && tags.tourism !== "yes") {
    value = Math.max(value, 64);
    reasons.push("tourism_feature");
  }
  if (payload?.article?.value) {
    value = Math.max(value, 72);
    reasons.push("wikipedia_article");
  }
  if (sitelinks >= 100) {
    value = Math.max(value, 94);
    reasons.push("wikidata_sitelinks_100_plus");
  } else if (sitelinks >= 20) {
    value = Math.max(value, 82);
    reasons.push("wikidata_sitelinks_20_plus");
  } else if (sitelinks >= 5) {
    value = Math.max(value, 70);
    reasons.push("wikidata_sitelinks_5_plus");
  }
  if (!reasons.length) reasons.push(source === "wikidata" ? "wikidata_geographic_feature" : "named_osm_feature");
  return { score: Math.min(100, value), reasons };
}

export function category(tags: any) {
  const historicCategory =
    tags.historic === "yes" ? "historic_site" : tags.historic && tags.historic !== "no" ? tags.historic : undefined;
  return (
    historicCategory ||
    tags.tourism ||
    (tags.amenity === "place_of_worship" ? "religious_site" : tags.leisure || tags.natural || "attraction")
  );
}

export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const radians = (value: number) => (value * Math.PI) / 180;
  const deltaLat = radians(lat2 - lat1);
  const deltaLon = radians(lon2 - lon1);
  const halfChord =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(deltaLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(halfChord));
}

export function subcategory(tags: any): string | undefined {
  return [tags.tourism, tags.historic, tags.amenity, tags.leisure, tags.natural].find(
    (value) => typeof value === "string" && !["yes", "no"].includes(value.toLowerCase()),
  );
}

export function parseRadius(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) throw new Error("radiusKm must be a whole number from 10 through 150.");
  const radius = Number(value);
  if (!Number.isInteger(radius) || radius < 10 || radius > 150) {
    throw new Error("radiusKm must be a whole number from 10 through 150.");
  }
  return radius;
}

async function savePlace(
  env: Env,
  cycle: CycleClaim,
  item: QueueItem,
  place: Place,
  wiki: WikiInfo | null,
) {
  place.quality_score = score(place);
  const importance = scoreImportance(item.source_name, item.raw_payload);
  place.importance_score = importance.score;
  const taxonomy = item.source_name === 'openstreetmap'
    ? classifyTourismPlace({
        place,
        tags: item.raw_payload?.tags || {},
        evidence: place.wikidata_id ? { wikidataId: place.wikidata_id } : {},
      })
    : null;

  const sourceUrl = item.source_name === 'openstreetmap'
    ? `https://www.openstreetmap.org/${item.source_id}`
    : `https://www.wikidata.org/wiki/${item.source_id}`;
  const source = {
    source_name: item.source_name,
    source_id: item.source_id,
    source_url: sourceUrl,
    attribution: item.source_name === 'openstreetmap' ? '© OpenStreetMap contributors' : 'Wikidata contributors',
    license: item.source_name === 'openstreetmap' ? 'ODbL' : 'CC0',
    payload: taxonomy
      ? { ...item.raw_payload, localise_taxonomy: taxonomy }
      : item.raw_payload,
  };
  const wikipediaSource = wiki
    ? {
        source_id: wiki.url,
        source_url: wiki.url,
        attribution: 'Wikipedia contributors',
        license: 'CC BY-SA',
        payload: { page_id: wiki.pageId, candidate_image_url: wiki.imageCandidate },
      }
    : null;

  await db(env, 'rpc/upsert_tourism_place_for_cycle', {
    method: 'POST',
    body: JSON.stringify({
      p_cycle_id: cycle.cycle_id,
      p_city_lease_token: cycle.lease_token,
      p_item_id: item.id,
      p_item_lease_token: item.lease_token,
      p_place: place,
      p_source: source,
      p_wikipedia_source: wikipediaSource,
    }),
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

export async function getWiki(title: string, env: Env, language = "en"): Promise<WikiInfo | null> {
  if (!title) return null;
  const hostLanguage = /^[a-z0-9-]{1,16}$/.test(language) ? language : "en";
  const host = `${hostLanguage}.wikipedia.org`;
  const apiUrl = `https://${host}/w/api.php?action=query&prop=extracts|pageimages|info&inprop=url&exintro=1&explaintext=1&piprop=thumbnail&pithumbsize=900&redirects=1&format=json&titles=${encode(title)}`;
  const response = await fetchWithRetry(
    apiUrl,
    { headers: { "user-agent": env.USER_AGENT } },
    12_000,
  );
  if (!response.ok) throw new Error(`Wikipedia HTTP ${response.status}`);
  const data: any = await response.json();
  if (data?.error) throw new Error(`Wikipedia API error: ${str(data.error.info) || "unknown error"}`);
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

type OsmDiscoveryCursor = {
  version: 1;
  cursors: Record<DiscoveryKind, TileCursor>;
};
type WikidataCursor = { offset: number };
type DiscoveryCandidate = {
  source_id: string;
  raw_payload: unknown;
  priority_score: number;
  priority_reasons: string[];
};

class OverpassCapacityError extends Error {}

const OSM_DISCOVERY_KINDS: DiscoveryKind[] = ['attractions', 'lodging', 'restaurants'];

function osmBounds(city: City, radiusKm: number): BoundingBox {
  const kmPerLatitudeDegree = 111.32;
  const longitudeScale = Math.max(0.2, Math.cos((city.latitude * Math.PI) / 180));
  const latSpan = radiusKm / kmPerLatitudeDegree;
  const lonSpan = radiusKm / (kmPerLatitudeDegree * longitudeScale);
  const bounds = {
    south: Math.max(-90, city.latitude - latSpan),
    west: Math.max(-180, city.longitude - lonSpan),
    north: Math.min(90, city.latitude + latSpan),
    east: Math.min(180, city.longitude + lonSpan),
  };
  validateBoundingBox(bounds);
  return bounds;
}

function initialOsmDiscoveryCursor(city: City, radiusKm: number): OsmDiscoveryCursor {
  const bounds = osmBounds(city, radiusKm);
  return {
    version: 1,
    cursors: {
      attractions: createTileCursor(bounds),
      lodging: createTileCursor(bounds),
      restaurants: createTileCursor(bounds),
    },
  };
}

function readOsmDiscoveryCursor(
  city: City,
  radiusKm: number,
  value: unknown,
): OsmDiscoveryCursor {
  if (value === null || value === undefined) return initialOsmDiscoveryCursor(city, radiusKm);
  const cursor = value as Partial<OsmDiscoveryCursor> & { tasks?: unknown[] };
  if (cursor.version === 1 && cursor.cursors && OSM_DISCOVERY_KINDS.every((kind) => {
    const item = cursor.cursors?.[kind];
    return item?.version === 1 && Array.isArray(item.pending) && Array.isArray(item.completed);
  })) return cursor as OsmDiscoveryCursor;

  // Continue cursors written by the previous Worker, whose OSM query discovered
  // attractions only. Preserve its remaining tiles and start the new categories.
  if (Array.isArray(cursor.tasks)) {
    const result = initialOsmDiscoveryCursor(city, radiusKm);
    result.cursors.attractions = {
      version: 1,
      pending: cursor.tasks.map((raw, index) => {
        const task = raw as { south?: number; west?: number; north?: number; east?: number; depth?: number };
        const bounds = { south: Number(task.south), west: Number(task.west), north: Number(task.north), east: Number(task.east) };
        validateBoundingBox(bounds);
        const id = `legacy-${index}-${[bounds.south, bounds.west, bounds.north, bounds.east].map((n) => n.toFixed(5)).join(':')}`;
        const depth = Number(task.depth ?? 0);
        if (!Number.isInteger(depth) || depth < 0) throw new Error('Legacy OSM cursor has an invalid tile depth.');
        return { id, bounds, depth };
      }),
      completed: [],
    };
    return result;
  }
  throw new Error('OSM discovery cursor is not recognized; refusing to mark the source complete.');
}

async function persistSourcePage(
  env: Env,
  cycle: CycleClaim,
  sourceName: SourceName,
  sourceLeaseToken: string,
  pageKey: string,
  expectedCursor: unknown,
  nextCursor: unknown,
  items: DiscoveryCandidate[],
  isComplete: boolean,
) {
  return db(env, 'rpc/persist_tourism_cycle_source_page', {
    method: 'POST',
    body: JSON.stringify({
      p_cycle_id: cycle.cycle_id,
      p_city_lease_token: cycle.lease_token,
      p_source_name: sourceName,
      p_source_lease_token: sourceLeaseToken,
      p_page_key: pageKey,
      p_expected_cursor: expectedCursor ?? null,
      p_next_cursor: nextCursor ?? null,
      p_items: items,
      p_is_complete: isComplete,
    }),
  });
}

async function renewLease(
  env: Env,
  cycle: CycleClaim,
  sourceName: SourceName | null = null,
  sourceLeaseToken: string | null = null,
  itemId: string | null = null,
  itemLeaseToken: string | null = null,
) {
  if ((sourceName === null) !== (sourceLeaseToken === null) || (itemId === null) !== (itemLeaseToken === null)) {
    throw new Error('Incomplete lease renewal identity.');
  }
  await db(env, 'rpc/renew_tourism_collection_lease', {
    method: 'POST',
    body: JSON.stringify({
      p_cycle_id: cycle.cycle_id,
      p_city_lease_token: cycle.lease_token,
      p_lease_seconds: LEASE_SECONDS,
      p_source_name: sourceName,
      p_source_lease_token: sourceLeaseToken,
      p_item_id: itemId,
      p_item_lease_token: itemLeaseToken,
    }),
  });
}

async function fetchOsmTile(env: Env, kind: DiscoveryKind, bounds: BoundingBox): Promise<OSMElement[]> {
  const response = await fetchWithRetry(env.OVERPASS_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': env.USER_AGENT,
    },
    body: `data=${encode(buildOverpassQuery(kind, bounds))}`,
  }, 60_000);
  if (!response.ok) {
    const message = `Overpass HTTP ${response.status}`;
    if ([502, 504].includes(response.status)) throw new OverpassCapacityError(message);
    throw new Error(message);
  }
  const result: any = await response.json();
  if (result?.remark) {
    const message = str(result.remark);
    if (/timeout|timed out|runtime|memory|too large|run out/i.test(message)) {
      throw new OverpassCapacityError(`Overpass runtime limit: ${message}`);
    }
    throw new Error(`Overpass runtime error: ${message}`);
  }
  if (!Array.isArray(result?.elements)) throw new Error('Overpass response is missing elements.');
  return result.elements;
}

async function claimSource(env: Env, cycle: CycleClaim, sourceName: SourceName): Promise<CycleSource | null> {
  const rows = await db(env, 'rpc/claim_tourism_cycle_source', {
    method: 'POST',
    body: JSON.stringify({
      p_cycle_id: cycle.cycle_id,
      p_city_lease_token: cycle.lease_token,
      p_source_name: sourceName,
      p_lease_seconds: LEASE_SECONDS,
    }),
  }) as CycleSource[];
  return rows?.[0] || null;
}

async function failSource(env: Env, cycle: CycleClaim, sourceName: SourceName, sourceLeaseToken: string, error: unknown) {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  await db(env, 'rpc/fail_tourism_cycle_source', {
    method: 'POST',
    body: JSON.stringify({
      p_cycle_id: cycle.cycle_id,
      p_city_lease_token: cycle.lease_token,
      p_source_name: sourceName,
      p_source_lease_token: sourceLeaseToken,
      p_error: message,
    }),
  });
  return message;
}

async function discoverOsmPage(env: Env, city: City, cycle: CycleClaim, source: CycleSource) {
  const sourceLeaseToken = source.lease_token;
  if (!sourceLeaseToken) throw new Error('OSM source claim returned no lease token.');
  const expectedCursor = source.cursor;
  const cursor = readOsmDiscoveryCursor(city, cycle.radius_km, source.cursor);
  const kind = OSM_DISCOVERY_KINDS.find((candidateKind) => cursor.cursors[candidateKind].pending.length > 0);
  if (!kind) {
    await persistSourcePage(env, cycle, 'openstreetmap', sourceLeaseToken,
      'osm:v1:complete', expectedCursor, null, [], true);
    return { discovered: 0, complete: true, cursor: null };
  }
  const kindCursor = cursor.cursors[kind];
  const task = kindCursor.pending[0];
  if (!task) throw new Error(`OSM ${kind} cursor lost its pending tile.`);

  await pause(1000);
  await renewLease(env, cycle, 'openstreetmap', sourceLeaseToken);
  let elements: OSMElement[];
  try {
    elements = await fetchOsmTile(env, kind, task.bounds);
  } catch (error) {
    const splittable = error instanceof OverpassCapacityError && task.depth < MAX_OSM_SUBDIVISION_DEPTH;
    if (!splittable) throw error;
    const nextKindCursor = subdividePendingTile(kindCursor, task.id, MAX_OSM_SUBDIVISION_DEPTH);
    const nextDiscoveryCursor: OsmDiscoveryCursor = {
      version: 1,
      cursors: { ...cursor.cursors, [kind]: nextKindCursor },
    };
    await persistSourcePage(env, cycle, 'openstreetmap', sourceLeaseToken,
      `osm:v1:${kind}:split:${task.id}`, expectedCursor, nextDiscoveryCursor, [], false);
    return { discovered: 0, complete: false, subdivided: true, cursor: nextDiscoveryCursor };
  }

  if (elements.length > MAX_OSM_ELEMENTS_PER_PAGE) {
    const nextKindCursor = subdividePendingTile(kindCursor, task.id, MAX_OSM_SUBDIVISION_DEPTH);
    const nextDiscoveryCursor: OsmDiscoveryCursor = {
      version: 1,
      cursors: { ...cursor.cursors, [kind]: nextKindCursor },
    };
    await persistSourcePage(env, cycle, 'openstreetmap', sourceLeaseToken,
      `osm:v1:${kind}:split:${task.id}`, expectedCursor, nextDiscoveryCursor, [], false);
    return { discovered: 0, complete: false, subdivided: true, cursor: nextDiscoveryCursor };
  }

  const normalized = deduplicateCandidates(elements.map((element) => normalizeOsmCandidate(kind, element)));
  const candidates: DiscoveryCandidate[] = normalized
    .filter((candidate) => distanceKm(city.latitude, city.longitude, candidate.latitude, candidate.longitude) <= cycle.radius_km)
    .map((candidate) => ({
      source_id: candidate.source_id,
      raw_payload: candidate.evidence.payload,
      priority_score: candidate.importance_score,
      priority_reasons: candidate.importance_reasons,
    }));
  const nextKindCursor = completePendingTile(kindCursor, task.id);
  const nextCursors = { ...cursor.cursors, [kind]: nextKindCursor };
  const isComplete = OSM_DISCOVERY_KINDS.every((candidateKind) => nextCursors[candidateKind].pending.length === 0);
  const nextCursor: OsmDiscoveryCursor | null = isComplete ? null : { version: 1, cursors: nextCursors };
  await persistSourcePage(env, cycle, 'openstreetmap', sourceLeaseToken,
    `osm:v1:${kind}:tile:${task.id}`, expectedCursor, nextCursor, candidates, isComplete);
  return { discovered: candidates.length, complete: isComplete, cursor: nextCursor, kind };
}

function wikidataQuery(city: City, radiusKm: number, offset: number): string {
  return `SELECT ?item ?itemLabel ?itemDescription ?coord ?article ?sitelinks ?inception ?elevation ?designation ?duration WHERE {
    SERVICE wikibase:around { ?item wdt:P625 ?coord. bd:serviceParam wikibase:center "Point(${city.longitude} ${city.latitude})"^^geo:wktLiteral; wikibase:radius "${radiusKm}". }
    { ?item wdt:P31/wdt:P279* ?type. VALUES ?type { wd:Q570116 wd:Q839954 wd:Q4989906 wd:Q33506 wd:Q811979 wd:Q22698 wd:Q17350442 wd:Q24354 wd:Q23413 wd:Q8502 wd:Q34038 wd:Q177818 wd:Q23397 wd:Q39614 wd:Q42948 } }
    UNION { ?article schema:about ?item; schema:isPartOf <https://en.wikipedia.org/>. }
    OPTIONAL { ?article schema:about ?item; schema:isPartOf <https://en.wikipedia.org/>. }
    OPTIONAL { ?item wdt:P571 ?inception. }
    OPTIONAL { ?item wdt:P2044 ?elevation. }
    OPTIONAL { ?item wdt:P1435 ?designation. }
    OPTIONAL { ?item wdt:P2047 ?duration. }
    ?item wikibase:sitelinks ?sitelinks.
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en,hi". }
  } ORDER BY DESC(?sitelinks) ?item LIMIT ${WIKIDATA_PAGE_SIZE} OFFSET ${offset}`;
}

async function discoverWikidataPage(env: Env, city: City, cycle: CycleClaim, source: CycleSource) {
  const sourceLeaseToken = source.lease_token;
  if (!sourceLeaseToken) throw new Error('Wikidata source claim returned no lease token.');
  const expectedCursor = source.cursor;
  const offset = Number((source.cursor as WikidataCursor | null)?.offset || 0);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Wikidata cursor has an invalid offset.');

  await pause(1500);
  await renewLease(env, cycle, 'wikidata', sourceLeaseToken);
  const response = await fetchWithRetry(
    `${env.WIKIDATA_SPARQL_URL}?query=${encode(wikidataQuery(city, cycle.radius_km, offset))}&format=json`,
    { headers: { accept: 'application/sparql-results+json', 'user-agent': env.USER_AGENT } },
    25_000,
  );
  if (!response.ok) throw new Error(`Wikidata HTTP ${response.status}`);
  const data: any = await response.json();
  if (!Array.isArray(data?.results?.bindings)) throw new Error('Wikidata response is missing results.');
  const bindings: any[] = data.results.bindings;
  const candidates: DiscoveryCandidate[] = [];
  for (const binding of bindings) {
    const sourceId = str(binding.item?.value).split('/').pop();
    const point = str(binding.coord?.value).match(/Point\(([-\d.]+)\s+([-\d.]+)\)/);
    if (!sourceId || !/^Q\d+$/.test(sourceId) || !point) continue;
    const latitude = Number(point[2]);
    const longitude = Number(point[1]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    if (distanceKm(city.latitude, city.longitude, latitude, longitude) > cycle.radius_km) continue;
    const importance = scoreImportance('wikidata', binding);
    candidates.push({
      source_id: sourceId,
      raw_payload: binding,
      priority_score: importance.score,
      priority_reasons: importance.reasons,
    });
  }
  const isComplete = bindings.length < WIKIDATA_PAGE_SIZE;
  const nextCursor = isComplete ? null : { offset: offset + WIKIDATA_PAGE_SIZE };
  await persistSourcePage(env, cycle, 'wikidata', sourceLeaseToken,
    `wikidata:offset:${offset}`, expectedCursor, nextCursor, candidates, isComplete);
  return { discovered: candidates.length, complete: isComplete, cursor: nextCursor };
}

async function discoverSourcePage(env: Env, city: City, cycle: CycleClaim, source: CycleSource) {
  return source.source_name === 'openstreetmap'
    ? discoverOsmPage(env, city, cycle, source)
    : discoverWikidataPage(env, city, cycle, source);
}

async function processItem(env: Env, city: City, cycle: CycleClaim, item: QueueItem) {
  if (item.source_name === 'openstreetmap') {
    const element = item.raw_payload || {};
    const tags = element.tags || {};
    const latitude = element.lat ?? element.center?.lat;
    const longitude = element.lon ?? element.center?.lon;
    const name = str(tags.name || tags['name:en'] || tags['name:hi']);
    if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error('OSM item is missing a name or valid coordinates');
    }
    if (distanceKm(city.latitude, city.longitude, latitude, longitude) > cycle.radius_km) {
      throw new Error('OSM item is outside the persisted collection-cycle radius');
    }
    const wikiTarget = wikipediaTarget(str(tags.wikipedia));
    const wiki = wikiTarget ? await getWiki(wikiTarget.title, env, wikiTarget.language) : null;
    const place: Place = {
      canonical_name: name,
      latitude,
      longitude,
      category: category(tags),
      subcategory: subcategory(tags),
      address: [tags['addr:housenumber'], tags['addr:street'], tags['addr:city'], tags['addr:state']]
        .filter(Boolean).join(', ') || undefined,
      website_url: tags.website || tags['contact:website'],
      phone: tags.phone || tags['contact:phone'],
      wikidata_id: tags.wikidata,
      description: wiki?.extract || undefined,
      description_source: wiki?.extract ? 'Wikipedia' : undefined,
      description_license: wiki?.extract ? 'CC BY-SA' : undefined,
      osm_type: element.type,
      osm_id: element.id,
      image_url: undefined,
      image_source_url: undefined,
      wikipedia_url: wiki?.url || (wikiTarget
        ? `https://${wikiTarget.language}.wikipedia.org/wiki/${encode(wikiTarget.title.replace(/ /g, '_'))}`
        : undefined),
    };
    await savePlace(env, cycle, item, place, wiki);
    return { wikipedia: wiki ? 1 : 0 };
  }

  const binding = item.raw_payload || {};
  const point = str(binding.coord?.value).match(/Point\(([-\d.]+)\s+([-\d.]+)\)/);
  if (!point) throw new Error('Wikidata item is missing valid coordinates');
  const latitude = Number(point[2]);
  const longitude = Number(point[1]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error('Wikidata item has invalid coordinates');
  if (distanceKm(city.latitude, city.longitude, latitude, longitude) > cycle.radius_km) {
    throw new Error('Wikidata item is outside the persisted collection-cycle radius');
  }
  const articleUrl = str(binding.article?.value);
  let title = '';
  let language = 'en';
  if (articleUrl) {
    try {
      const article = new URL(articleUrl);
      language = article.hostname.split('.')[0];
      title = decodeURIComponent(article.pathname.split('/wiki/')[1] || '').replace(/_/g, ' ');
    } catch {
      title = '';
    }
  }
  const wiki = title ? await getWiki(title, env, language) : null;
  const wikipediaDescription = str(wiki?.extract);
  const wikidataDescription = str(binding.itemDescription?.value);
  const description = wikipediaDescription || wikidataDescription;
  const descriptionSource = wikipediaDescription ? 'Wikipedia' : wikidataDescription ? 'Wikidata' : undefined;
  const place: Place = {
    canonical_name: str(binding.itemLabel?.value) || item.source_id,
    latitude,
    longitude,
    category: 'wikidata_attraction',
    wikidata_id: item.source_id,
    wikipedia_url: wiki?.url || articleUrl || undefined,
    description: description || undefined,
    description_source: descriptionSource,
    description_license: descriptionSource === 'Wikipedia' ? 'CC BY-SA' : descriptionSource === 'Wikidata' ? 'CC0' : undefined,
    image_url: undefined,
    image_source_url: undefined,
  };
  await savePlace(env, cycle, item, place, wiki);
  return { wikipedia: wiki ? 1 : 0 };
}
async function countStatuses(env: Env, path: string, field: string, order = 'id.asc'): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (let offset = 0; ; offset += 1000) {
    const rows = await db(env, `${path}&order=${order}&limit=1000&offset=${offset}`) as Array<Record<string, string | undefined>>;
    for (const row of rows || []) {
      const value = row[field];
      if (value) counts[value] = (counts[value] || 0) + 1;
    }
    if (!rows || rows.length < 1000) return counts;
  }
}

async function cycleQueueSummary(env: Env, cycleId: string) {
  const summary = { pending: 0, processing: 0, retryable: 0, failed: 0, completed: 0, exhausted: 0, superseded: 0 };
  for (let offset = 0; ; offset += 1000) {
    const rows = await db(env,
      `tourism_collection_cycle_items?select=status,attempts,max_attempts&cycle_id=eq.${encode(cycleId)}&order=id.asc&limit=1000&offset=${offset}`
    ) as Array<{ status: string; attempts: number; max_attempts: number }>;
    for (const item of rows || []) {
      if (item.status === 'pending') summary.pending++;
      else if (item.status === 'processing') summary.processing++;
      else if (item.status === 'completed') summary.completed++;
      else if (item.status === 'exhausted') summary.exhausted++;
      else if (item.status === 'superseded') summary.superseded++;
      else if (item.status === 'failed') {
        summary.failed++;
        if (item.attempts < item.max_attempts) summary.retryable++;
      }
    }
    if (!rows || rows.length < 1000) return summary;
  }
}

async function updateRun(env: Env, runId: string | undefined, values: Record<string, unknown>) {
  if (!runId) return;
  await db(env, `tourism_ingestion_runs?id=eq.${encode(runId)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      ...values,
      finished_at: values.status === 'running' ? null : new Date().toISOString(),
    }),
  });
}

async function getCity(env: Env, cityId: string): Promise<City | null> {
  const rows = await db(env,
    `tourism_cities?select=id,name,latitude,longitude,radius_km,collection_status,collection_discovered_at,collection_discovery_error,active_collection_cycle_id&id=eq.${encode(cityId)}&limit=1`
  ) as City[];
  return rows?.[0] || null;
}

function getDefaultRadius(env: Env, city: City): number {
  if (Number.isInteger(city.radius_km) && city.radius_km >= 10 && city.radius_km <= 150) return city.radius_km;
  const configured = Number(env.DEFAULT_RADIUS_KM);
  return Number.isInteger(configured) && configured >= 10 && configured <= 150 ? configured : 40;
}

async function readCycleStatus(env: Env, cycleId: string): Promise<string | null> {
  const rows = await db(env, `tourism_collection_cycles?select=status&id=eq.${encode(cycleId)}&limit=1`) as Array<{ status: string }>;
  return rows?.[0]?.status || null;
}

async function readCityStatus(env: Env, cityId: string): Promise<string | null> {
  const rows = await db(env, `tourism_cities?select=collection_status&id=eq.${encode(cityId)}&limit=1`) as Array<{ collection_status: string }>;
  return rows?.[0]?.collection_status || null;
}

async function runClaimedCycle(env: Env, cycle: CycleClaim) {
  let city: City | null;
  try {
    city = await getCity(env, cycle.city_id);
  } catch (error) {
    try {
      await db(env, 'rpc/release_tourism_collection_city_lease', {
        method: 'POST', body: JSON.stringify({ p_cycle_id: cycle.cycle_id, p_city_lease_token: cycle.lease_token }),
      });
    } catch { /* lease expiry remains the recovery path if the database is unavailable */ }
    throw error;
  }
  if (!city) {
    await db(env, 'rpc/release_tourism_collection_city_lease', {
      method: 'POST', body: JSON.stringify({ p_cycle_id: cycle.cycle_id, p_city_lease_token: cycle.lease_token }),
    });
    return json({ error: 'Claimed city was not found.' }, 404);
  }
  // Always use the immutable cycle radius, even if a city setting changes later.
  city.radius_km = cycle.radius_km;
  let runId: string | undefined;
  const errors: string[] = [];
  const discovered = { openstreetmap: 0, wikidata: 0 };
  let processed = 0;
  let wikipediaCount = 0;
  let finished = false;

  try {
    const runRows = await db(env, 'tourism_ingestion_runs', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify([{ city_id: city.id, radius_km: cycle.radius_km, status: 'running' }]),
    }) as Array<{ id: string }>;
    runId = runRows?.[0]?.id;

    if (cycle.cycle_status !== 'ready_to_finalize') {
      for (const sourceName of ['openstreetmap', 'wikidata'] as const) {
        let source = await claimSource(env, cycle, sourceName);
        if (!source) continue;
        try {
          let complete = false;
          for (let page = 0; page < MAX_DISCOVERY_PAGES_PER_SOURCE_PER_INVOCATION; page++) {
            const result = await discoverSourcePage(env, city, cycle, source);
            discovered[sourceName] += result.discovered;
            source = { ...source, cursor: result.cursor };
            if (result.complete) {
              complete = true;
              break;
            }
          }
          if (!complete) {
            await db(env, 'rpc/release_tourism_cycle_source', {
              method: 'POST',
              body: JSON.stringify({
                p_cycle_id: cycle.cycle_id,
                p_city_lease_token: cycle.lease_token,
                p_source_name: sourceName,
                p_source_lease_token: source.lease_token,
              }),
            });
          }
        } catch (error) {
          try {
            errors.push(`${sourceName}: ${await failSource(env, cycle, sourceName, source.lease_token!, error)}`);
          } catch (recordError) {
            errors.push(`${sourceName}: ${error instanceof Error ? error.message : String(error)}; retry state could not be recorded: ${recordError instanceof Error ? recordError.message : String(recordError)}`);
          }
        }
      }

      await renewLease(env, cycle);
      const claimed = await db(env, 'rpc/claim_tourism_cycle_items', {
        method: 'POST',
        body: JSON.stringify({
          p_cycle_id: cycle.cycle_id,
          p_city_lease_token: cycle.lease_token,
          p_limit: MAX_ITEMS_PER_INVOCATION,
          p_lease_seconds: LEASE_SECONDS,
        }),
      }) as QueueItem[];
      for (const item of claimed || []) {
        try {
          await renewLease(env, cycle, null, null, item.id, item.lease_token);
          const result = await processItem(env, city, cycle, item);
          processed++;
          wikipediaCount += result.wikipedia;
        } catch (error) {
          const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
          try {
            await db(env, 'rpc/fail_tourism_cycle_item', {
              method: 'POST',
              body: JSON.stringify({
                p_cycle_id: cycle.cycle_id,
                p_city_lease_token: cycle.lease_token,
                p_item_id: item.id,
                p_item_lease_token: item.lease_token,
                p_error: message,
              }),
            });
          } catch (recordError) {
            errors.push(`${item.id}: ${message}; item retry state could not be recorded: ${recordError instanceof Error ? recordError.message : String(recordError)}`);
            continue;
          }
          errors.push(`${item.id}: ${message}`);
        }
      }
    }

    const cycleStatus = await readCycleStatus(env, cycle.cycle_id);
    let collectionStatus = cycleStatus || 'processing';
    let retiredLinks = 0;
    if (cycleStatus === 'ready_to_finalize') {
      const result = await db(env, 'rpc/finish_tourism_collection_cycle', {
        method: 'POST',
        body: JSON.stringify({ p_cycle_id: cycle.cycle_id, p_city_lease_token: cycle.lease_token }),
      });
      retiredLinks = Number(result) || 0;
      finished = true;
      collectionStatus = await readCityStatus(env, city.id) || 'completed';
    }

    const summary = await cycleQueueSummary(env, cycle.cycle_id);
    const remaining = summary.pending + summary.processing + summary.retryable;
    const runStatus = collectionStatus === 'completed'
      ? 'completed'
      : collectionStatus === 'partial' || collectionStatus === 'failed' || collectionStatus === 'exhausted'
        ? (collectionStatus === 'failed' || collectionStatus === 'exhausted' ? 'failed' : 'partial')
        : 'running';
    await updateRun(env, runId, {
      status: runStatus,
      osm_count: discovered.openstreetmap,
      wikidata_count: discovered.wikidata,
      wikipedia_count: wikipediaCount,
      error_message: errors.join(' | ') || null,
    });

    return json({
      city: city.name,
      cycle_id: cycle.cycle_id,
      radius_km: cycle.radius_km,
      status: collectionStatus,
      discovered,
      processed,
      remaining,
      queue: summary,
      errors,
      retired_links: retiredLinks,
    });
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    await updateRun(env, runId, { status: 'failed', error_message: message });
    return json({ city: city.name, cycle_id: cycle.cycle_id, status: 'processing', error: message }, 502);
  } finally {
    if (!finished) {
      try {
        await db(env, 'rpc/release_tourism_collection_city_lease', {
          method: 'POST',
          body: JSON.stringify({ p_cycle_id: cycle.cycle_id, p_city_lease_token: cycle.lease_token }),
        });
      } catch {
        // An expired/stale lease is already fenced; the next batch claim recovers it.
      }
    }
  }
}

async function claimCityCycle(
  env: Env,
  city: City,
  requestedRadius: number | undefined,
  rediscover: boolean,
  confirmLegacyRadius: boolean,
): Promise<CycleClaim | null> {
  const radius = city.active_collection_cycle_id
    ? requestedRadius ?? null
    : requestedRadius ?? getDefaultRadius(env, city);
  const rows = await db(env, 'rpc/claim_tourism_collection_cycle', {
    method: 'POST',
    body: JSON.stringify({
      p_city_id: city.id,
      p_radius_km: radius,
      p_rediscover: rediscover,
      p_confirm_legacy_radius: confirmLegacyRadius,
      p_lease_seconds: LEASE_SECONDS,
      p_reconcile_links: false,
    }),
  }) as CycleClaim[];
  return rows?.[0] || null;
}

async function collectCity(
  env: Env,
  city: City,
  requestedRadius?: number,
  rediscover = false,
  confirmLegacyRadius = false,
) {
  try {
    const cycle = await claimCityCycle(env, city, requestedRadius, rediscover, confirmLegacyRadius);
    if (!cycle) return json({ error: 'City has no due collection work or is already complete.' }, 409);
    return await runClaimedCycle(env, cycle);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message }, /^Supabase 5\d\d/.test(message) ? 502 : 409);
  }
}

async function collectNextCity(env: Env) {
  const rows = await db(env, 'rpc/claim_next_tourism_collection_cycle', {
    method: 'POST',
    body: JSON.stringify({ p_lease_seconds: LEASE_SECONDS }),
  }) as CycleClaim[];
  const cycle = rows?.[0];
  if (!cycle) return json({ status: 'idle', message: 'No due city collection work.' });
  return runClaimedCycle(env, cycle);
}
function isAdmin(request: Request, env: Env) {
  const token = env.ADMIN_TOKEN;

  if (
    typeof token !== "string" ||
    !token.trim() ||
    token === "replace-with-a-long-random-secret" ||
    token === "undefined"
  ) {
    return false;
  }

  return request.headers.get("authorization") === `Bearer ${token}`;
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
    `tourism_city_places?select=distance_km,relevance_score,place:tourism_places!inner(id,canonical_name,category,subcategory,latitude,longitude,address,description,description_source,description_license,website_url,phone,wikipedia_url,image_url,image_author,image_license,review_status,sources:tourism_place_sources(source_name,source_id,source_url,attribution,license,payload))&city_id=eq.${encode(cityId)}&is_current=eq.true&place.review_status=eq.${status}&order=relevance_score.desc&limit=${limit}`,
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
      const diagnostic = { requestId: diagnosticRequestId(request), operation: "public_cities" as const };
      try {
        return json(
          await db(
            env,
            "tourism_cities?select=id,name,state_name,latitude,longitude,radius_km&is_enabled=eq.true&order=name.asc",
            {},
            diagnostic,
          ),
        );
      } catch (error) {
        emitDbDiagnostic(env, diagnostic, "request_failure", safeDatabaseDiagnostic(error));
        console.error("public_cities_upstream_failure", safeDatabaseDiagnostic(error));
        return json({ error: "Tourism data service unavailable." }, 502);
      }
    }
    if (url.pathname === "/public/places" && request.method === "GET") {
      const cityId = url.searchParams.get("city_id") || "";
      if (!UUID_RE.test(cityId)) return json({ error: "A valid city_id is required." }, 400);
      const limitValue = url.searchParams.get("limit") || "100";
      const offsetValue = url.searchParams.get("offset") || "0";
      if (!/^\d+$/.test(limitValue) || !/^\d+$/.test(offsetValue)) {
        return json({ error: "limit and offset must be whole numbers; limit is from 1 through 100 and offset is nonnegative." }, 400);
      }
      const requestedLimit = Number(limitValue);
      const offset = Number(offsetValue);
      if (!Number.isSafeInteger(offset) || offset > 100_000) {
        return json({ error: "offset must be a whole number from 0 through 100000." }, 400);
      }
      const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(100, requestedLimit)) : 100;
      let rows: unknown;
      const diagnostic = { requestId: diagnosticRequestId(request), operation: "public_places" as const };
      try {
        rows = await db(
          env,
          `tourism_city_places?select=distance_km,relevance_score,place:tourism_places!inner(id,canonical_name,category,subcategory,latitude,longitude,address,description,description_source,description_license,website_url,phone,wikipedia_url,image_url,image_source_url,image_author,image_license,historical_points,visiting_info,visit_duration_minutes,visit_duration_verified,visit_duration_source_url,importance_score,quality_score,review_status,route_ready,sources:tourism_place_sources(source_name,source_id,source_url,attribution,license,payload))&city_id=eq.${encode(cityId)}&is_current=eq.true&place.review_status=eq.approved&place.is_active=eq.true&order=place(importance_score).desc,relevance_score.desc&limit=${limit}&offset=${offset}`,
          {},
          diagnostic,
        );
      } catch (error) {
        emitDbDiagnostic(env, diagnostic, "request_failure", safeDatabaseDiagnostic(error));
        console.error("public_places_upstream_failure", safeDatabaseDiagnostic(error));
        return json({ error: "Tourism places service unavailable." }, 502);
      }
      const publicRows = (Array.isArray(rows) ? rows : []).map((row: any) => {
        const place = row?.place && typeof row.place === "object" ? row.place : {};
        const sources = Array.isArray(place.sources) ? place.sources : [];
        const areaClasses = new Set(
          sources
            .map((source: any) => source?.payload?.localise_stage?.area_class)
            .filter((value: unknown) => value === "core_hyderabad" || value === "nearby_escape_candidate"),
        );
        const areaClass = areaClasses.size === 1 ? [...areaClasses][0] : undefined;
        const taxonomyRecords = sources.flatMap((source: any) => {
          const savedTaxonomy = source?.payload?.localise_taxonomy;
          if (savedTaxonomy && Array.isArray(savedTaxonomy.categories)) return [savedTaxonomy];
          const tags = source?.payload?.tags;
          if (source?.source_name === 'openstreetmap' && tags && typeof tags === 'object' && !Array.isArray(tags)) {
            return [classifyTourismPlace({ place, tags, evidence: place.wikidata_id ? { wikidataId: place.wikidata_id } : {} })];
          }
          return [];
        });
        const categoriesFromSources: string[] = taxonomyRecords.flatMap((value: any) =>
          Array.isArray(value.categories) ? value.categories.filter((category: unknown): category is string => typeof category === 'string') : [],
        );
        const taxonomyCategories = [...new Set<string>(categoriesFromSources)];
        const escapeClassification = classifyTourismPlace({
          place,
          baseCategories: taxonomyCategories,
          evidence: place.wikidata_id ? { wikidataId: place.wikidata_id } : {},
          cityMembership: { distanceKm: Number(row?.distance_km), radiusKm: 150, outsideCityBoundary: areaClass === 'nearby_escape_candidate', tourismSignificanceVerified: Boolean(place.wikidata_id) },
        });
        if (escapeClassification.categories.includes('nearby_escapes')) taxonomyCategories.push('nearby_escapes');
        taxonomyCategories.sort();
        const foodFacetsFromSources: string[] = taxonomyRecords.flatMap((value: any) =>
          Array.isArray(value.foodFacets) ? value.foodFacets.filter((facet: unknown): facet is string => typeof facet === 'string') : [],
        );
        const foodFacets = [...new Set<string>(foodFacetsFromSources)].sort();
        const hasOsmTaxonomy = taxonomyRecords.length > 0;
        if (hasOsmTaxonomy && taxonomyRecords.every((value: any) => value.recommendationEligible === false)) return null;
        const publicSources = sources.map(({ payload: _payload, ...source }: any) => source);
        const isHttpsUrl = (value: unknown) => {
          if (typeof value !== "string") return false;
          try { return new URL(value).protocol === "https:"; } catch { return false; }
        };
        const historicalPoints = (Array.isArray(place.historical_points) ? place.historical_points : [])
          .filter((point: any) => typeof point?.text === "string" && point.text.trim().length > 0 && point.text.length <= 600 && isHttpsUrl(point.source_url))
          .slice(0, 5)
          .map((point: any) => ({ text: point.text, source_url: point.source_url }));
        const visitingInfo = place.visiting_info && typeof place.visiting_info === "object" && !Array.isArray(place.visiting_info)
          && place.visiting_info.verified === true && isHttpsUrl(place.visiting_info.source_url)
          ? place.visiting_info
          : {};
        const durationVerified = place.visit_duration_verified === true && Number.isInteger(place.visit_duration_minutes)
          && place.visit_duration_minutes > 0 && place.visit_duration_minutes <= 1440 && isHttpsUrl(place.visit_duration_source_url);
        const publicPlace = {
          ...place,
          ...(hasOsmTaxonomy ? {
            taxonomy_categories: taxonomyCategories,
            food_facets: foodFacets,
            recommendation_eligible: taxonomyRecords.some((value: any) => value.recommendationEligible === true),
          } : {}),
          historical_points: historicalPoints,
          visiting_info: visitingInfo,
          visit_duration_verified: durationVerified,
          route_ready: place.route_ready === true,
          sources: publicSources,
        };
        if (!publicPlace.image_author || !publicPlace.image_license || !isHttpsUrl(publicPlace.image_source_url) || !isHttpsUrl(publicPlace.image_url)) {
          delete publicPlace.image_url;
          delete publicPlace.image_source_url;
        }
        if (!durationVerified) {
          publicPlace.visit_duration_minutes = null;
          publicPlace.visit_duration_source_url = null;
        }
        return { ...row, ...(areaClass ? { area_class: areaClass } : {}), place: publicPlace };
      });
      return json(publicRows.filter(Boolean));
    }

    if (!isAdmin(request, env)) return json({ error: "Unauthorized" }, 401);

    if (url.pathname === "/admin/promote-offline-pbf" && request.method === "POST") {
      const actor = str(env.ADMIN_ACTOR_ID);
      if (!actor) return json({ error: "Promotion audit actor is not configured." }, 503);
      let body: unknown;
      try {
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > 250_000) return json({ error: "Promotion body exceeds 250 KB." }, 413);
        body = JSON.parse(raw);
      } catch {
        return json({ error: "Request body must be valid JSON." }, 400);
      }
      const validation = validatePromotionRequest(body);
      if (!validation.ok) return json({ error: validation.error }, 400);
      try {
        const result = await db(env, "rpc/promote_offline_pbf_records", {
          method: "POST",
          body: JSON.stringify({
            p_idempotency_key: validation.value.idempotency_key,
            p_snapshot_id: validation.value.snapshot_id,
            p_city_id: validation.value.city_id,
            p_approval_reference: validation.value.approval_reference,
            p_approved_by: actor,
            p_records: validation.value.records,
          }),
        });
        return json(result);
      } catch (error: unknown) {
        const unavailable = error instanceof TypeError || /^Supabase 5\d\d/.test(String((error as Error)?.message || ""));
        return json({ error: unavailable ? "Promotion service unavailable." : "Promotion rejected; no records were published." }, unavailable ? 502 : 409);
      }
    }

    if (url.pathname === "/admin/rollback-offline-pbf-publication" && request.method === "POST") {
      const actor = str(env.ADMIN_ACTOR_ID);
      if (!actor) return json({ error: "Promotion audit actor is not configured." }, 503);
      let body: unknown;
      try {
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > 16_000) return json({ error: "Rollback body exceeds 16 KB." }, 413);
        body = JSON.parse(raw);
      } catch {
        return json({ error: "Request body must be valid JSON." }, 400);
      }
      const validation = validatePublicationRollback(body);
      if (!validation.ok) return json({ error: validation.error }, 400);
      try {
        const result = await db(env, "rpc/rollback_offline_pbf_publication", {
          method: "POST",
          body: JSON.stringify({
            p_idempotency_key: validation.value.idempotency_key,
            p_rollback_reference: validation.value.rollback_reference,
            p_rolled_back_by: actor,
          }),
        });
        return json(result);
      } catch (error: unknown) {
        const unavailable = error instanceof TypeError || /^Supabase 5\d\d/.test(String((error as Error)?.message || ""));
        return json({ error: unavailable ? "Publication rollback service unavailable." : "Rollback rejected; current record state was preserved." }, unavailable ? 502 : 409);
      }
    }

    if (url.pathname === "/admin/stats" && request.method === "GET") {
      const [cities, places, runs, cycles, queue, discovery, legacyQueue] = await Promise.all([
        countStatuses(env, 'tourism_cities?select=collection_status', 'collection_status'),
        countStatuses(env, 'tourism_places?select=review_status', 'review_status'),
        countStatuses(env, 'tourism_ingestion_runs?select=status', 'status'),
        countStatuses(env, 'tourism_collection_cycles?select=status', 'status'),
        countStatuses(env, 'tourism_collection_cycle_items?select=status', 'status'),
        countStatuses(env, 'tourism_collection_cycle_sources?select=status', 'status', 'cycle_id.asc,source_name.asc'),
        countStatuses(env, 'tourism_collection_items?select=status', 'status'),
      ]);
      return json({ cities, places, runs, cycles, queue, discovery, legacy_queue: legacyQueue });
    }
    if (url.pathname === "/admin/review" && request.method === "GET") {
      return reviewPlaces(request, env, url);
    }
    if (url.pathname === "/admin/import-offline-pbf/finalize" && request.method === "POST") {
      let body: any;
      try { body = await request.json(); } catch { return json({ error: "Request body must be valid JSON." }, 400); }
      if (typeof body?.snapshot_id !== "string" || body.snapshot_id.length < 16 || body.snapshot_id.length > 160) {
        return json({ error: "A valid snapshot_id is required." }, 400);
      }
      try {
        const result = await db(env, "rpc/finalize_offline_pbf_import", {
          method: "POST",
          body: JSON.stringify({ p_snapshot_id: body.snapshot_id }),
        });
        return json(result);
      } catch (error: any) {
        const message = error?.message || "Offline PBF finalization failed.";
        return json({ error: message }, /^Supabase 5\d\d/.test(message) || error instanceof TypeError ? 502 : 409);
      }
    }
    if (url.pathname === "/admin/import-offline-pbf" && request.method === "POST") {
      let body: any;
      try {
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > 1_500_000) return json({ error: "Batch body exceeds 1.5 MB." }, 413);
        body = JSON.parse(raw);
      } catch {
        return json({ error: "Request body must be valid JSON." }, 400);
      }
      const records = body?.records;
      if (!Array.isArray(records) || records.length < 1 || records.length > 500 ||
          typeof body.snapshot_id !== "string" || typeof body.source_snapshot !== "string" ||
          !/^[0-9a-f]{64}$/.test(body.source_checksum || "") ||
          body.snapshot_id !== `sha256:${body.source_checksum}` ||
          !Number.isInteger(body.expected_total) || body.expected_total < records.length || body.expected_total > 100_000) {
        return json({ error: "Invalid snapshot metadata or batch size." }, 400);
      }
      for (const record of records as PbfStageRecord[]) {
        if (!record || typeof record !== "object" || Array.isArray(record)) {
          return json({ error: "Invalid offline PBF record: invalid_record" }, 400);
        }
        const mapped = mapPbfStageRecord(record, { latitude: 17.385, longitude: 78.4867 }, 150);
        if (!mapped.accepted && mapped.reason !== "missing_name") {
          return json({ error: `Invalid offline PBF record: ${mapped.reason}` }, 400);
        }
      }
      try {
        const result = await db(env, "rpc/import_offline_pbf_batch", {
          method: "POST",
          body: JSON.stringify({
            p_snapshot_id: body.snapshot_id,
            p_source_snapshot: body.source_snapshot,
            p_source_checksum: body.source_checksum,
            p_expected_total: body.expected_total,
            p_records: records,
          }),
        });
        return json(result);
      } catch (error: any) {
        const message = error?.message || "Offline PBF import failed.";
        const status = /^Supabase 5\d\d/.test(message) || error instanceof TypeError ? 502 :
          /conflict|immutable|snapshot count mismatch/i.test(message) ? 409 : 400;
        return json({ error: message }, status);
      }
    }
    const reviewMatch = url.pathname.match(/^\/admin\/review\/([0-9a-f-]+)$/i);
    if (reviewMatch && request.method === "POST") {
      return updateReview(request, env, reviewMatch[1]);
    }
    if (url.pathname === "/admin/collect" && request.method === "POST") {
      if (url.searchParams.has('radiusKm') || url.searchParams.get('rediscover') === 'true') {
        return json({ error: 'Set radiusKm or rediscover on /admin/collect-city/{city_id}; automatic batching uses each city’s persisted radius.' }, 400);
      }
      try {
        return await collectNextCity(env);
      } catch (error: any) {
        return json({ error: error.message }, 502);
      }
    }
    const collectMatch = url.pathname.match(/^\/admin\/collect-city\/([0-9a-f-]+)$/i);
    if (collectMatch && request.method === "POST") {
      let requestedRadius: number | undefined;
      try {
        requestedRadius = parseRadius(url.searchParams.get("radiusKm"));
      } catch (error: any) {
        return json({ error: error.message }, 400);
      }
      const city = await getCity(env, collectMatch[1]);
      if (!city) return json({ error: "City not found." }, 404);
      return collectCity(
        env,
        city,
        requestedRadius,
        url.searchParams.get('rediscover') === 'true',
        url.searchParams.get('confirmLegacyRadius') === 'true',
      );
    }
    return json({ error: "Not found" }, 404);
  },
};
