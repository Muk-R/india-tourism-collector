/**
 * OSM tourism discovery and source-evidence normalization.
 *
 * Callers provide persisted geographic tiles and keep their own resumable cursor,
 * retries, and cycle leases. Queries deliberately have no result cap so callers
 * can subdivide overloaded tiles without silently dropping discoveries.
 */

export type BoundingBox = {
  south: number;
  west: number;
  north: number;
  east: number;
};

export type DiscoveryTile = {
  id: string;
  bounds: BoundingBox;
  depth: number;
};

/** JSON-serializable progress that callers can persist between collection calls. */
export type TileCursor = {
  version: 1;
  pending: DiscoveryTile[];
  completed: string[];
};

export class TileSubdivisionRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TileSubdivisionRequiredError";
  }
}

export type DiscoveryKind = "attractions" | "lodging" | "restaurants";

export type OSMElement = {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, unknown>;
};

export type SourceEvidence = {
  source_name: "openstreetmap";
  source_id: string;
  source_url: string;
  attribution: "© OpenStreetMap contributors";
  license: "ODbL";
  payload: OSMElement;
};

export type TourismCandidate = {
  source_id: string;
  name: string;
  latitude: number;
  longitude: number;
  category: string;
  subcategory?: string;
  evidence: SourceEvidence;
  accommodation_type?: string;
  star_rating?: number;
  budget_tier: "budget" | "mid_tier" | "premium" | null;
  cuisine_types: string[];
  dietary_classification: "vegetarian" | "non_vegetarian" | "unknown";
  importance_score: number;
  importance_reasons: string[];
};

const TAG_FILTERS: Record<DiscoveryKind, string[]> = {
  attractions: [
    '["tourism"~"attraction|museum|gallery|viewpoint|theme_park|zoo|aquarium|artwork|information"]',
    '["historic"]["historic"!="no"]',
    '["amenity"="place_of_worship"]',
    '["leisure"~"park|garden"]',
    '["natural"~"waterfall|beach|cave|peak|hot_spring|volcano|glacier|geyser|cliff|rock"]',
    '["waterway"="waterfall"]',
  ],
  lodging: [
    '["tourism"~"hotel|motel|guest_house|hostel|chalet|alpine_hut|camp_site|caravan_site|apartment"]',
  ],
  restaurants: [
    '["amenity"~"restaurant|cafe|fast_food|food_court|pub|bar|ice_cream|canteen"]',
  ],
};

export function validateBoundingBox(box: BoundingBox): void {
  if (
    ![box.south, box.west, box.north, box.east].every(Number.isFinite) ||
    box.south < -90 || box.north > 90 || box.west < -180 || box.east > 180 ||
    box.south >= box.north || box.west >= box.east
  ) {
    throw new Error("Invalid OSM tile bounds.");
  }
}

/** Split a geographic tile into four deterministic children. Shared edges are
 * intentional; stable source IDs let the caller deduplicate boundary results.
 */
export function subdivideBoundingBox(box: BoundingBox): BoundingBox[] {
  validateBoundingBox(box);
  const midLat = (box.south + box.north) / 2;
  const midLon = (box.west + box.east) / 2;
  return [
    { south: box.south, west: box.west, north: midLat, east: midLon },
    { south: box.south, west: midLon, north: midLat, east: box.east },
    { south: midLat, west: box.west, north: box.north, east: midLon },
    { south: midLat, west: midLon, north: box.north, east: box.east },
  ];
}

export function createTileCursor(bounds: BoundingBox): TileCursor {
  validateBoundingBox(bounds);
  return { version: 1, pending: [{ id: "0", bounds, depth: 0 }], completed: [] };
}

/** Replace an overloaded pending tile with children without losing cursor state. */
export function subdividePendingTile(cursor: TileCursor, tileId: string, maxDepth = 8): TileCursor {
  if (cursor.version !== 1 || !Array.isArray(cursor.pending) || !Array.isArray(cursor.completed)) {
    throw new Error("Invalid discovery cursor.");
  }
  const index = cursor.pending.findIndex((tile) => tile.id === tileId);
  if (index < 0) throw new Error(`Pending tile not found: ${tileId}`);
  const tile = cursor.pending[index];
  if (!Number.isInteger(tile.depth) || tile.depth < 0) throw new Error(`Pending tile ${tileId} has an invalid depth.`);
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || tile.depth >= maxDepth) {
    throw new TileSubdivisionRequiredError(`Tile ${tileId} remains too large at subdivision depth ${tile.depth}.`);
  }
  const children = subdivideBoundingBox(tile.bounds).map((bounds, childIndex) => ({
    id: `${tile.id}.${childIndex}`,
    bounds,
    depth: tile.depth + 1,
  }));
  return {
    ...cursor,
    pending: [...cursor.pending.slice(0, index), ...children, ...cursor.pending.slice(index + 1)],
  };
}

/** Advance a persisted cursor only after the caller has handled a tile result. */
export function completePendingTile(cursor: TileCursor, tileId: string): TileCursor {
  if (cursor.version !== 1 || !Array.isArray(cursor.pending) || !Array.isArray(cursor.completed)) {
    throw new Error("Invalid discovery cursor.");
  }
  if (cursor.completed.includes(tileId)) return cursor;
  const pending = cursor.pending.filter((tile) => tile.id !== tileId);
  if (pending.length === cursor.pending.length) throw new Error(`Pending tile not found: ${tileId}`);
  return { ...cursor, pending, completed: [...cursor.completed, tileId] };
}

function retryAfterMs(value: string | null, now: number, maximum: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1000
    : Date.parse(value) - now;
  return Number.isFinite(delay) && delay >= 0 ? Math.min(delay, maximum) : undefined;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/** Fetch one Overpass tile with bounded retries and an abort timeout. The
 * injected dependencies keep this deterministic in tests and offline tooling.
 */
export async function fetchOverpassTile(
  kind: DiscoveryKind,
  bounds: BoundingBox,
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    sleep?: (milliseconds: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<OSMElement[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 45_000;
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isInteger(maxRetries) || maxRetries < 0 ||
      !Number.isFinite(baseDelayMs) || baseDelayMs < 0 || !Number.isFinite(maxDelayMs) || maxDelayMs < 0) {
    throw new Error("Invalid Overpass retry or timeout configuration.");
  }
  const query = buildOverpassQuery(kind, bounds);
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let retryDelay: number | undefined;
    try {
      const response = await fetchImpl("https://overpass-api.de/api/interpreter", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
        body: new URLSearchParams({ data: query }),
        signal: controller.signal,
      });
      if (!response.ok) {
        if (!isRetryableStatus(response.status)) throw new Error(`Overpass returned HTTP ${response.status}.`);
        retryDelay = retryAfterMs(response.headers.get("Retry-After"), now(), maxDelayMs);
        throw new Error(`Overpass returned retryable HTTP ${response.status}.`);
      }
      const payload = await response.json() as { elements?: unknown; remark?: unknown };
      if (typeof payload.remark === "string" && /timed out|runtime error|query too large/i.test(payload.remark)) {
        throw new TileSubdivisionRequiredError(`Overpass could not complete tile: ${payload.remark}`);
      }
      if (!Array.isArray(payload.elements)) throw new Error("Overpass response did not include an elements array.");
      return payload.elements as OSMElement[];
    } catch (error) {
      if (error instanceof TileSubdivisionRequiredError) throw error;
      lastError = error;
      if (attempt >= maxRetries) break;
      const retryable = error instanceof Error && (
        error instanceof TypeError ||
        error.name === "AbortError" || error.name === "TimeoutError" ||
        error.message.startsWith("Overpass returned retryable HTTP") ||
        error.message === "fetch failed"
      );
      if (!retryable) throw error;
      await sleep(retryDelay ?? Math.min(baseDelayMs * (2 ** attempt), maxDelayMs));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Overpass tile failed after ${maxRetries + 1} attempts: ${String(lastError)}`);
}

export function buildOverpassQuery(kind: DiscoveryKind, box: BoundingBox): string {
  validateBoundingBox(box);
  const filters = TAG_FILTERS[kind];
  if (!filters) throw new Error(`Unsupported discovery kind: ${kind}`);
  const bounds = `${box.south},${box.west},${box.north},${box.east}`;
  const selectors = filters.map((filter) => `nwr(${bounds})${filter};`).join("");
  return `[out:json][timeout:45];(${selectors});out center tags;`;
}

function tagString(tags: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = tags[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function sourceStarRating(tags: Record<string, unknown>): number | undefined {
  const raw = tagString(tags, "stars");
  if (!raw || !/^\d+(?:\.\d+)?$/.test(raw)) return undefined;
  const rating = Number(raw);
  return Number.isFinite(rating) && rating >= 1 && rating <= 5 ? rating : undefined;
}

function explicitDiet(tags: Record<string, unknown>): TourismCandidate["dietary_classification"] {
  const raw = tagString(tags, "diet:vegetarian")?.toLowerCase();
  if (raw === "yes" || raw === "only") return "vegetarian";
  if (raw === "no") return "non_vegetarian";
  return "unknown";
}

function cuisineTypes(tags: Record<string, unknown>): string[] {
  const raw = tagString(tags, "cuisine");
  if (!raw) return [];
  return [...new Set(raw.split(/[;,]/).map((value) => value.trim()).filter(Boolean))];
}

function categoryFor(kind: DiscoveryKind, tags: Record<string, unknown>): string {
  if (kind === "lodging") return "accommodation";
  if (kind === "restaurants") return "restaurant";
  const historic = tagString(tags, "historic")?.toLowerCase();
  if (historic && historic !== "no") return historic === "yes" ? "historic_site" : historic;
  const tourism = tagString(tags, "tourism")?.toLowerCase();
  if (tourism && tourism !== "yes" && tourism !== "no") return tourism;
  if (tagString(tags, "amenity")?.toLowerCase() === "place_of_worship") return "religious_site";
  const leisure = tagString(tags, "leisure")?.toLowerCase();
  if (leisure && leisure !== "yes" && leisure !== "no") return leisure;
  const natural = tagString(tags, "natural")?.toLowerCase();
  if (natural && natural !== "yes" && natural !== "no") return natural;
  if (tagString(tags, "waterway")?.toLowerCase() === "waterfall") return "waterfall";
  return "attraction";
}

export function scoreImportance(kind: DiscoveryKind, tags: Record<string, unknown>): {
  score: number;
  reasons: string[];
} {
  if (kind !== "attractions") return { score: 0, reasons: [] };
  const reasons: string[] = [];
  let score = 45;
  if (tags.heritage || tags["heritage:operator"] || tags["ref:whc"]) {
    score = Math.max(score, 96);
    reasons.push("heritage_designation");
  }
  if (tags.historic && tags.historic !== "yes" && tags.historic !== "no") {
    score = Math.max(score, 84);
    reasons.push("historic_attraction");
  } else if (tags.historic === "yes") {
    score = Math.max(score, 72);
    reasons.push("historic_site");
  }
  if (tags.natural === "waterfall" || tags.waterway === "waterfall") {
    score = Math.max(score, 78);
    reasons.push("waterfall");
  }
  if (tags.natural === "peak" || tags.natural === "volcano") {
    score = Math.max(score, 76);
    reasons.push("mountain_or_peak");
  }
  if (["glacier", "geyser", "cliff", "rock"].includes(String(tags.natural))) {
    score = Math.max(score, 76);
    reasons.push("notable_natural_feature");
  }
  if (tags.tourism === "viewpoint") {
    score = Math.max(score, 74);
    reasons.push("viewpoint");
  }
  if (tags.tourism && tags.tourism !== "yes") {
    score = Math.max(score, 64);
    reasons.push("tourism_feature");
  }
  if (!reasons.length) reasons.push("named_osm_feature");
  return { score: Math.min(100, score), reasons };
}

/** Normalize a single tile result while retaining the complete upstream object. */
export function normalizeOsmCandidate(
  kind: DiscoveryKind,
  element: OSMElement,
): TourismCandidate | null {
  if (!element || !["node", "way", "relation"].includes(element.type) || !Number.isInteger(element.id)) return null;
  const tags = element.tags || {};
  const name = tagString(tags, "name", "name:en", "name:hi");
  const latitude = element.lat ?? element.center?.lat;
  const longitude = element.lon ?? element.center?.lon;
  if (
    !name || !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
    (latitude as number) < -90 || (latitude as number) > 90 ||
    (longitude as number) < -180 || (longitude as number) > 180
  ) return null;

  const sourceId = `${element.type}/${element.id}`;
  const importance = scoreImportance(kind, tags);
  const type = tagString(tags, "tourism", "amenity", "historic", "natural", "leisure");
  return {
    source_id: sourceId,
    name,
    latitude: latitude as number,
    longitude: longitude as number,
    category: categoryFor(kind, tags),
    ...(type && type !== "yes" && type !== "no" ? { subcategory: type } : {}),
    evidence: {
      source_name: "openstreetmap",
      source_id: sourceId,
      source_url: `https://www.openstreetmap.org/${sourceId}`,
      attribution: "© OpenStreetMap contributors",
      license: "ODbL",
      payload: element,
    },
    accommodation_type: kind === "lodging" ? tagString(tags, "tourism") : undefined,
    star_rating: kind === "lodging" ? sourceStarRating(tags) : undefined,
    // OSM has no consistent evidence for price tier. Keep this unknown.
    budget_tier: null,
    cuisine_types: kind === "restaurants" ? cuisineTypes(tags) : [],
    dietary_classification: kind === "restaurants" ? explicitDiet(tags) : "unknown",
    importance_score: importance.score,
    importance_reasons: importance.reasons,
  };
}

/** Deduplicate a tile or page by stable OSM type/id while preserving source records. */
export function deduplicateCandidates(candidates: Array<TourismCandidate | null>): TourismCandidate[] {
  const unique = new Map<string, TourismCandidate>();
  for (const candidate of candidates) {
    if (candidate) unique.set(candidate.source_id, candidate);
  }
  return [...unique.values()];
}
