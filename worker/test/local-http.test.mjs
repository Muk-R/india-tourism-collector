import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.ts";

const baseEnv = { SUPABASE_SECRET_KEY: "sb_secret_local-fixture", ADMIN_TOKEN: "test-admin" };

test("local HTTP opt-in permits only loopback Supabase origins", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async (url) => {
    called = true;
    assert.equal(String(url), "http://127.0.0.1:3000/rest/v1/tourism_cities?select=id,name,state_name,latitude,longitude,radius_km&is_enabled=eq.true&order=name.asc");
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

test("local HTTP remains disabled by default and cannot allow remote cleartext URLs", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response("[]", { status: 200 }); };
  try {
    for (const [url, allow] of [["http://127.0.0.1:3000", undefined], ["http://api.example.test", "true"]]) {
      await assert.rejects(worker.fetch(new Request("http://worker.test/public/cities"), {
        ...baseEnv, SUPABASE_URL: url, ALLOW_LOCAL_HTTP: allow,
      }), /SUPABASE_URL must be an HTTPS origin/);
    }
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
