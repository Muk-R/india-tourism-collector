# Itinerary engine verification evidence

- Command: `node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test itinerary/test/itinerary.test.mjs`
- Result: 12 tests passed, 0 failed.
- Coverage includes single- and multi-day hotel trips, a mock 150 km corridor stop, closed and last-entry constraints, explicit unknown duration/hours/travel behavior, meals and rest, impossible meal and return constraints, deterministic output, rescheduling, and 40 fixed-seed generated scenarios.
- `git diff --check`: passed.
- All tourism-like places and road times are invented test fixtures. No real tourism data was collected or verified.
- TypeScript static typecheck was not available because no local TypeScript compiler is installed; dependencies were not downloaded.
