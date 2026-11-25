import type { Place, TripRequest } from "../src/index.ts";

/** Invented fixture values for deterministic tests; they are not collected tourism data. */
export const mockPlace = (id: string, extra: Partial<Place> = {}): Place => ({
  id, name: `Mock ${id}`, visitMinutes: 60,
  openingHours: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [{ open: "09:00", close: "18:00", lastEntry: "17:00" }]])),
  ...extra,
});

export function mockTrip(overrides: Partial<TripRequest> = {}): TripRequest {
  const places = [mockPlace("a"), mockPlace("b")];
  const edges: Record<string, number | null> = {};
  for (const from of ["hotel", "a", "b"]) for (const to of ["hotel", "a", "b"]) if (from !== to) edges[`${from}->${to}`] = 20;
  return {
    startDate: "2026-11-24", days: 1, utcOffset: "+05:30", hotelId: "hotel", places,
    selectedPlaceIds: ["a", "b"], travelMinutes: edges, ...overrides,
  };
}
