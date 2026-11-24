import test from "node:test";
import assert from "node:assert/strict";
import { filterPlaces, getOpenStreetMapUrl, getPlaceGroup, getPlaceGroupCounts, hasValidCoordinates } from "../places.js";

test("source categories group attractions, restaurants, and accommodation without name inference", () => {
  const rows = [
    { place: { canonical_name: "Fort", category: "historic_site" } },
    { place: { canonical_name: "Cafe", category: "restaurant", subcategory: "cafe" } },
    { place: { canonical_name: "Hotel", category: "accommodation", subcategory: "hotel" } },
    { place: { canonical_name: "Unknown category", category: null } },
    { place: { canonical_name: "Unclassified cafe", category: "", subcategory: "cafe" } },
  ];

  assert.deepEqual(rows.map(getPlaceGroup), ["attractions", "food", "stays", "unclassified", "unclassified"]);
  assert.deepEqual(filterPlaces(rows, "attractions"), [rows[0]]);
  assert.deepEqual(filterPlaces(rows, "food"), [rows[1]]);
  assert.deepEqual(filterPlaces(rows, "stays"), [rows[2]]);
  assert.equal(filterPlaces(rows).length, rows.length);
  assert.deepEqual(getPlaceGroupCounts(rows), { attractions: 1, food: 1, stays: 1, unclassified: 2 });
});

test("OpenStreetMap outbound links require valid in-range numeric coordinates", () => {
  const coordinates = { latitude: 17.385, longitude: 78.4867 };
  assert.equal(hasValidCoordinates(coordinates), true);
  assert.equal(getOpenStreetMapUrl(coordinates), "https://www.openstreetmap.org/?mlat=17.385&mlon=78.4867#map=16/17.385/78.4867");
  for (const invalid of [
    null,
    { latitude: "17.385", longitude: 78 },
    { latitude: 91, longitude: 78 },
    { latitude: 17, longitude: -181 },
  ]) {
    assert.equal(hasValidCoordinates(invalid), false);
    assert.equal(getOpenStreetMapUrl(invalid), "");
  }
});
