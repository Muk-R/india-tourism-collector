import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { filterCities, getView, mockCities } from "../data.js";

test("navigation resolves every primary section and city guide", () => {
  for (const route of ["home", "itineraries", "social", "saved"]) {
    assert.equal(getView(`#${route}`).type, route);
  }
  assert.equal(getView("#city/hyderabad").city.name, "Hyderabad");
  assert.equal(getView("#city/missing").type, "not-found");
  assert.equal(getView("#missing").type, "not-found");
});

test("city search is case insensitive, trimmed, and preserves all cities when blank", () => {
  assert.deepEqual(filterCities("  HYD ").map((city) => city.id), ["hyderabad"]);
  assert.deepEqual(filterCities("jaipur").map((city) => city.id), ["jaipur"]);
  assert.equal(filterCities("unknown").length, 0);
  assert.equal(filterCities("  ").length, mockCities.length);
});

test("dynamic API city records resolve as routable and searchable cities", () => {
  const apiCities = [{ id: "8a0ddc93-1111-4111-8111-111111111111", name: "Mysuru", state_name: "Karnataka" }];
  assert.equal(getView("#city/8a0ddc93-1111-4111-8111-111111111111", apiCities).city, apiCities[0]);
  assert.deepEqual(filterCities("mys", apiCities), apiCities);
});

test("mock records avoid unsupported ratings and dietary claims", () => {
  const text = JSON.stringify(mockCities);
  assert.match(text, /Mock city history summary/);
  assert.match(text, /details awaiting source review/);
  assert.match(text, /dietary details unknown/);
  assert.match(text, /ratings unknown/);
  assert.doesNotMatch(text, /star_rating|dietary_classification/);
});

test("document exposes accessible landmark navigation and mobile layout", async () => {
  const [html, css, app] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../styles.css", import.meta.url), "utf8"),
    readFile(new URL("../app.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /href="#main-content"/);
  assert.match(html, /<main id="main-content"/);
  assert.match(html, /OpenStreetMap-derived public data &copy; OpenStreetMap contributors/);
  assert.match(html, /href="https:\/\/www\.openstreetmap\.org\/copyright"[^>]*>Open Database License \(ODbL\) 1\.0<\/a>/);
  assert.match(html, /class="source-attribution"/);
  assert.match(html, /role="status"/);
  assert.match(html, /<nav class="bottom-nav" aria-label="Main navigation"/);
  assert.match(app, /id="city-grid" aria-live="polite"/);
  for (const label of ["Home", "Itineraries", "Social", "Saved"]) assert.match(html, new RegExp(`>${label}<\\/span>`));
  assert.match(css, /:focus-visible/);
  assert.match(css, /max-width: 480px/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(app, /aria-current/);
  assert.match(app, /role="status"/);
  assert.match(app, /title\.includes\("could not"\) \? "alert" : "status"/);
  assert.match(app, /aria-busy/);
  assert.match(html, /runtime-config\.js/);
  assert.match(app, /role="group" aria-label="Filter places by source category"/);
  assert.match(app, /aria-pressed="\$\{selectedCategory === group\}"/);
  assert.match(app, /Open in OpenStreetMap/);
  assert.match(app, /target="_blank" rel="noopener noreferrer"/);
});
