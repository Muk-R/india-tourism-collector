# Agent task: itinerary engine
Branch: dev/itinerary

## Owned paths
- itinerary/** only
- Do not edit Worker, frontend, contracts, or shared tests. Request interface updates from integration/QA using your checkpoint.

## Work
Build an independent deterministic itinerary engine for short and multi-day trips, including day trips from a hotel and regions up to 150 km. Use attraction-specific visit durations, road travel times for every leg, opening hours/last-entry constraints, meal windows, rest breaks, and hotel locations. Schedule breakfast, lunch, and dinner realistically; never overlap breakfast and lunch. Prevent overlapping/impossible schedules. Support user-selected stops and deterministic route optimization. Recalculate remaining activities after delays without silently dropping selected attractions. Keep unknown durations/hours/travel estimates explicitly uncertain; never fabricate real-world data. Clearly label sample fixtures as mock.

## Acceptance and tests
Pure domain tests cover one-day, multi-day, corridor/remote 150 km, closed/last-entry places, unknown hours/durations, hotel day trips, meals/rest, no-overlap invariant, impossible constraints, deterministic output, and delay rescheduling preserving selected stops. Include varied generated scenarios with fixed seeds. Expose an API-neutral input/output model that can map to contracts/openapi.yaml.

## Dependencies and coordination
Keep scheduling independent from UI, Worker, and live routing APIs. Use mock travel-time fixtures until a supported provider integration is approved. Describe required API/domain fields in your checkpoint; do not silently alter the shared contract.

## Autonomous operation / approval
Read AGENTS.md first, inspect status, implement, test, debug, review, checkpoint, and commit milestones autonomously. Stop only for forbidden external/paid/destructive/credential access or a blocking product ambiguity; continue independent engine work.
