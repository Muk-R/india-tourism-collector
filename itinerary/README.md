# Deterministic itinerary engine

This module plans locally timed, one-day and multi-day trips without UI, Worker,
database, or routing-provider dependencies. `planItinerary` accepts attraction
durations, weekday opening windows and last-entry times, a hotel, selected stop
IDs, and caller-supplied road travel minutes for each leg. `rescheduleItinerary`
rebuilds future visits after a delay from the current stop when supplied and
preserves unserved selected stops in the result or its explicit `unscheduled`
list.

Every output day contains meal and rest blocks plus timed road legs when their
travel estimate is known. Missing duration or road time is never filled with a
guessed value. Such selected stops remain visible with a reason; unknown opening
hours can be planned tentatively and are marked `unknown_hours`. Timestamps
include the caller's explicit numeric UTC offset. The schedule policy defaults
are configurable planning preferences, not sourced venue or restaurant data.

`itinerary/test/fixtures.ts` contains invented mock places and road times for
tests only. They are not collected or verified tourism data.

## Contract mapping request

The planned OpenAPI `ItineraryRequest` currently supplies city, dates, days,
hotel ID, selected place IDs, and travel mode. Integration should add (or define
a provider that supplies) each selected place's visit duration and weekday
opening windows/last-entry, the hotel's and places' location identifiers, an
estimate and uncertainty/source marker for every road leg, and the trip's local
UTC offset. The current `Itinerary` activity shape maps the scheduled
`place_id`, `kind`, ISO timestamps, and `travel_minutes_from_previous`; it needs
an uncertainty field and an explicit unscheduled-selected-stops/constraint
section so partial plans cannot hide selected attractions. No shared contract
was changed in this worktree.

## Local tests

Run from the repository root with Node 26 or newer:

```powershell
node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test itinerary/test/itinerary.test.mjs
```
