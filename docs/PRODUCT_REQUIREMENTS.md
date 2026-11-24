# Localise product requirements

Localise must function as an intelligent personal tour guide: help travelers understand destinations, discover worthwhile places, plan realistic trips, and adapt when plans change.

## Experience
- Mobile-first, modern, accessible design.
- Soft matte-glass cards, subtle depth and shadows, restrained highlights, readable content, and good performance.
- Bottom navigation for Home, Itineraries, Social, and other useful destinations.
- City landing pages summarize historical significance and showcase famous landmarks, with attribution for sourced history.

## Tourism data
- Rank attractions by importance, fame, type, and distance; famous and historically important places take priority.
- Keep importance scores separate from data-quality scores. Do not penalize attractions for being far from hotels or settlements.
- Validate collection radius as an integer from 10 to 150 km; default is 40 km.
- Include remote peaks, waterfalls, viewpoints, and other important attractions throughout the requested area.
- Maximize hotel and restaurant coverage across neighborhoods, near attractions, and along tourist travel corridors.
- Classify lodging by budget, mid-tier, star rating, and accommodation type only when sources support it.
- Classify restaurants as vegetarian, non-vegetarian, multicuisine, and regional cuisine only when sources support it. Never infer dietary status from names or cuisine alone.
- Preserve source IDs, useful raw metadata, historical descriptions, attribution, and licensing. Do not silently truncate discovery. Use source-appropriate pagination or geographic subdivision and resumable checkpoints.
- Represent missing facts as unknown; do not fabricate.

## Itineraries
Build realistic short and multi-day plans using attraction-specific visit durations, road travel times between all destinations, opening hours and last-entry times, meal windows, rest breaks, and hotel locations. Support hotel-based day trips and corridors. Do not schedule breakfast and lunch together or create overlapping/impossible activities. Recalculate the remaining schedule after delays without silently discarding selected stops. Prefer deterministic, testable optimization and report unresolved constraints.

## Rollout
Pilot Hyderabad, then 3-5 diverse destinations after quality review; long-term target approximately 500 Indian cities. During development, public collection must be bounded, rate-limited, source-compliant, and stored only in isolated local storage.

## Storage and media
Keep development worktrees, databases, logs, and data on C: only. Warn below 30 GB free and pause storage-intensive tasks below 20 GB; check every 15 minutes during collection and retain checkpoints. Store image URLs plus licensing/attribution metadata rather than bulk-downloading photographs. Compress large raw archives where useful, avoid duplicate dependencies/datasets, and never delete user files or databases.
