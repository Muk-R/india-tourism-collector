export type TimeWindow = { open: string; close: string; lastEntry?: string | null };

export type Place = {
  id: string;
  name: string;
  visitMinutes: number | null;
  /** Local weekday hours (0=Sunday). null means unknown; [] means confirmed closed. */
  openingHours: Record<number, TimeWindow[] | null>;
  importance?: number | null;
  /** Optional supplied distance from the hotel/corridor origin; never inferred by this engine. */
  distanceFromHotelKm?: number | null;
};

export type TripRequest = {
  startDate: string;
  days: number;
  /** Explicit numeric offset, such as +05:30, needed to produce contract date-times. */
  utcOffset: string;
  hotelId: string;
  /** Optional location for the first day after a delay. */
  startingLocationId?: string;
  places: Place[];
  selectedPlaceIds?: string[];
  /** Road travel estimates in minutes. Missing or null values stay explicitly unknown. */
  travelMinutes: Record<string, number | null>;
  policy?: Partial<SchedulePolicy>;
};

export type SchedulePolicy = {
  dayStart: string;
  dayEnd: string;
  breakfast: { start: string; end: string };
  lunch: { start: string; end: string };
  rest: { start: string; end: string };
  dinner: { start: string; end: string };
};

export type Activity = {
  place_id: string | null;
  kind: "visit" | "breakfast" | "lunch" | "dinner" | "rest" | "travel";
  starts_at: string | null;
  ends_at: string | null;
  travel_minutes_from_previous: number | null;
  constraint_notes: string[];
  uncertainty?: "unknown_duration" | "unknown_hours" | "unknown_travel";
};

export type PlannedDay = { date: string; activities: Activity[] };
export type UnscheduledStop = { place_id: string; selected: boolean; reason: string };
export type Itinerary = {
  status: "proposed" | "feasible" | "partial" | "needs_review";
  days: PlannedDay[];
  selected_place_ids: string[];
  unscheduled: UnscheduledStop[];
  constraint_notes: string[];
};

const DEFAULT_POLICY: SchedulePolicy = {
  dayStart: "08:00", dayEnd: "21:00",
  breakfast: { start: "07:30", end: "08:00" },
  lunch: { start: "12:30", end: "13:15" },
  rest: { start: "15:30", end: "16:00" },
  dinner: { start: "19:00", end: "19:45" },
};

const minute = (value: string): number => {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error(`Invalid local time: ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
};
const offsetMinutes = (value: string): number => {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(value);
  if (!match || Number(match[2]) > 14 || Number(match[3]) > 59) throw new Error("utcOffset must be an explicit offset such as +05:30");
  return (match[1] === "+" ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3]));
};
const key = (from: string, to: string) => `${from}->${to}`;
const dateAt = (date: string, mins: number, offset: string) => `${date}T${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}:00${offset}`;
const localWeekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
const addDays = (date: string, count: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + count);
  return d.toISOString().slice(0, 10);
};
const validDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`));

function checkRequest(input: TripRequest) {
  if (!validDate(input.startDate)) throw new Error("startDate must be a valid YYYY-MM-DD date");
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > 21) throw new Error("days must be an integer from 1 through 21");
  offsetMinutes(input.utcOffset);
  if (!input.hotelId) throw new Error("hotelId is required");
  const ids = input.places.map((place) => place.id);
  if (new Set(ids).size !== ids.length || ids.includes(input.hotelId)) throw new Error("place IDs must be unique and distinct from hotelId");
  for (const place of input.places) {
    if (place.visitMinutes !== null && (!Number.isInteger(place.visitMinutes) || place.visitMinutes <= 0)) throw new Error(`Invalid visit duration for ${place.id}`);
    if (place.importance != null && !Number.isFinite(place.importance)) throw new Error(`Invalid importance for ${place.id}`);
    if (place.distanceFromHotelKm != null && (!Number.isFinite(place.distanceFromHotelKm) || place.distanceFromHotelKm < 0 || place.distanceFromHotelKm > 150)) throw new Error(`distanceFromHotelKm for ${place.id} must be from 0 through 150`);
    for (const [weekday, windows] of Object.entries(place.openingHours)) {
      if (!Number.isInteger(Number(weekday)) || Number(weekday) < 0 || Number(weekday) > 6) throw new Error(`Invalid weekday for ${place.id}`);
      for (const window of windows ?? []) {
        const start = minute(window.open), close = minute(window.close);
        if (close <= start || (window.lastEntry && (minute(window.lastEntry) < start || minute(window.lastEntry) > close))) throw new Error(`Invalid opening window for ${place.id}`);
      }
    }
  }
}

function routeOrder(places: Place[], hotelId: string, travel: TripRequest["travelMinutes"]) {
  const remaining = new Map(places.map((place) => [place.id, place]));
  const ordered: Place[] = [];
  let at = hotelId;
  while (remaining.size) {
    const options = [...remaining.values()].sort((a, b) => {
      const ta = travel[key(at, a.id)], tb = travel[key(at, b.id)];
      const da = ta == null ? Number.POSITIVE_INFINITY : ta;
      const db = tb == null ? Number.POSITIVE_INFINITY : tb;
      return da - db || (b.importance ?? -Infinity) - (a.importance ?? -Infinity) || a.id.localeCompare(b.id);
    });
    const next = options[0];
    ordered.push(next);
    remaining.delete(next.id);
    at = next.id;
  }
  return ordered;
}

function openingFit(place: Place, date: string, earliest: number, latest: number, duration: number) {
  const weekday = localWeekday(date);
  if (!(weekday in place.openingHours) || place.openingHours[weekday] === null) {
    return { start: earliest, note: "Opening hours are unknown; verify before travel.", uncertainty: "unknown_hours" as const };
  }
  const windows = place.openingHours[weekday] ?? [];
  for (const window of windows) {
    const opens = minute(window.open), closes = minute(window.close);
    const lastEntry = window.lastEntry ? minute(window.lastEntry) : closes;
    const start = Math.max(earliest, opens);
    if (start <= lastEntry && start + duration <= Math.min(closes, latest)) return { start, note: undefined, uncertainty: undefined };
  }
  return undefined;
}

function activity(input: { date: string; offset: string; start: number; end: number; kind: Activity["kind"]; placeId?: string | null; travel?: number | null; notes?: string[]; uncertainty?: Activity["uncertainty"] }): Activity {
  return {
    place_id: input.placeId ?? null, kind: input.kind,
    starts_at: dateAt(input.date, input.start, input.offset), ends_at: dateAt(input.date, input.end, input.offset),
    travel_minutes_from_previous: input.travel ?? null, constraint_notes: input.notes ?? [],
    ...(input.uncertainty ? { uncertainty: input.uncertainty } : {}),
  };
}

export function planItinerary(input: TripRequest): Itinerary {
  checkRequest(input);
  const policy = { ...DEFAULT_POLICY, ...input.policy };
  const bounds = { start: minute(policy.dayStart), end: minute(policy.dayEnd) };
  if (bounds.end <= bounds.start) throw new Error("dayEnd must be later than dayStart");
  const fixed = [
    { kind: "breakfast" as const, span: policy.breakfast }, { kind: "lunch" as const, span: policy.lunch },
    { kind: "rest" as const, span: policy.rest }, { kind: "dinner" as const, span: policy.dinner },
  ].map(({ kind, span }) => ({ kind, start: minute(span.start), end: minute(span.end) })).sort((a, b) => a.start - b.start);
  for (let i = 0; i < fixed.length; i++) {
    if (fixed[i].end <= fixed[i].start || (i > 0 && fixed[i].start < fixed[i - 1].end)) throw new Error("Meal and rest windows must not overlap");
    if (fixed[i].end > bounds.end || (fixed[i].kind !== "breakfast" && fixed[i].start < bounds.start)) throw new Error("Meal and rest windows must fit within the day bounds");
  }
  const selected = [...new Set(input.selectedPlaceIds ?? [])].sort();
  const selectedSet = new Set(selected);
  const missing = selected.filter((id) => !input.places.some((place) => place.id === id));
  const pending = routeOrder(input.places, input.startingLocationId ?? input.hotelId, input.travelMinutes);
  const days: PlannedDay[] = [];
  const reasons = new Map<string, string>();
  const scheduled = new Set<string>();
  let returnLegImpossible = false;
  const offset = input.utcOffset;

  for (let dayIndex = 0; dayIndex < input.days; dayIndex++) {
    const date = addDays(input.startDate, dayIndex);
    const activities: Activity[] = [];
    for (const item of fixed) {
      activities.push(activity({ date, offset, start: item.start, end: item.end, kind: item.kind, notes: item.kind === "rest" ? ["Scheduled rest break."] : [] }));
    }
    let location = dayIndex === 0 ? input.startingLocationId ?? input.hotelId : input.hotelId;
    let cursor = bounds.start;
    let lastVisitEnd: number | undefined;
    let dayHasVisit = false;
    for (const slot of [{ start: bounds.start, end: fixed[0].start > bounds.start ? fixed[0].start : bounds.start }, ...fixed.map((f, i) => ({ start: Math.max(bounds.start, f.end), end: fixed[i + 1]?.start ?? bounds.end }))]) {
      cursor = Math.max(cursor, slot.start);
      while (cursor < slot.end) {
        let choice: { place: Place; travel: number; start: number; uncertainty?: "unknown_hours" } | undefined;
        for (const place of pending) {
          if (scheduled.has(place.id)) continue;
          if (place.visitMinutes === null) { reasons.set(place.id, "Visit duration is unknown; provide a sourced or user-selected duration."); continue; }
          const travel = input.travelMinutes[key(location, place.id)];
          if (travel == null) { reasons.set(place.id, `Road travel time from ${location} is unknown.`); continue; }
          if (!Number.isInteger(travel) || travel < 0) throw new Error(`Invalid road travel estimate for ${location} -> ${place.id}`);
          const fit = openingFit(place, date, cursor + travel, slot.end, place.visitMinutes);
          if (!fit) continue;
          choice = { place, travel, start: fit.start, uncertainty: fit.uncertainty };
          break;
        }
        if (!choice) break;
        const { place, travel, start, uncertainty } = choice;
        const visitStart = start;
        const travelStart = visitStart - travel;
        if (travel > 0) activities.push(activity({ date, offset, start: travelStart, end: travelStart + travel, kind: "travel", placeId: place.id, travel, notes: [`Road travel estimate: ${travel} minutes.`] }));
        activities.push(activity({ date, offset, start: visitStart, end: visitStart + place.visitMinutes!, kind: "visit", placeId: place.id, travel, notes: uncertainty ? ["Hours were not supplied; this visit time is an unverified planning estimate."] : [], uncertainty }));
        cursor = visitStart + place.visitMinutes!;
        lastVisitEnd = cursor;
        location = place.id;
        scheduled.add(place.id);
        dayHasVisit = true;
        reasons.delete(place.id);
      }
    }
    if (dayHasVisit && location !== input.hotelId) {
      const back = input.travelMinutes[key(location, input.hotelId)];
      if (back == null) {
        reasons.set(location, `Road travel time from ${location} back to hotel ${input.hotelId} is unknown.`);
        activities.push({ place_id: input.hotelId, kind: "travel", starts_at: null, ends_at: null, travel_minutes_from_previous: null, constraint_notes: [`Road travel time from ${location} back to hotel ${input.hotelId} is unknown.`], uncertainty: "unknown_travel" });
      }
      else if (!Number.isInteger(back) || back < 0) throw new Error(`Invalid road travel estimate for ${location} -> ${input.hotelId}`);
      else {
        let backStart = lastVisitEnd ?? cursor;
        for (const fixedActivity of activities.filter((item) => item.kind === "breakfast" || item.kind === "lunch" || item.kind === "rest" || item.kind === "dinner")) {
          if (fixedActivity.starts_at && fixedActivity.ends_at) {
            const fixedStart = minute(fixedActivity.starts_at.slice(11, 16));
            const fixedEnd = minute(fixedActivity.ends_at.slice(11, 16));
            if (backStart < fixedEnd && backStart + back > fixedStart) backStart = fixedEnd;
          }
        }
        if (backStart + back <= bounds.end) {
          if (back > 0) activities.push(activity({ date, offset, start: backStart, end: backStart + back, kind: "travel", placeId: input.hotelId, travel: back, notes: [`Road travel estimate: ${back} minutes back to hotel.`] }));
        } else {
          reasons.set(location, "Return road travel to hotel does not fit before the day end.");
          returnLegImpossible = true;
          activities.push({ place_id: input.hotelId, kind: "travel", starts_at: null, ends_at: null, travel_minutes_from_previous: back, constraint_notes: [`Known return travel time (${back} minutes) does not fit before the day end.`] });
        }
      }
    }
    activities.sort((a, b) => (a.starts_at ?? "").localeCompare(b.starts_at ?? "") || a.kind.localeCompare(b.kind));
    days.push({ date, activities });
  }

  for (const place of pending) if (!reasons.has(place.id) && !days.some((day) => day.activities.some((a) => a.kind === "visit" && a.place_id === place.id))) {
    reasons.set(place.id, "No opening-hours and schedule window fit was found within the trip.");
  }
  const unscheduled: UnscheduledStop[] = [
    ...pending.filter((place) => !days.some((day) => day.activities.some((a) => a.kind === "visit" && a.place_id === place.id)))
      .map((place) => ({ place_id: place.id, selected: selectedSet.has(place.id), reason: reasons.get(place.id) ?? "Could not fit within the trip schedule." })),
    ...missing.map((id) => ({ place_id: id, selected: true, reason: "Selected place was not included in the supplied place data." })),
  ].sort((a, b) => a.place_id.localeCompare(b.place_id));
  const unknownHours = days.some((day) => day.activities.some((a) => a.uncertainty === "unknown_hours"));
  const unresolvedSelected = unscheduled.some((stop) => stop.selected);
  const anyUncertain = unknownHours || unscheduled.length > 0 || days.some((day) => day.activities.some((a) => a.uncertainty !== undefined));
  const constraintNotes = [
    ...(unknownHours ? ["Some scheduled visits have unknown opening hours."] : []),
    ...(days.some((day) => day.activities.some((a) => a.uncertainty === "unknown_travel")) ? ["One or more travel legs have unknown estimates; those activities have no fabricated times."] : []),
    ...(returnLegImpossible ? ["A known return leg does not fit before the day end; the proposal needs review."] : []),
    ...(unresolvedSelected ? ["One or more selected places remain unscheduled; see unscheduled for the reason."] : []),
    ...(unscheduled.some((stop) => stop.reason.includes("unknown")) ? ["Unknown durations or road travel times were not replaced with fabricated values."] : []),
  ];
  const hasVisits = days.some((day) => day.activities.some((a) => a.kind === "visit"));
  return { status: unresolvedSelected || returnLegImpossible || days.some((day) => day.activities.some((a) => a.uncertainty === "unknown_travel")) ? "needs_review" : anyUncertain || !hasVisits ? "partial" : "feasible", days, selected_place_ids: selected, unscheduled, constraint_notes: constraintNotes };
}

export function rescheduleItinerary(original: Itinerary, request: TripRequest, delayMinutes: number, currentPlaceId?: string): Itinerary {
  if (!Number.isInteger(delayMinutes) || delayMinutes < 1 || delayMinutes > 1440) throw new Error("delayMinutes must be an integer from 1 through 1440");
  const selected = [...new Set([...original.selected_place_ids, ...request.selectedPlaceIds ?? []])];
  const orderedVisits = original.days.flatMap((day) => day.activities)
    .filter((activity) => activity.kind === "visit" && activity.place_id)
    .map((activity) => activity.place_id!);
  const currentIndex = currentPlaceId ? orderedVisits.indexOf(currentPlaceId) : -1;
  if (currentPlaceId && currentIndex < 0) throw new Error("currentPlaceId must identify a scheduled visit in the original itinerary");
  const current = currentPlaceId ? request.places.find((place) => place.id === currentPlaceId) : undefined;
  const remainingIds = new Set([
    ...orderedVisits.slice(currentIndex >= 0 ? currentIndex + 1 : 0),
    ...original.unscheduled.filter((stop) => stop.selected).map((stop) => stop.place_id),
  ]);
  const remainingPlaces = request.places.filter((place) => remainingIds.has(place.id));
  const currentDayIndex = currentPlaceId ? original.days.findIndex((day) => day.activities.some((activity) => activity.kind === "visit" && activity.place_id === currentPlaceId)) : 0;
  const currentDay = original.days[currentDayIndex];
  const currentActivity = currentDay?.activities.find((activity) => activity.kind === "visit" && activity.place_id === currentPlaceId);
  let start = currentDay?.date ?? original.days[0]?.date ?? request.startDate;
  let startMinute = currentActivity?.ends_at
    ? minute(currentActivity.ends_at.slice(11, 16)) + delayMinutes
    : minute(request.policy?.dayStart ?? DEFAULT_POLICY.dayStart) + delayMinutes;
  let remainingDays = Math.max(1, request.days - Math.max(0, currentDayIndex));
  while (startMinute >= 24 * 60) {
    start = addDays(start, 1);
    startMinute -= 24 * 60;
    remainingDays = Math.max(1, remainingDays - 1);
  }
  const dayEnd = minute(request.policy?.dayEnd ?? DEFAULT_POLICY.dayEnd);
  if (startMinute >= dayEnd) {
    start = addDays(start, 1);
    startMinute = minute(request.policy?.dayStart ?? DEFAULT_POLICY.dayStart);
    remainingDays = Math.max(1, remainingDays - 1);
  }
  startMinute = Math.max(startMinute, minute(request.policy?.dayStart ?? DEFAULT_POLICY.dayStart));
  const futureSelected = selected.filter((id) => remainingIds.has(id));
  const updated = planItinerary({ ...request, startDate: start, days: remainingDays, places: remainingPlaces, startingLocationId: current?.id, selectedPlaceIds: futureSelected, policy: { ...request.policy, dayStart: `${String(Math.floor(startMinute / 60)).padStart(2, "0")}:${String(startMinute % 60).padStart(2, "0")}` } });
  updated.selected_place_ids = selected;
  const retained = new Set(updated.days.flatMap((day) => day.activities.filter((a) => a.kind === "visit").map((a) => a.place_id)));
  const priorUnscheduled = original.unscheduled.filter((stop) => stop.selected);
  const addedUnscheduled = priorUnscheduled.filter((stop) => !updated.unscheduled.some((next) => next.place_id === stop.place_id) && !retained.has(stop.place_id));
  updated.unscheduled.push(...addedUnscheduled);
  updated.unscheduled.sort((a, b) => a.place_id.localeCompare(b.place_id));
  if (updated.unscheduled.some((stop) => stop.selected)) updated.status = "needs_review";
  return updated;
}

/** The included fixtures in test/fixtures.ts are invented mock values, not collected tourism data. */
