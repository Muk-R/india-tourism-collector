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
