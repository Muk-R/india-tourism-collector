# Frontend pilot evidence

Date: 2026-11-24

## Scope delivered

- Mobile-first home, city guide, itinerary, social, and saved views with keyboard-accessible hash navigation.
- Responsive layouts use a 760 px and 480 px mobile/tablet breakpoint and expand through desktop widths, with a 1440 px wide layout adjustment.
- Accessible skip link, named navigation, visible focus styles, reduced-motion support, labeled and live search results, current-page state, loading status, empty states, and render-error alert.
- Hyderabad and Jaipur sample guides are labeled mock. History, attraction details, dining, lodging, and itinerary content explicitly state that facts, attribution, hours, ratings, cuisine, and dietary details are unverified or unknown.
- No photographs are downloaded and no runtime font requests are made. API-provided image URLs are shown only with available attribution and licence metadata.

## Public API follow-on

- Added a small browser API client for the existing `GET /public/cities` and `GET /public/places?city_id=...&limit=100` routes. The city list and place details now load from the configured Worker API and retain the existing visual design and hash navigation.
- Set `LOCALISE_CONFIG.apiBaseUrl` in `frontend/runtime-config.js` to the Worker base URL. Mock fallback is disabled by default and is available only when `LOCALISE_CONFIG.developmentMode` is explicitly set to `true`. API failures show a retryable error in normal mode; development fallback is labeled as mock content.
- Place cards render escaped names, descriptions, categories, source and licence metadata, optional coordinates, optional image attribution, and importance and data-quality scores as separate labels. Missing coordinates and scores are omitted. Food and stay records appear only when the API category is `restaurant` or `accommodation`; otherwise those records are absent, and mock entries remain labeled. Itinerary data is still mock.
- API regression tests use mocked `fetch`; no live API was called.

## Source-category filters and map links

- Added keyboard-accessible All, Attractions, Food, and Stays filters using place `category` values. `restaurant` maps to Food and `accommodation` maps to Stays; other nonempty source categories map to Attractions. Missing or blank categories stay in All and are identified as unclassified. No cuisine or star-rating claims are inferred.
- Records with numeric latitude and longitude inside geographic bounds get an outbound OpenStreetMap link. Invalid or missing coordinates omit both coordinates and the link. No map tiles or external map assets are loaded.

## Local checks

- `npm test`: 10 tests passed, 0 failed (includes mocked API requests, category grouping/filtering, invalid coordinate handling, and dynamic city routing/search).
- `node --check app.js`, `api.js`, `places.js`, `config.js`, and `runtime-config.js`: passed.
- `git diff --check`: passed after staging the frontend changes.

The checks cover route resolution, city search, mock-data safeguards, API route construction, malformed/error response handling, source-category grouping, geographic coordinate validation, semantic navigation, focus/reduced-motion rules, and loading/empty/error UI markers. A graphical browser was not available in this environment, so viewport layout was reviewed from the responsive CSS and not screenshot-tested.
