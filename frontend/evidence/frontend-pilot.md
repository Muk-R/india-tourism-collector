# Frontend pilot evidence

Date: 2026-11-24

## Scope delivered

- Mobile-first home, city guide, itinerary, social, and saved views with keyboard-accessible hash navigation.
- Responsive layouts use a 760 px and 480 px mobile/tablet breakpoint and expand through desktop widths, with a 1440 px wide layout adjustment.
- Accessible skip link, named navigation, visible focus styles, reduced-motion support, labeled and live search results, current-page state, loading status, empty states, and render-error alert.
- Hyderabad and Jaipur sample guides are labeled mock. History, attraction details, dining, lodging, and itinerary content explicitly state that facts, attribution, hours, ratings, cuisine, and dietary details are unverified or unknown.
- No photographs, external image URLs, API calls, or runtime font downloads are used.

## Local checks

- `npm test`: 4 tests passed, 0 failed.
- `node --check app.js`: passed.
- `node --check data.js`: passed.
- `git diff --check`: passed after staging the frontend changes.

The checks cover route resolution, city search, mock-data safeguards, semantic navigation, focus/reduced-motion rules, and loading/empty/error UI markers. A graphical browser was not available in this environment, so viewport layout was reviewed from the responsive CSS and not screenshot-tested.
