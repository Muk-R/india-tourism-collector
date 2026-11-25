# Localise product requirements

Localise is an attraction-centric guided tourism platform. Help travelers discover significant places, understand their history and culture, choose convenient stays, experience authentic local food, and build realistic trips. Quality of travel guidance matters more than public listing volume.

These decisions supersede earlier restrictive public catalog limits for food and accommodation. They do not change source licensing, editorial review, security, routing, or production approval gates.

## Experience and website presentation

- Mobile-first, accessible, visually informative and concise.
- Retain the approved matte-glass design, readable content, subtle depth and shadows, responsive layouts, and existing navigation patterns.
- Home content order: city introduction and historical significance; must-see attractions; food split into Must-Try Local Food and Everyday Dining; recommended stays split into Budget, Mid-range and Premium; nearby escapes; itineraries or a selected day plan; maps.
- Keep only a small curated preview of each category on the home page. Expanded categories support pagination, search, geographic filters and visitor preferences.
- Do not expose the raw collected dataset as an unfiltered public directory.
- Explain source attribution where the content appears. Label editorial recommendations separately from verified customer ratings.

## Attractions — highest content priority

- Maintain a curated public catalog of up to 100 meaningful attractions per city, based on actual significance and available evidence. Do not fill a quota with weak candidates.
- Classify attractions as **Must Visit**, **Highly Recommended**, or **Explore More / Hidden Gems**.
- Rank using sourced historical and cultural significance, tourism importance, popularity, visitor experience and verified ratings when available. Keep editorial importance, customer ratings and data-quality scores separate.
- Provide historical and cultural summaries, licensed images, opening hours, entry fees, estimated visit durations and nearby recommendations only when supported by usable sources and reuse terms. Unknown values remain unknown.
- Use distinct browse and navigation/itinerary gates. A reviewed place may be browsable or mapped while still lacking a verified entrance, current access, hours or duration. Unverified places remain unroutable and unschedulable where the missing fact matters.

## Accommodation

- For each major city, target at least 30 qualifying recommended stays: at least 10 budget, 10 mid-range and 10 premium. These are minimum coverage targets, not maximum limits. Scale coverage for larger cities and available tourism demand.
- Distribute stays across tourism zones and attraction clusters; do not concentrate coverage in one neighborhood.
- Use configurable price tiers appropriate to each city. Assign tiers, price ranges, amenities, accessibility, business status, hotel star classification and guest ratings only from reliable evidence.
- Rank stays using verified guest ratings and review volume, quality, price, amenities, accessibility and combined travel time to the visitor's selected attractions. Keep hotel stars distinct from guest ratings.
- Never invent prices, hotel classes, ratings, operating status or facilities.

## Food — two primary categories

### Must-Try Local Food

Treat food as a tourism experience. Include signature dishes, authentic regional cuisine, famous restaurants, iconic street-food points, traditional cafés, local sweets and snacks, and historically significant food establishments where evidence supports them. There is no fixed cap on dishes or establishments. For each specialty, identify multiple reliable establishments across different parts of the city where available.

### Everyday Dining

Treat food as a practical travel need. Cover breakfast, lunch, dinner, snacks and refreshments; vegetarian and pure-vegetarian options; non-vegetarian options; multicuisine, family, affordable and premium dining. Scale coverage to population, tourism geography, attraction density and accommodation distribution. There is no restrictive city-wide restaurant count.

Classify cuisine, dietary suitability, meal availability, price and business status only when supported by reliable current evidence. Do not infer dietary claims from a name, cuisine tag or nearby venue.

## Attraction-centric recommendations

- Organize stays, food, nearby destinations and itineraries around selected attractions and visitor plans.
- Maintain multiple useful food and stay recommendations around significant attractions and accommodation clusters where source coverage supports them.
- Provide geographic coverage around attractions, hotels, tourism clusters, attraction-to-attraction corridors, transit locations and nearby escapes.
- Use configurable geographic search distances. Use road travel times only from a suitable verified provider or source; never label straight-line distance as road travel time.
- Let visitors choose authentic specialties or convenient everyday meals. Prefer diversity in price, cuisine and dietary preferences without unsafe inference.
- Avoid sending visitors on unnecessary detours solely to visit a higher-rated restaurant.

## Guided itineraries

- Prioritize the visitor's selected attractions and their verified access, opening hours, attraction-specific duration and road travel time.
- Schedule breakfast, lunch, dinner and rest breaks using the visitor's location, route and realistic timing. Offer multiple suitable food alternatives near the current attraction, next attraction or selected accommodation.
- For multi-day trips, use the chosen accommodation as the start and end point where routing evidence supports it; recommend stays that reduce combined travel time to selected attractions.
- Do not fabricate opening hours, entry fees, visit durations, travel times or operating status. Exclude time-critical unknowns from automatic schedules or clearly mark conditional plans.
- Recalculate remaining plans after delays without silently removing selected attractions. Prefer deterministic, testable optimization and expose unresolved constraints.

## Data architecture and source policy

Preserve existing comprehensive datasets and keep these layers distinct:

1. Raw source collection.
2. Validated discovery records.
3. Reviewed public catalog.
4. Location-specific personalized recommendations.
5. Itinerary-ready records.

Public catalog size and raw collection size are independent. Supporting food and accommodation records may be broad without creating an unfiltered visitor-facing directory. Reuse existing collectors, importers, schemas, APIs and frontend components; make additive changes only when demonstrated necessary. Preserve source identity, provenance, snapshot, attribution and license. Respect provider attribution, reuse, caching and storage restrictions. Keep quarantined and unreviewed records private.

## Ratings and enrichment

- Investigate licensed providers for customer ratings, review counts, business operating status and accommodation prices.
- Before requesting access or spending money, verify provider costs, terms, attribution, caching and storage restrictions.
- Do not present editorial importance scores as customer ratings. Distinguish hotel star classification from guest reviews.
- Optional external rating integration must not delay the current functional Hyderabad pilot. Until verified ratings exist, label editorial recommendations clearly.

## Rollout, performance and safety

- Continue the existing Hyderabad release preparation using validated datasets; do not restart extraction or discard completed work.
- Do not begin nationwide or 50-city collection. Additional-city integration follows the Hyderabad pilot.
- Keep collection bounded, rate-limited and source-compliant; store raw intake in isolated/private storage until review.
- Keep development worktrees, databases, logs and artifacts on C:. Warn below 30 GiB free and pause storage-intensive work below 20 GiB. Check every 15 minutes during collection and retain checkpoints.
- Store image URLs with attribution and license metadata instead of bulk-downloading photographs. Compress large archives when appropriate, avoid duplicate datasets/dependencies, and never delete user files or databases.
- Preserve licensing, editorial approval, authentication, authorization, RLS, data-integrity, and routing gates. Production database changes and deployment require explicit owner approval.
