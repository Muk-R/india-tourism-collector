import assert from "node:assert/strict";
import test from "node:test";
import { planItinerary, rescheduleItinerary } from "../src/index.ts";
import { mockPlace, mockTrip } from "./fixtures.ts";

const flatten = (itinerary) => itinerary.days.flatMap((day) => day.activities);
const overlaps = (itinerary) => itinerary.days.some((day) => {
  const timed = day.activities.filter((activity) => activity.starts_at && activity.ends_at)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  return timed.some((activity, index) => index > 0 && activity.starts_at < timed[index - 1].ends_at);
});

test("one-day hotel day trip schedules both selected stops and all known road legs", () => {
  const result = planItinerary(mockTrip());
  assert.equal(result.status, "feasible");
  assert.deepEqual(flatten(result).filter((a) => a.kind === "visit").map((a) => a.place_id).sort(), ["a", "b"]);
  assert.ok(flatten(result).filter((a) => a.kind === "travel").length >= 2);
  assert.ok(flatten(result).some((a) => a.kind === "breakfast"));
});

test("multi-day travel resets each day's origin at the hotel", () => {
  const trip = mockTrip({ days: 2, places: [mockPlace("a"), mockPlace("b"), mockPlace("c")], selectedPlaceIds: ["a", "b", "c"] });
  for (const from of ["hotel", "a", "b", "c"]) for (const to of ["hotel", "a", "b", "c"]) if (from !== to) trip.travelMinutes[`${from}->${to}`] = 10;
  const result = planItinerary(trip);
  assert.equal(result.days.length, 2);
  assert.deepEqual(result.days.map((day) => day.date), ["2026-11-24", "2026-11-25"]);
  const visited = flatten(result).filter((a) => a.kind === "visit").map((a) => a.place_id);
  assert.equal(visited.length, 3);
  assert.equal(new Set(visited).size, 3);
});

test("corridor and remote stops through the 150 km radius remain schedulable with mock road times", () => {
  const remote = mockPlace("remote", { distanceFromHotelKm: 150 });
  const trip = mockTrip({ places: [remote], selectedPlaceIds: ["remote"], travelMinutes: { "hotel->remote": 180, "remote->hotel": 180 } });
  assert.equal(planItinerary(trip).status, "feasible");
  assert.throws(() => planItinerary({ ...trip, places: [mockPlace("too-far", { distanceFromHotelKm: 150.1 })] }), /through 150/);
});

test("confirmed closed and last-entry-infeasible places are retained as unscheduled", () => {
  const closed = mockPlace("closed", { openingHours: { 2: [] } });
  const late = mockPlace("late", { openingHours: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [{ open: "09:00", close: "18:00", lastEntry: "09:00" }]])) });
  const result = planItinerary(mockTrip({ places: [closed, late], selectedPlaceIds: ["closed", "late"] }));
  assert.equal(result.status, "needs_review");
  assert.deepEqual(result.unscheduled.map((stop) => stop.place_id), ["closed", "late"]);
  assert.ok(result.unscheduled.every((stop) => stop.selected));
});

test("unknown hours remain explicitly uncertain and unknown duration is not invented", () => {
  const unknownHours = mockPlace("hours", { openingHours: {} });
  const unknownDuration = mockPlace("duration", { visitMinutes: null });
  const result = planItinerary(mockTrip({ places: [unknownHours, unknownDuration], selectedPlaceIds: ["hours", "duration"], travelMinutes: { "hotel->hours": 20, "hours->hotel": 20, "hotel->duration": 20 } }));
  assert.equal(result.status, "needs_review");
  assert.equal(flatten(result).find((a) => a.kind === "visit" && a.place_id === "hours").uncertainty, "unknown_hours");
  assert.match(result.unscheduled.find((stop) => stop.place_id === "duration").reason, /duration is unknown/);
});

test("unknown road legs have null times and selected stops are not silently dropped", () => {
  const result = planItinerary(mockTrip({ places: [mockPlace("a")], selectedPlaceIds: ["a"], travelMinutes: { "hotel->a": null, "a->hotel": null } }));
  assert.equal(result.status, "needs_review");
  assert.match(result.unscheduled[0].reason, /travel time.*unknown/);
  assert.equal(flatten(result).filter((a) => a.kind === "visit").length, 0);
});

test("a known return leg that cannot fit is exposed as an untimed impossible constraint", () => {
  const result = planItinerary(mockTrip({ places: [mockPlace("far")], selectedPlaceIds: ["far"], travelMinutes: { "hotel->far": 20, "far->hotel": 720 } }));
  const returnLeg = flatten(result).find((activity) => activity.kind === "travel" && activity.place_id === "hotel");
  assert.equal(result.status, "needs_review");
  assert.equal(returnLeg.starts_at, null);
  assert.match(returnLeg.constraint_notes[0], /does not fit/);
});

test("meals, rest, and activities never overlap; breakfast ends before lunch starts", () => {
  const trip = mockTrip({ days: 3, places: Array.from({ length: 9 }, (_, i) => mockPlace(`p${i}`)), selectedPlaceIds: Array.from({ length: 9 }, (_, i) => `p${i}`) });
  for (const from of ["hotel", ...trip.places.map((p) => p.id)]) for (const to of ["hotel", ...trip.places.map((p) => p.id)]) if (from !== to) trip.travelMinutes[`${from}->${to}`] = 15;
  const result = planItinerary(trip);
  assert.equal(overlaps(result), false);
  for (const day of result.days) {
    const breakfast = day.activities.find((a) => a.kind === "breakfast");
    const lunch = day.activities.find((a) => a.kind === "lunch");
    assert.ok(breakfast.ends_at <= lunch.starts_at);
    assert.ok(day.activities.some((a) => a.kind === "rest"));
  }
});

test("impossible meal windows are rejected instead of producing overlapping output", () => {
  assert.throws(() => planItinerary(mockTrip({ policy: { lunch: { start: "07:45", end: "08:15" } } })), /must not overlap/);
});

test("same input and fixed seed generated scenarios produce deterministic, non-overlapping plans", () => {
  let seed = 43117;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x1_0000_0000; };
  for (let scenario = 0; scenario < 40; scenario++) {
    const count = 1 + Math.floor(rand() * 7);
    const places = Array.from({ length: count }, (_, i) => mockPlace(`s${scenario}-${i}`, { visitMinutes: 30 + Math.floor(rand() * 100), importance: Math.floor(rand() * 10) }));
    const ids = ["hotel", ...places.map((p) => p.id)];
    const travelMinutes = {};
    for (const from of ids) for (const to of ids) if (from !== to) travelMinutes[`${from}->${to}`] = 5 + Math.floor(rand() * 50);
    const trip = mockTrip({ days: 1 + Math.floor(rand() * 3), places, selectedPlaceIds: places.map((p) => p.id), travelMinutes });
    const first = planItinerary(trip), second = planItinerary(trip);
    assert.deepEqual(first, second, `scenario ${scenario}`);
    assert.equal(overlaps(first), false, `scenario ${scenario}`);
  }
});

test("delay rescheduling starts from the current stop and preserves every selected future stop", () => {
  const trip = mockTrip({ places: [mockPlace("a"), mockPlace("b"), mockPlace("c")], selectedPlaceIds: ["a", "b", "c"] });
  for (const from of ["hotel", "a", "b", "c"]) for (const to of ["hotel", "a", "b", "c"]) if (from !== to) trip.travelMinutes[`${from}->${to}`] = 15;
  const original = planItinerary(trip);
  const result = rescheduleItinerary(original, trip, 35, "a");
  assert.deepEqual(result.selected_place_ids, ["a", "b", "c"]);
  assert.equal(flatten(result).some((a) => a.kind === "visit" && a.place_id === "a"), false);
  const currentVisit = flatten(original).find((a) => a.kind === "visit" && a.place_id === "a");
  const nextVisit = flatten(result).find((a) => a.kind === "visit" && a.place_id === "b");
  assert.ok(nextVisit);
  assert.ok(Date.parse(nextVisit.starts_at) >= Date.parse(currentVisit.ends_at) + 50 * 60_000);
  assert.ok(flatten(result).some((a) => a.kind === "visit" && a.place_id === "c"));
  assert.equal(overlaps(result), false);
  assert.throws(() => rescheduleItinerary(original, trip, 35, "missing"), /scheduled visit/);
});

test("rescheduling omits same-day fixed activities before the delayed start", () => {
  const trip = mockTrip();
  const original = planItinerary(trip);
  const currentVisit = flatten(original).find((activity) => activity.kind === "visit" && activity.place_id === "a");
  assert.ok(currentVisit?.ends_at);
  const earliest = Date.parse(currentVisit.ends_at) + 90 * 60_000;
  const result = rescheduleItinerary(original, trip, 90, "a");
  const currentDay = result.days.find((day) => day.date === currentVisit.starts_at.slice(0, 10));
  assert.ok(currentDay);
  const beforeDelayedStart = currentDay.activities.filter((activity) => activity.starts_at && Date.parse(activity.starts_at) < earliest);
  assert.deepEqual(beforeDelayedStart, []);
});
test("invalid trip window and date offset fail fast", () => {
  assert.throws(() => planItinerary(mockTrip({ days: 22 })), /days must be/);
  assert.throws(() => planItinerary(mockTrip({ utcOffset: "local" })), /explicit offset/);
});
