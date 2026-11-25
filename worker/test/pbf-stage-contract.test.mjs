import assert from "node:assert/strict";
import test from "node:test";
import { mapPbfStageRecord } from "../src/pbf-stage-contract.ts";

const city = { latitude: 17.385, longitude: 78.4867 };

function stageRecord(overrides = {}) {
  return {
    source_type: "way",
    source_id: 123,
    source_key: "way/123",
    name: "Remote Waterfall",
    categories: ["attraction"],
    latitude: 17.835,
    longitude: 78.4867,
    distance_km: 50.0377,
    area_class: "nearby_escape_candidate",
    importance_evidence_score: 4,
    importance_signals: ["named_natural_feature_tag"],
    raw_tags: { name: "Remote Waterfall", natural: "waterfall", tourism: "attraction" },
    geometry_method: "polygon_interior_point",
    source_url: "https://www.openstreetmap.org/way/123",
    attribution: "© OpenStreetMap contributors",
    license: "ODbL-1.0",
    source_snapshot: "2026-11-23T21:21:17Z",
    data_status: "needs_review",
    itinerary_ready: 0,
    ...overrides,
  };
}

test("maps a review-only extended OSM feature into the Worker discovery contract", () => {
  const result = mapPbfStageRecord(stageRecord(), city, 150);
  assert.equal(result.accepted, true);
  assert.equal(result.candidate.source_id, "way/123");
  assert.equal(result.candidate.raw_payload.type, "way");
  assert.equal(result.candidate.raw_payload.id, 123);
  assert.deepEqual(result.candidate.raw_payload.tags, stageRecord().raw_tags);
  assert.equal(result.candidate.raw_payload.localise_stage.area_class, "nearby_escape_candidate");
  assert.equal(result.candidate.raw_payload.localise_stage.license, "ODbL-1.0");
  assert.ok(result.candidate.priority_score > 0);
  assert.ok(result.candidate.priority_reasons.includes("waterfall"));
  assert.equal("description" in result.candidate.raw_payload, false);
  assert.equal("image_url" in result.candidate.raw_payload, false);
});

test("keeps valid names and rejects unnamed records rather than inventing a display name", () => {
  const result = mapPbfStageRecord(stageRecord({ name: null }), city, 150);
  assert.deepEqual(result, { accepted: false, reason: "missing_name" });
});

test("rejects records outside the persisted radius or inconsistent with core/extended separation", () => {
  const outside = mapPbfStageRecord(stageRecord({ latitude: 19.0, distance_km: 179.6 }), city, 150);
  assert.equal(outside.accepted, false);
  assert.equal(outside.reason, "outside_cycle_radius");

  const nonAttraction = mapPbfStageRecord(stageRecord({ categories: ["food"] }), city, 150);
  assert.equal(nonAttraction.accepted, false);
  assert.equal(nonAttraction.reason, "extended_record_is_not_an_attraction");
});

test("rejects identity, license and review-state mismatches before queue persistence", () => {
  assert.equal(mapPbfStageRecord(stageRecord({ source_key: "node/123" }), city, 150).reason, "source_key_mismatch");
  assert.equal(mapPbfStageRecord(stageRecord({ license: "unknown" }), city, 150).reason, "missing_source_provenance");
  assert.equal(mapPbfStageRecord(stageRecord({ itinerary_ready: 1 }), city, 150).reason, "candidate_is_not_review_only");
  assert.equal(mapPbfStageRecord(stageRecord(), city, 151).reason, "invalid_cycle_radius");
});
