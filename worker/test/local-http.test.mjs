import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.ts";

const baseEnv = { SUPABASE_SECRET_KEY: "sb_secret_local-fixture", ADMIN_TOKEN: "test-admin" };

test("local HTTP opt-in permits only loopback Supabase origins", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async (url, init) => {
    called = true;
    assert.equal(String(url), "http://127.0.0.1:3000/rest/v1/tourism_cities?select=id,name,state_name,latitude,longitude,radius_km&is_enabled=eq.true&order=name.asc");
    assert.equal(new Headers(init.headers).get("apikey"), baseEnv.SUPABASE_SECRET_KEY);
    assert.equal(new Headers(init.headers).has("authorization"), false);
    return new Response("[]", { status: 200 });
  };
  try {
    const response = await worker.fetch(new Request("http://worker.test/public/cities"), {
      ...baseEnv, SUPABASE_URL: "http://127.0.0.1:3000", ALLOW_LOCAL_HTTP: "true",
    });
    assert.equal(response.status, 200);
    assert.equal(called, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public cities converts database failures to a stable JSON 502", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("private database detail"); };
  try {
    const response = await worker.fetch(new Request("https://worker.test/public/cities"), {
      ...baseEnv, SUPABASE_URL: "https://database.example",
    });
    assert.equal(response.status, 502);
    assert.match(response.headers.get("content-type"), /application\/json/);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(await response.json(), { error: "Tourism data service unavailable." });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public places converts schema and database failures to a stable JSON 502", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("private schema detail"); };
  try {
    const response = await worker.fetch(new Request("https://worker.test/public/places?city_id=00000000-0000-4000-8000-000000000001"), {
      ...baseEnv, SUPABASE_URL: "https://database.example",
    });
    assert.equal(response.status, 502);
    assert.match(response.headers.get("content-type"), /application\/json/);
    assert.deepEqual(await response.json(), { error: "Tourism places service unavailable." });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public places ranks approved city links by importance before relevance", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = new URL(url);
    return Response.json([]);
  };
  try {
    const response = await worker.fetch(new Request("https://worker.test/public/places?city_id=00000000-0000-4000-8000-000000000001"), {
      ...baseEnv, SUPABASE_URL: "https://database.example",
    });
    assert.equal(response.status, 200);
    assert.equal(requestedUrl.searchParams.get("order"), "place(importance_score).desc,relevance_score.desc");
    assert.equal(requestedUrl.searchParams.get("is_current"), "eq.true");
    assert.equal(requestedUrl.searchParams.get("place.review_status"), "eq.approved");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("local HTTP remains disabled by default and cannot allow remote cleartext URLs", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response("[]", { status: 200 }); };
  try {
    for (const [url, allow] of [["http://127.0.0.1:3000", undefined], ["http://api.example.test", "true"]]) {
      const response = await worker.fetch(new Request("http://worker.test/public/cities"), {
        ...baseEnv, SUPABASE_URL: url, ALLOW_LOCAL_HTTP: allow,
      });
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), { error: "Tourism data service unavailable." });
    }
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
