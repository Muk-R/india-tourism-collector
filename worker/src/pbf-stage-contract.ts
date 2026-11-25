import { distanceKm, scoreImportance } from "./index.ts";

const SOURCE_TYPES = new Set(["node", "way", "relation"]);
const CATEGORIES = new Set(["attraction", "accommodation", "food", "transport"]);
const OSM_ATTRIBUTION = "© OpenStreetMap contributors";
const OSM_LICENSE = "ODbL-1.0";

export interface PbfStageRecord {
  source_type: string;
  source_id: number;
  source_key: string;
  name: string | null;
  categories: string[];
  latitude: number;
  longitude: number;
  distance_km: number;
  area_class: "core_hyderabad" | "nearby_escape_candidate";
  importance_evidence_score: number;
  importance_signals: string[];
  raw_tags: Record<string, string>;
  geometry_method: string;
  source_url: string;
  attribution: string;
  license: string;
  source_snapshot: string;
  data_status: string;
  itinerary_ready: number | boolean;
}

export interface OfflineOsmCandidate {
  source_id: string;
  raw_payload: Record<string, unknown>;
  priority_score: number;
  priority_reasons: string[];
}

export type PbfStageMapping =
  | { accepted: true; candidate: OfflineOsmCandidate }
  | { accepted: false; reason: string };

export function mapPbfStageRecord(
  record: PbfStageRecord,
  city: { latitude: number; longitude: number },
  radiusKm: number,
): PbfStageMapping {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { accepted: false, reason: "invalid_record" };
  }
  if (!Number.isInteger(radiusKm) || radiusKm < 10 || radiusKm > 150) {
    return { accepted: false, reason: "invalid_cycle_radius" };
  }
  if (
    !Number.isFinite(city.latitude) || city.latitude < -90 || city.latitude > 90 ||
    !Number.isFinite(city.longitude) || city.longitude < -180 || city.longitude > 180
  ) return { accepted: false, reason: "invalid_city_center" };
  if (!SOURCE_TYPES.has(record.source_type) || !Number.isSafeInteger(record.source_id) || record.source_id <= 0) {
    return { accepted: false, reason: "invalid_source_identity" };
  }
  const sourceId = `${record.source_type}/${record.source_id}`;
  if (record.source_key !== sourceId) return { accepted: false, reason: "source_key_mismatch" };
  if (record.name !== null && typeof record.name !== "string") return { accepted: false, reason: "invalid_name" };
  if (!record.name?.trim()) return { accepted: false, reason: "missing_name" };
  if (!record.raw_tags || typeof record.raw_tags !== "object" || Array.isArray(record.raw_tags)) {
    return { accepted: false, reason: "invalid_raw_tags" };
  }
  if (!Array.isArray(record.categories) || !record.categories.length || record.categories.some((value) => !CATEGORIES.has(value))) {
    return { accepted: false, reason: "invalid_categories" };
  }
  if (
    !Number.isFinite(record.latitude) || record.latitude < -90 || record.latitude > 90 ||
    !Number.isFinite(record.longitude) || record.longitude < -180 || record.longitude > 180
  ) return { accepted: false, reason: "invalid_coordinates" };
  if (record.data_status !== "needs_review" || record.itinerary_ready !== 0 && record.itinerary_ready !== false) {
    return { accepted: false, reason: "candidate_is_not_review_only" };
  }
  if (record.attribution !== OSM_ATTRIBUTION || record.license !== OSM_LICENSE || !record.source_snapshot) {
    return { accepted: false, reason: "missing_source_provenance" };
  }
  if (record.source_url !== `https://www.openstreetmap.org/${sourceId}`) {
    return { accepted: false, reason: "source_url_mismatch" };
  }

  const exactDistance = distanceKm(city.latitude, city.longitude, record.latitude, record.longitude);
  if (exactDistance > radiusKm + 0.001) return { accepted: false, reason: "outside_cycle_radius" };
  const expectedArea = exactDistance <= 40 ? "core_hyderabad" : "nearby_escape_candidate";
  if (record.area_class !== expectedArea) return { accepted: false, reason: "area_class_mismatch" };
  if (expectedArea === "nearby_escape_candidate" && !record.categories.includes("attraction")) {
    return { accepted: false, reason: "extended_record_is_not_an_attraction" };
  }
  if (
    !Number.isFinite(record.distance_km) || Math.abs(exactDistance - record.distance_km) > 0.001 ||
    !Number.isInteger(record.importance_evidence_score) || record.importance_evidence_score < 0 || record.importance_evidence_score > 10 ||
    !Array.isArray(record.importance_signals) || typeof record.geometry_method !== "string"
  ) return { accepted: false, reason: "invalid_staging_evidence" };

  const rawPayload = {
    type: record.source_type,
    id: record.source_id,
    lat: record.latitude,
    lon: record.longitude,
    tags: { ...record.raw_tags },
    localise_stage: {
      source_key: sourceId,
      source_url: record.source_url,
      source_snapshot: record.source_snapshot,
      attribution: record.attribution,
      license: record.license,
      geometry_method: record.geometry_method,
      area_class: record.area_class,
      distance_km: record.distance_km,
      categories: [...record.categories],
      importance_evidence_score: record.importance_evidence_score,
      importance_signals: [...record.importance_signals],
    },
  };
  const importance = scoreImportance("openstreetmap", rawPayload);
  return {
    accepted: true,
    candidate: {
      source_id: sourceId,
      raw_payload: rawPayload,
      priority_score: importance.score,
      priority_reasons: importance.reasons,
    },
  };
}
