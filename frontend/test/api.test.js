import test from "node:test";
import assert from "node:assert/strict";
import { createApiClient } from "../api.js";

test("public API client calls the existing city and place routes", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => [] };
  };
  const client = createApiClient({ apiBaseUrl: "https://api.example.test/", fetchImpl });

  await client.listCities();
  await client.listPlaces("city id/with spaces");

  assert.equal(calls[0].url, "https://api.example.test/public/cities");
  assert.equal(calls[1].url, "https://api.example.test/public/places?city_id=city+id%2Fwith+spaces&limit=100");
  assert.deepEqual(calls[0].options.headers, { Accept: "application/json" });
  assert.deepEqual(calls[1].options.headers, { Accept: "application/json" });
});

test("client surfaces public API errors without logging response data", async () => {
  const client = createApiClient({
    apiBaseUrl: "https://api.example.test",
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: "A valid city_id is required." }) }),
  });

  await assert.rejects(client.listPlaces("bad-id"), /A valid city_id is required/);
});

test("client rejects malformed responses and missing API configuration", async () => {
  const malformed = createApiClient({
    apiBaseUrl: "https://api.example.test",
    fetchImpl: async () => ({ ok: true, json: async () => ({ cities: [] }) }),
  });
  await assert.rejects(malformed.listCities(), /unexpected response/);
  assert.throws(() => createApiClient({ apiBaseUrl: "" }), /base URL is required/);
});
