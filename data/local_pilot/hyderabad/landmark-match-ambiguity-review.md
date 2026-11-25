# Hyderabad landmark name-match review

Review date: 2026-11-25
Input: validated local Southern India OSM snapshot `2026-11-23T21:21:17Z`; review-only evidence. No source rows were changed or merged.

## Golconda Fort

- `relation/9128913` is tagged `historic=fort`, `tourism=attraction`, and carries `wikidata=Q4141623` plus `wikipedia=en:Golconda`.
- `node/2461496897` is tagged `amenity=bus_station`, with the name `Golconda Fort`; its collector category is `transport` and it has no Wikidata/Wikipedia identifier.
- These records share a name but represent a landmark and a nearby transit facility, not duplicate attraction entities. Retain both under distinct categories; do not link the bus station as the fort.

## Taramati Baradari

- `node/4683189592` is tagged `tourism=attraction`, carries `wikidata=Q7685364` and `wikipedia=en:Taramati Baradari`, and includes an OSM `opening_hours` tag of `Mo-Su 11:00-17:00`.
- `way/790788316` is tagged `tourism=museum` and has the same name. The representative points are about 62 m apart by Haversine distance.
- The proximity and shared name suggest a possible same-site relationship, but do not establish whether the point and polygon describe one entity or distinct parts of a complex. Preserve both OSM source rows. The point's opening-hours tag is source metadata, not independently verified current access information.

## Handling

- Keep the exact-name report's `ambiguous_exact_name_candidates` status for both names; supplement it with the category/source-identity evidence above.
- Do not merge OSM identities or create canonical cross-source place links without further review.
- Continue to treat all draft landmark records as non-routable until coordinate/access requirements are independently satisfied.
