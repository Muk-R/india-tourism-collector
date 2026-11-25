import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.ts";

const env = {
  SUPABASE_URL: "https://database.example",
  SUPABASE_SECRET_KEY: "sb_secret_test_only",
  ADMIN_TOKEN: "test-admin-token",
  ADMIN_ACTOR_ID: "owner-test-fixture",
};
const body = {
  idempotency_key: "hyd-pilot-phase-1-test-0001",
  snapshot_id: `sha256:${"a".repeat(64)}`,
  city_id: "11111111-1111-4111-8111-111111111111",
  approval_reference: "test approval fixture 1",
  records: [{
    source_key: "way/238186115",
    category: "attraction",
    decision: "approve_browse_only",
    importance_score: 95,
    importance_rationale: "Source-backed landmark significance for isolated fixture.",
    importance_source_url: "https://hyderabad.telangana.gov.in/tourist-place/charminar/",
  }],
};

async function post(path, payload, headers = {}) {
  return worker.fetch(new Request(`https://collector.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  }), env);
}

test("offline promotion requires admin authentication before database access", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("database must not be called"); };
  try {
    const response = await post("/admin/promote-offline-pbf", body);
    assert.equal(response.status, 401);
  } finally { globalThis.fetch = originalFetch; }
});

test("promotion submits only individually approved browse-only source keys to the private RPC", async () => {
  const originalFetch = globalThis.fetch;
  let rpcUrl = "";
  let rpcBody;
  globalThis.fetch = async (url, init) => {
    rpcUrl = String(url);
    rpcBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ publication_id: "fixture-publication", published_count: 1, existing_count: 0 }), { status: 200 });
  };
  try {
    const response = await post("/admin/promote-offline-pbf", body, { Authorization: `Bearer ${env.ADMIN_TOKEN}` });
    assert.equal(response.status, 200);
    assert.equal(rpcUrl, "https://database.example/rest/v1/rpc/promote_offline_pbf_records");
    assert.equal(rpcBody.p_idempotency_key, body.idempotency_key);
    assert.equal(rpcBody.p_city_id, body.city_id);
    assert.equal(rpcBody.p_approval_reference, body.approval_reference);
    assert.equal(rpcBody.p_approved_by, env.ADMIN_ACTOR_ID);
    assert.equal(rpcBody.p_records[0].source_key, body.records[0].source_key);
    assert.equal(rpcBody.p_records[0].decision, "approve_browse_only");
    assert.equal(Object.hasOwn(rpcBody.p_records[0], "latitude"), false);
    assert.equal(Object.hasOwn(rpcBody.p_records[0], "name"), false);
    assert.equal(Object.hasOwn(rpcBody.p_records[0], "route_ready"), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("promotion rejects forged identities, route readiness, unsupported decisions and duplicate keys before RPC", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("invalid promotion must not reach database"); };
  try {
    for (const changes of [
      { canonical_name: "Invented name" },
      { latitude: 17.4 },
      { route_ready: true },
      { decision: "approve_for_itinerary" },
    ]) {
      const response = await post("/admin/promote-offline-pbf", {
        ...body, records: [{ ...body.records[0], ...changes }],
      }, { Authorization: `Bearer ${env.ADMIN_TOKEN}` });
      assert.equal(response.status, 400);
    }
    const duplicate = { ...body, records: [body.records[0], body.records[0]] };
    const response = await post("/admin/promote-offline-pbf", duplicate, { Authorization: `Bearer ${env.ADMIN_TOKEN}` });
    assert.equal(response.status, 400);
  } finally { globalThis.fetch = originalFetch; }
});

test("promotion requires configured server-side audit actor and valid evidence references", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response("{}", { status: 200 }); };
  try {
    const noActor = await worker.fetch(new Request("https://collector.test/admin/promote-offline-pbf", {
      method: "POST", headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    }), { ...env, ADMIN_ACTOR_ID: "  " });
    assert.equal(noActor.status, 503);
    const invalidEvidence = await post("/admin/promote-offline-pbf", {
      ...body, records: [{ ...body.records[0], importance_source_url: "http://example.test" }],
    }, { Authorization: `Bearer ${env.ADMIN_TOKEN}` });
    assert.equal(invalidEvidence.status, 400);
    const summaryWithoutLicense = await post("/admin/promote-offline-pbf", {
      ...body, records: [{ ...body.records[0], historical_summary: "An independently written historical summary for review." }],
    }, { Authorization: `Bearer ${env.ADMIN_TOKEN}` });
    assert.equal(summaryWithoutLicense.status, 400);
    assert.equal(called, false);
  } finally { globalThis.fetch = originalFetch; }
});

test("promotion maps upstream conflict to stable response without database details", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("private unique constraint detail", { status: 409 });
  try {
    const response = await post("/admin/promote-offline-pbf", body, { Authorization: `Bearer ${env.ADMIN_TOKEN}` });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "Promotion rejected; no records were published." });
  } finally { globalThis.fetch = originalFetch; }
});

test("publication rollback requires admin and sends the audit actor from server config", async () => {
  const originalFetch = globalThis.fetch;
  let rpcBody;
  globalThis.fetch = async (_url, init) => {
    rpcBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ publication_id: "fixture-publication", rolled_back_count: 1 }), { status: 200 });
  };
  try {
    const unauthorized = await post("/admin/rollback-offline-pbf-publication", {
      idempotency_key: body.idempotency_key, rollback_reference: "test rollback reference",
    });
    assert.equal(unauthorized.status, 401);
    const response = await post("/admin/rollback-offline-pbf-publication", {
      idempotency_key: body.idempotency_key, rollback_reference: "test rollback reference",
    }, { Authorization: `Bearer ${env.ADMIN_TOKEN}` });
    assert.equal(response.status, 200);
    assert.equal(rpcBody.p_rolled_back_by, env.ADMIN_ACTOR_ID);
  } finally { globalThis.fetch = originalFetch; }
});
