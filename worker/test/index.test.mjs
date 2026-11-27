import assert from "node:assert/strict";
import test from "node:test";
import worker, {
  category,
  distanceKm,
  fetchWithRetry,
  getWiki,
  parseRadius,
  retryAfterDelay,
  scoreImportance,
  subcategory,
} from "../src/index.ts";

test("historic=yes is stored as a useful category rather than the literal yes", () => {
  assert.equal(category({ historic: "yes" }), "historic_site");
});

test("generic OSM subcategory values are skipped without hiding valid values", () => {
  assert.equal(subcategory({ historic: "yes" }), undefined);
  assert.equal(subcategory({ tourism: "yes", historic: "castle" }), "castle");
  assert.equal(subcategory({ historic: "archaeological_site" }), "archaeological_site");
});

test("radius accepts only whole kilometers from 10 through 150", () => {
  assert.equal(parseRadius("30"), 30);
  assert.equal(parseRadius("10"), 10);
  assert.equal(parseRadius("150"), 150);
  assert.equal(parseRadius(null), undefined);
  for (const value of ["30.5", "0", "151", "", "abc"]) {
    assert.throws(() => parseRadius(value));
  }
});

test("attraction importance prioritizes heritage and remote natural features separately from quality", () => {
  const heritage = scoreImportance("openstreetmap", { tags: { historic: "castle", heritage: "2" } });
  const waterfall = scoreImportance("openstreetmap", { tags: { waterway: "waterfall" } });
  const ordinary = scoreImportance("openstreetmap", { tags: { tourism: "attraction" } });
  const designated = scoreImportance("wikidata", { designation: { value: "UNESCO World Heritage Site" } });
  assert.ok(heritage.score > ordinary.score);
  assert.ok(waterfall.score > ordinary.score);
  assert.ok(heritage.reasons.includes("heritage_designation"));
  assert.ok(waterfall.reasons.includes("waterfall"));
  assert.equal(designated.score, 96);
  assert.equal(ordinary.score, scoreImportance("openstreetmap", { tags: { tourism: "attraction" }, distance_km: 149 }).score);
});

test("distance uses the city and place coordinates", () => {
  assert.ok(distanceKm(17.385, 78.4867, 17.385, 78.4867) < 0.001);
});

test("Wikipedia HTTP failures are errors, not missing pages", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    return new Response("unavailable", { status: 503 });
  };
  try {
    await assert.rejects(getWiki("Example", { USER_AGENT: "test" }), /Wikipedia HTTP 503/);
    assert.equal(attempts, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Retry-After accepts seconds and HTTP dates and caps long waits", () => {
  assert.equal(retryAfterDelay("5", 0), 5000);
  assert.equal(retryAfterDelay(new Date(4000).toUTCString(), 0), 4000);
  assert.equal(retryAfterDelay("120", 0), 30_000);
  assert.equal(retryAfterDelay("invalid", 0), undefined);
});

test("429 and 503 retries honor Retry-After", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  try {
    for (const status of [429, 503]) {
      const delays = [];
      let attempts = 0;
      globalThis.fetch = async () => {
        attempts++;
        return attempts === 1
          ? new Response("busy", { status, headers: { "Retry-After": "2" } })
          : new Response("ok", { status: 200 });
      };
      globalThis.setTimeout = (callback, delay) => {
        delays.push(delay);
        queueMicrotask(callback);
        return 0;
      };
      const response = await fetchWithRetry("https://api.example", {}, 1000, 2);
      assert.equal(response.status, 200);
      assert.deepEqual(delays, [2000]);
    }
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("admin collection rejects a fractional radius before accessing the database", async () => {
  const response = await worker.fetch(
    new Request("https://collector.example/admin/collect?radiusKm=30.5", {
      method: "POST",
      headers: { Authorization: "Bearer local-test-token" },
    }),
    { ADMIN_TOKEN: "local-test-token" },
  );
  assert.equal(response.status, 400);
});

const TEST_CITY_ID = "11111111-1111-4111-8111-111111111111";
const TEST_CYCLE_ID = "22222222-2222-4222-8222-222222222222";
const TEST_ITEM_ID = "33333333-3333-4333-8333-333333333333";
const TEST_LEASE = "44444444-4444-4444-8444-444444444444";
const TEST_ITEM_LEASE = "55555555-5555-4555-8555-555555555555";

function responseJson(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function collectionHarness(options = {}) {
  const calls = [];
  const city = {
    id: TEST_CITY_ID,
    name: "Mock City",
    latitude: 12.9716,
    longitude: 77.5946,
    radius_km: 40,
    collection_status: "processing",
    collection_discovered_at: null,
    collection_discovery_error: null,
    active_collection_cycle_id: options.activeCycleId || null,
  };
  const element = options.element || {
    type: "node",
    id: 880001,
    lat: 13.8,
    lon: 77.5946,
    tags: { name: "Remote Ridge View", tourism: "viewpoint" },
  };
  const cycle = {
    cycle_id: TEST_CYCLE_ID,
    city_id: TEST_CITY_ID,
    radius_km: options.cycleRadius ?? 150,
    lease_token: TEST_LEASE,
    lease_expires_at: new Date(Date.now() + 600_000).toISOString(),
    cycle_status: options.claimStatus || "processing",
  };
  const osmSource = {
    cycle_id: TEST_CYCLE_ID,
    source_name: "openstreetmap",
    status: "processing",
    attempts: 0,
    max_attempts: 5,
    next_attempt_at: new Date().toISOString(),
    lease_token: "66666666-6666-4666-8666-666666666666",
    lease_expires_at: new Date(Date.now() + 600_000).toISOString(),
    cursor: { tasks: options.osmTasks || [{ south: 13.6, west: 77.4, north: 14, east: 77.8, depth: 0 }] },
    pages_completed: 0,
    items_discovered: 0,
    is_complete: false,
  };
  const wikidataSource = {
    ...osmSource,
    source_name: "wikidata",
    lease_token: "77777777-7777-4777-8777-777777777777",
    cursor: null,
  };
  const item = {
    id: TEST_ITEM_ID,
    cycle_id: TEST_CYCLE_ID,
    source_name: "openstreetmap",
    source_id: `node/${element.id}`,
    raw_payload: element,
    status: "processing",
    attempts: 1,
    available_at: new Date().toISOString(),
    lease_token: TEST_ITEM_LEASE,
    lease_expires_at: new Date(Date.now() + 600_000).toISOString(),
    priority_score: 74,
    priority_reasons: ["viewpoint"],
    last_error: null,
  };
  const env = {
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SECRET_KEY: "mock-secret-key",
    ADMIN_TOKEN: "mock-admin-token",
    DEFAULT_RADIUS_KM: "40",
    OVERPASS_URL: "https://overpass.test/api/interpreter",
    WIKIDATA_SPARQL_URL: "https://wikidata.test/sparql",
    USER_AGENT: "mock-test-agent",
  };

  const mockFetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "supabase.test") {
      const path = url.pathname.replace("/rest/v1/", "");
      const body = init.body ? JSON.parse(String(init.body)) : null;
      calls.push({ kind: "db", path, method: init.method || "GET", body, query: url.searchParams });

      if (path === "tourism_cities" && url.searchParams.get("select")?.includes("active_collection_cycle_id")) {
        return responseJson([city]);
      }
      if (path === "tourism_cities" && url.searchParams.get("select") === "collection_status") {
        return responseJson([{ collection_status: options.cityStatus || "completed" }]);
      }
      if (path === "tourism_ingestion_runs" && init.method === "POST") return responseJson([{ id: "88888888-8888-4888-8888-888888888888" }]);
      if (path === "tourism_collection_cycles") return responseJson([{ status: options.cycleStatus || "ready_to_finalize" }]);
      if (path === "tourism_collection_cycle_items") {
        if (options.adminStatsRows && url.searchParams.get("select") === "status") {
          const offset = Number(url.searchParams.get("offset") || 0);
          if (offset === 0) return responseJson(Array.from({ length: 1000 }, () => ({ status: "pending" })));
          if (offset === 1000) return responseJson([{ status: "completed" }]);
          return responseJson([]);
        }
        return responseJson(options.queueRows || []);
      }
      if (path === "tourism_city_places") return responseJson(options.publicPlaces || []);
      if (path === "rpc/claim_tourism_collection_cycle") {
        if (options.radiusConflict) return responseJson({ message: "radius differs from active cycle" }, 400);
        return responseJson([cycle]);
      }
      if (path === "rpc/claim_next_tourism_collection_cycle") return responseJson([cycle]);
      if (path === "rpc/claim_tourism_cycle_source") {
        return responseJson([body.p_source_name === "openstreetmap" ? osmSource : wikidataSource]);
      }
      if (path === "rpc/renew_tourism_collection_lease") {
        if (options.staleSourceLease && body.p_source_name === "openstreetmap") {
          return responseJson({ message: "stale source lease" }, 409);
        }
        return new Response(null, { status: 204 });
      }
      if (path === "rpc/persist_tourism_cycle_source_page") return responseJson([{ page_applied: true }]);
      if (path === "rpc/release_tourism_cycle_source") return responseJson("truncated");
      if (path === "rpc/fail_tourism_cycle_source") {
        if (options.staleSourceLease) return responseJson({ message: "stale source lease" }, 409);
        return responseJson("retry_wait");
      }
      if (path === "rpc/claim_tourism_cycle_items") return responseJson(options.items || [item]);
      if (path === "rpc/upsert_tourism_place_for_cycle") return responseJson("99999999-9999-4999-8999-999999999999");
      if (path === "rpc/fail_tourism_cycle_item") return responseJson("failed");
      if (path === "rpc/finish_tourism_collection_cycle") return responseJson(0);
      if (path === "rpc/release_tourism_collection_city_lease") return responseJson(true);
      if (path === "tourism_ingestion_runs" || init.method === "PATCH") return new Response(null, { status: 204 });
      return responseJson([]);
    }
    if (url.hostname === "overpass.test") {
      calls.push({ kind: "overpass", body: String(init.body || "") });
      if (options.overpassStatus) {
        return new Response("upstream unavailable", {
          status: options.overpassStatus,
          headers: { "Retry-After": "0" },
        });
      }
      return responseJson({ elements: options.osmElements || [element] });
    }
    if (url.hostname === "wikidata.test") {
      calls.push({ kind: "wikidata", query: url.searchParams.get("query") || "" });
      return responseJson({ results: { bindings: options.wikidataBindings || [] } });
    }
    throw new Error(`Unexpected mocked fetch host: ${url.hostname}`);
  };
  return { calls, city, cycle, item, env, mockFetch };
}

async function withoutWaits(callback) {
  const original = globalThis.setTimeout;
  globalThis.setTimeout = (callback) => {
    queueMicrotask(callback);
    return 0;
  };
  try {
    return await callback();
  } finally {
    globalThis.setTimeout = original;
  }
}

test("collection cycle uses persisted 150 km radius, resumes paged discovery, and atomically saves importance", async () => {
  const harness = collectionHarness();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.mockFetch;
  try {
    const response = await withoutWaits(() => worker.fetch(
      new Request(`https://collector.test/admin/collect-city/${TEST_CITY_ID}?radiusKm=150`, {
        method: "POST",
        headers: { authorization: "Bearer mock-admin-token" },
      }),
      harness.env,
    ));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.radius_km, 150);
    assert.equal(result.status, "completed");
    assert.equal(harness.calls.find((call) => call.path === "rpc/claim_tourism_collection_cycle").body.p_radius_km, 150);

    const overpass = harness.calls.find((call) => call.kind === "overpass");
    assert.ok(overpass);
    assert.match(decodeURIComponent(overpass.body), /out center tags;/);
    assert.doesNotMatch(decodeURIComponent(overpass.body), /out center tags 100/);
    const osmPages = harness.calls.filter((call) => call.path === "rpc/persist_tourism_cycle_source_page" && call.body.p_source_name === "openstreetmap");
    assert.equal(osmPages.length, 3);
    assert.equal(osmPages[0].body.p_is_complete, false);
    assert.ok(osmPages[0].body.p_next_cursor?.version === 1);
    assert.equal(osmPages[2].body.p_is_complete, true);
    assert.equal(osmPages[2].body.p_next_cursor, null);
    const osmPage = osmPages[0];
    assert.equal(osmPage.body.p_items[0].source_id, "node/880001");
    assert.ok(osmPage.body.p_items[0].priority_score > 0);

    const upsert = harness.calls.find((call) => call.path === "rpc/upsert_tourism_place_for_cycle");
    assert.equal(upsert.body.p_cycle_id, TEST_CYCLE_ID);
    assert.equal(upsert.body.p_place.latitude, 13.8);
    assert.equal(upsert.body.p_place.quality_score, 10);
    assert.equal(upsert.body.p_place.importance_score, 74);
    assert.ok(upsert.body.p_source.payload.localise_taxonomy.categories.includes("scenic_spots"));
    assert.deepEqual(upsert.body.p_source.payload.localise_taxonomy.foodFacets, []);
    assert.equal(upsert.body.p_source.attribution, "© OpenStreetMap contributors");
    assert.ok(harness.calls.some((call) => call.path === "rpc/finish_tourism_collection_cycle"));
    assert.ok(!harness.calls.some((call) => call.path === "tourism_collection_items"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a changed radius cannot mutate an active cycle without explicit rediscovery", async () => {
  const harness = collectionHarness({ activeCycleId: TEST_CYCLE_ID, radiusConflict: true });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.mockFetch;
  try {
    const response = await worker.fetch(
      new Request(`https://collector.test/admin/collect-city/${TEST_CITY_ID}?radiusKm=150`, {
        method: "POST",
        headers: { authorization: "Bearer mock-admin-token" },
      }),
      harness.env,
    );
    assert.equal(response.status, 409);
    const claim = harness.calls.find((call) => call.path === "rpc/claim_tourism_collection_cycle");
    assert.equal(claim.body.p_radius_km, 150);
    assert.equal(claim.body.p_rediscover, false);
    assert.ok(!harness.calls.some((call) => call.kind === "overpass" || call.kind === "wikidata"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("incomplete OSM discovery checkpoints cursor and releases the city lease without finalizing", async () => {
  const tasks = [0, 1, 2, 3].map((n) => ({ south: 10 + n, west: 70, north: 10.5 + n, east: 70.5, depth: 0 }));
  const harness = collectionHarness({ osmTasks: tasks, osmElements: [], cycleStatus: "processing" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.mockFetch;
  try {
    const response = await withoutWaits(() => worker.fetch(
      new Request(`https://collector.test/admin/collect-city/${TEST_CITY_ID}`, {
        method: "POST",
        headers: { authorization: "Bearer mock-admin-token" },
      }),
      harness.env,
    ));
    assert.equal(response.status, 200);
    const osmPages = harness.calls.filter((call) => call.path === "rpc/persist_tourism_cycle_source_page" && call.body.p_source_name === "openstreetmap");
    assert.equal(osmPages.length, 3);
    assert.ok(osmPages.every((page) => {
      const cursor = page.body.p_next_cursor;
      return page.body.p_is_complete === false
        && cursor?.version === 1
        && Object.values(cursor.cursors || {}).some((kindCursor) => kindCursor.pending.length > 0);
    }));
    assert.ok(harness.calls.some((call) => call.path === "rpc/release_tourism_cycle_source"));
    assert.ok(harness.calls.some((call) => call.path === "rpc/release_tourism_collection_city_lease"));
    assert.ok(!harness.calls.some((call) => call.path === "rpc/finish_tourism_collection_cycle"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Wikidata uses resumable offset pages without a total-result cap", async () => {
  const bindings = Array.from({ length: 250 }, (_, index) => ({
    item: { value: `http://www.wikidata.org/entity/Q${index + 1}` },
    coord: { value: "Point(77.5946 12.9716)" },
    sitelinks: { value: String(250 - index) },
  }));
  const harness = collectionHarness({ wikidataBindings: bindings, cycleStatus: "processing", items: [] });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.mockFetch;
  try {
    await withoutWaits(() => worker.fetch(
      new Request(`https://collector.test/admin/collect-city/${TEST_CITY_ID}`, {
        method: "POST",
        headers: { authorization: "Bearer mock-admin-token" },
      }),
      harness.env,
    ));
    const pages = harness.calls.filter((call) => call.path === "rpc/persist_tourism_cycle_source_page" && call.body.p_source_name === "wikidata");
    assert.equal(pages.length, 3);
    assert.deepEqual(pages.map((page) => page.body.p_expected_cursor), [null, { offset: 250 }, { offset: 500 }]);
    assert.deepEqual(pages.map((page) => page.body.p_next_cursor), [{ offset: 250 }, { offset: 500 }, { offset: 750 }]);
    assert.ok(pages.every((page) => page.body.p_is_complete === false && page.body.p_items.length === 250));
    const queryOffsets = harness.calls.filter((call) => call.kind === "wikidata").map((call) => call.query.match(/OFFSET (\d+)/)?.[1]);
    assert.deepEqual(queryOffsets, ["0", "250", "500"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("upstream source failure is recorded through the bounded source retry RPC", async () => {
  const harness = collectionHarness({ overpassStatus: 503, cycleStatus: "processing", items: [] });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.mockFetch;
  try {
    await withoutWaits(() => worker.fetch(
      new Request(`https://collector.test/admin/collect-city/${TEST_CITY_ID}`, {
        method: "POST",
        headers: { authorization: "Bearer mock-admin-token" },
      }),
      harness.env,
    ));
    const retries = harness.calls.filter((call) => call.path === "rpc/fail_tourism_cycle_source");
    assert.equal(retries.length, 1);
    assert.equal(retries[0].body.p_source_name, "openstreetmap");
    assert.match(retries[0].body.p_error, /Overpass HTTP 503/);
    assert.equal(harness.calls.filter((call) => call.kind === "overpass").length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stale source leases cannot persist pages and city checkpoints are still released", async () => {
  const harness = collectionHarness({ staleSourceLease: true, cycleStatus: "processing", items: [] });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.mockFetch;
  try {
    await withoutWaits(() => worker.fetch(
      new Request(`https://collector.test/admin/collect-city/${TEST_CITY_ID}`, {
        method: "POST",
        headers: { authorization: "Bearer mock-admin-token" },
      }),
      harness.env,
    ));
    assert.ok(!harness.calls.some((call) => call.path === "rpc/persist_tourism_cycle_source_page" && call.body.p_source_name === "openstreetmap"));
    assert.ok(!harness.calls.some((call) => call.path === "rpc/upsert_tourism_place_for_cycle"));
    assert.ok(harness.calls.some((call) => call.path === "rpc/release_tourism_collection_city_lease"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a cycle ready for finalization after a crash is claimed and completed without rediscovery", async () => {
  const harness = collectionHarness({ claimStatus: "ready_to_finalize", cycleStatus: "ready_to_finalize", cityStatus: "completed" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.mockFetch;
  try {
    const response = await withoutWaits(() => worker.fetch(
      new Request("https://collector.test/admin/collect", {
        method: "POST",
        headers: { authorization: "Bearer mock-admin-token" },
      }),
      harness.env,
    ));
    assert.equal(response.status, 200);
    assert.ok(harness.calls.some((call) => call.path === "rpc/finish_tourism_collection_cycle"));
    assert.ok(!harness.calls.some((call) => call.kind === "overpass" || call.kind === "wikidata"));
    assert.ok(!harness.calls.some((call) => call.path === "rpc/claim_tourism_cycle_source"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public places and admin review exclude retired city-place links", async () => {
  const harness = collectionHarness();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.mockFetch;
  try {
    await worker.fetch(new Request(`https://collector.test/public/places?city_id=${TEST_CITY_ID}`), harness.env);
    await worker.fetch(new Request(`https://collector.test/admin/review?city_id=${TEST_CITY_ID}`, {
      headers: { authorization: "Bearer mock-admin-token" },
    }), harness.env);
    const links = harness.calls.filter((call) => call.path === "tourism_city_places");
    assert.equal(links.length, 2);
    assert.ok(links.every((call) => call.query.get("is_current") === "eq.true"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public cities report only sanitized upstream failure diagnostics", async () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const originalConsoleLog = console.log;
  const diagnostics = [];
  const stages = [];
  globalThis.fetch = async () => new Response(JSON.stringify({
    code: "PGRST204",
    message: "private schema detail that must not be logged",
  }), { status: 400, headers: { "Content-Type": "application/json" } });
  console.error = (...args) => diagnostics.push(args);
  console.log = (...args) => stages.push(args);
  try {
    const response = await worker.fetch(new Request("https://collector.test/public/cities"), {
      SUPABASE_URL: "https://supabase.test",
      SUPABASE_SECRET_KEY: "mock-secret-key",
      DB_DIAGNOSTICS: "true",
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "Tourism data service unavailable." });
    assert.deepEqual(diagnostics, [["public_cities_upstream_failure", { kind: "postgrest_http", status: 400, code: "PGRST204" }]]);
    const upstream = stages.find(([event, detail]) => event === "tourism_db_stage" && detail.stage === "upstream_response");
    assert.deepEqual(upstream[1], {
      request_id: upstream[1].request_id, operation: "public_cities", stage: "upstream_response",
      status: 400, category: "http_error", code: "PGRST204",
    });
    assert.equal(upstream[1].request_id.length > 0, true);
    assert.doesNotMatch(JSON.stringify([...diagnostics, ...stages]), /private schema detail|mock-secret-key/);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
    console.log = originalConsoleLog;
  }
});

test("diagnostic candidate logs safe connection stages and verifies the expected Supabase project", async () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleLog = console.log;
  const logs = [];
  const secretMarker = "sb_secret_test_placeholder";
  globalThis.fetch = async (input, init) => {
    assert.equal(new URL(input).hostname, "vsfbwesxskkveaevujnj.supabase.co");
    assert.equal(new Headers(init.headers).get("apikey"), secretMarker);
    return responseJson([{ id: TEST_CITY_ID, name: "Hyderabad" }]);
  };
  console.log = (...args) => logs.push(args);
  try {
    const response = await worker.fetch(new Request("https://collector.test/public/cities", {
      headers: { "cf-ray": "a61076aff9e12e84-HYD" },
    }), {
      SUPABASE_URL: "https://vsfbwesxskkveaevujnj.supabase.co",
      SUPABASE_PROJECT_REF: "vsfbwesxskkveaevujnj",
      SUPABASE_SECRET_KEY: secretMarker,
      DB_DIAGNOSTICS: "true",
    });
    assert.equal(response.status, 200);
    const stages = logs.filter(([event]) => event === "tourism_db_stage").map(([, detail]) => detail);
    assert.deepEqual(stages.map(({ stage }) => stage), ["bindings", "url_validation", "credential_format", "fetch_start", "upstream_response"]);
    assert.equal(stages[0].supabase_secret_key_present, true);
    assert.equal(stages[1].project_match, true);
    assert.deepEqual(stages[2], {
      request_id: "a61076aff9e12e84-HYD", operation: "public_cities", stage: "credential_format",
      kind: "sb_secret", format_valid: false,
    });
    assert.equal(stages.at(-1).status, 200);
    assert.doesNotMatch(JSON.stringify(logs), /private-test-value|vsfbwesxskkveaevujnj\.supabase\.co/);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalConsoleLog;
  }
});

test("diagnostic candidate blocks a mismatched project before outbound fetch", async () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleLog = console.log;
  const logs = [];
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; return responseJson([]); };
  console.log = (...args) => logs.push(args);
  try {
    const response = await worker.fetch(new Request("https://collector.test/public/cities"), {
      SUPABASE_URL: "https://wrong-project.supabase.co",
      SUPABASE_PROJECT_REF: "vsfbwesxskkveaevujnj",
      SUPABASE_SECRET_KEY: "sensitive-marker",
      DB_DIAGNOSTICS: "true",
    });
    assert.equal(response.status, 502);
    assert.equal(fetched, false);
    const stages = logs.filter(([event]) => event === "tourism_db_stage").map(([, detail]) => detail);
    assert.equal(stages.find(({ stage }) => stage === "url_validation").project_match, false);
    assert.equal(stages.find(({ stage }) => stage === "configuration_failure").category, "project_mismatch");
    assert.ok(!stages.some(({ stage }) => stage === "fetch_start"));
    assert.doesNotMatch(JSON.stringify(logs), /sensitive-marker|wrong-project/);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalConsoleLog;
  }
});

test("diagnostic candidate classifies network exceptions without exposing error details", async () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleLog = console.log;
  const logs = [];
  globalThis.fetch = async () => { throw new TypeError("private host and key must not be logged"); };
  console.log = (...args) => logs.push(args);
  try {
    const response = await worker.fetch(new Request("https://collector.test/public/cities"), {
      SUPABASE_URL: "https://vsfbwesxskkveaevujnj.supabase.co",
      SUPABASE_PROJECT_REF: "vsfbwesxskkveaevujnj",
      SUPABASE_SECRET_KEY: "sensitive-marker",
      DB_DIAGNOSTICS: "true",
    });
    assert.equal(response.status, 502);
    const network = logs.find(([event, detail]) => event === "tourism_db_stage" && detail.stage === "fetch_exception");
    assert.equal(network[1].category, "fetch_type_error");
    assert.doesNotMatch(JSON.stringify(logs), /private host|sensitive-marker|supabase\.co/);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalConsoleLog;
  }
});

test("public places preserve browse-only route readiness and remove raw source payloads", async () => {
  const place = {
    id: "88888888-8888-4888-8888-888888888888", canonical_name: "Charminar", review_status: "approved",
    is_active: true, route_ready: false, latitude: 17.3616, longitude: 78.4747,
    historical_points: [
      { text: "Built under Muhammad Quli Qutb Shah.", source_url: "https://hyderabad.telangana.gov.in/tourist-place/charminar/" },
      { text: "Unsafe source must be omitted.", source_url: "javascript:alert(1)" },
    ],
    visiting_info: { verified: true, source_url: "https://culture.gov.in/files/inline-documents/TheAncientMonumentsandArchaeologicalSitesandRemainsRules1959_20.03.2018.pdf" },
    image_url: "https://commons.wikimedia.org/wiki/Special:FilePath/Charminar_at_Hyderabad_Telangana_India.jpg",
    image_source_url: "https://commons.wikimedia.org/wiki/File:Charminar_at_Hyderabad_Telangana_India.jpg",
    image_author: "Kavali Chandrakanth KCK", image_license: "CC BY-SA 4.0",
    sources: [{ source_name: "openstreetmap", source_id: "way/1", source_url: "https://www.openstreetmap.org/way/1", attribution: "© OpenStreetMap contributors", license: "ODbL-1.0", payload: { private_stage: true, localise_taxonomy: { categories: ["heritage"], foodFacets: [], exclusionReasons: [], recommendationEligible: true } } }],
  };
  const legacyPlace = { ...place, id: "99999999-9999-4999-8999-999999999999", canonical_name: "Golconda Fort" };
  delete legacyPlace.route_ready;
  const harness = collectionHarness({ publicPlaces: [
    { distance_km: 1, relevance_score: 90, place },
    { distance_km: 2, relevance_score: 80, place: legacyPlace },
  ] });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.mockFetch;
  try {
    const response = await worker.fetch(new Request(`https://collector.test/public/places?city_id=${TEST_CITY_ID}`), harness.env);
    assert.equal(response.status, 200);
    const rows = await response.json();
    assert.deepEqual(rows.map((row) => row.place.route_ready), [false, false]);
    assert.equal(rows[0].place.sources[0].license, "ODbL-1.0");
    assert.equal(Object.hasOwn(rows[0].place.sources[0], "payload"), false);
    assert.deepEqual(rows[0].place.taxonomy_categories, ["heritage"]);
    assert.deepEqual(rows[0].place.food_facets, []);
    assert.equal(rows[0].place.recommendation_eligible, true);
    assert.deepEqual(rows[0].place.historical_points, [place.historical_points[0]]);
    assert.deepEqual(rows[0].place.visiting_info, place.visiting_info);
    assert.equal(rows[0].place.image_source_url, place.image_source_url);
    const query = harness.calls.find((call) => call.path === "tourism_city_places").query.get("select");
    assert.match(query, /route_ready/);
    assert.match(query, /historical_points/);
    assert.match(query, /visiting_info/);
    assert.match(query, /image_source_url/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public places suppress only records explicitly classified as irrelevant", async () => {
  const source = { source_name: "openstreetmap", source_id: "way/1", source_url: "https://www.openstreetmap.org/way/1", attribution: "© OpenStreetMap contributors", license: "ODbL-1.0" };
  const relevant = { id: "88888888-8888-4888-8888-888888888888", canonical_name: "Lake", review_status: "approved", is_active: true,
    latitude: 17.4, longitude: 78.4, sources: [{ ...source, payload: { localise_taxonomy: { categories: ["lakes"], foodFacets: [], exclusionReasons: [], recommendationEligible: true } } }] };
  const excluded = { ...relevant, id: "99999999-9999-4999-8999-999999999999", canonical_name: "Residential tower",
    sources: [{ ...source, payload: { localise_taxonomy: { categories: [], foodFacets: [], exclusionReasons: ["residential_property"], recommendationEligible: false } } }] };
  const harness = collectionHarness({ publicPlaces: [
    { distance_km: 1, relevance_score: 50, place: relevant },
    { distance_km: 2, relevance_score: 1, place: excluded },
  ] });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.mockFetch;
  try {
    const response = await worker.fetch(new Request(`https://collector.test/public/places?city_id=${TEST_CITY_ID}`), harness.env);
    const rows = await response.json();
    assert.deepEqual(rows.map((row) => row.place.canonical_name), ["Lake"]);
  } finally { globalThis.fetch = originalFetch; }
});

test("public API derives taxonomy from private legacy OSM tags when a saved result is absent", async () => {
  const place = { id: "88888888-8888-4888-8888-888888888888", canonical_name: "Lake Viewpoint", category: "attraction", subcategory: "viewpoint",
    review_status: "approved", is_active: true, latitude: 17.4, longitude: 78.4,
    sources: [{ source_name: "openstreetmap", source_id: "node/10", source_url: "https://www.openstreetmap.org/node/10", attribution: "© OpenStreetMap contributors", license: "ODbL-1.0", payload: { tags: { tourism: "viewpoint", natural: "viewpoint" } } }] };
  const harness = collectionHarness({ publicPlaces: [{ distance_km: 1, relevance_score: 20, place }] });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.mockFetch;
  try {
    const response = await worker.fetch(new Request(`https://collector.test/public/places?city_id=${TEST_CITY_ID}`), harness.env);
    const [row] = await response.json();
    assert.ok(row.place.taxonomy_categories.includes("scenic_spots"));
    assert.equal(row.place.recommendation_eligible, true);
    assert.equal(Object.hasOwn(row.place.sources[0], "payload"), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("admin stats paginate the new cycle queue beyond the PostgREST 1000-row window", async () => {
  const harness = collectionHarness({ adminStatsRows: true });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.mockFetch;
  try {
    const response = await worker.fetch(new Request("https://collector.test/admin/stats", {
      headers: { authorization: "Bearer mock-admin-token" },
    }), harness.env);
    const stats = await response.json();
    assert.equal(stats.queue.pending, 1000);
    assert.equal(stats.queue.completed, 1);
    assert.ok(harness.calls.some((call) => call.path === "tourism_collection_cycle_items" && call.query.get("offset") === "1000"));
    assert.ok(harness.calls.some((call) => call.path === "tourism_collection_cycle_sources"));
    assert.ok(harness.calls.some((call) => call.path === "tourism_collection_items"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
