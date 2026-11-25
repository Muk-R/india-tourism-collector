import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.ts";

const env = {
  SUPABASE_URL: "https://database.example",
  SUPABASE_SECRET_KEY: "sb_secret_test_only",
  ADMIN_TOKEN: "test-admin-token",
};
const snapshot = "2026-11-23T21:21:17Z";
const record = {
  source_type: "node", source_id: 123, source_key: "node/123", name: null,
  categories: ["attraction"], latitude: 17.385, longitude: 78.4867, distance_km: 0,
  area_class: "core_hyderabad", importance_evidence_score: 2, importance_signals: [],
  raw_tags: { tourism: "attraction" }, geometry_method: "node_coordinate",
  source_url: "https://www.openstreetmap.org/node/123", attribution: "© OpenStreetMap contributors",
  license: "ODbL-1.0", source_snapshot: snapshot, data_status: "needs_review", itinerary_ready: 0,
};
const body = {
  snapshot_id: `sha256:${"a".repeat(64)}`, source_snapshot: snapshot,
  source_checksum: "a".repeat(64), expected_total: 1, records: [record],
};

test("offline PBF import requires admin authentication", async () => {
  const response = await worker.fetch(new Request("https://collector.test/admin/import-offline-pbf", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), env);
  assert.equal(response.status, 401);
});

test("offline PBF import sends validated named and quarantine candidates only to private RPC", async () => {
  const originalFetch = globalThis.fetch;
  let rpcUrl = "";
  let rpcBody;
  globalThis.fetch = async (input, init) => {
    rpcUrl = String(input);
    rpcBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify([{ inserted_count: 1, existing_count: 0, review_only_count: 0, quarantine_count: 1 }]), { status: 200 });
  };
  try {
    const response = await worker.fetch(new Request("https://collector.test/admin/import-offline-pbf", {
      method: "POST", headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }), env);
    assert.equal(response.status, 200);
    assert.equal(rpcUrl, "https://database.example/rest/v1/rpc/import_offline_pbf_batch");
    assert.equal(rpcBody.p_records[0].name, null);
    assert.equal(rpcBody.p_records[0].itinerary_ready, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("offline PBF import refuses itinerary-ready candidates before persistence", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("RPC must not be called"); };
  try {
    const response = await worker.fetch(new Request("https://collector.test/admin/import-offline-pbf", {
      method: "POST", headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, records: [{ ...record, name: "Invented", itinerary_ready: 1 }] }),
    }), env);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /candidate_is_not_review_only/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("offline PBF import rejects malformed JSON record shapes without throwing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("RPC must not be called"); };
  try {
    for (const malformed of [null, [], { ...record, name: 42 }]) {
      const response = await worker.fetch(new Request("https://collector.test/admin/import-offline-pbf", {
        method: "POST", headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, records: [malformed] }),
      }), env);
      assert.equal(response.status, 400);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
