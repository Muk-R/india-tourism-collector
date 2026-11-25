# Session B validated dataset intake contract

This is an integration boundary for a future Session B handoff. It does not change or block Session B collection. Do not import or publish a multi-city dataset until the manifest and rows meet this contract and the importer has been generalized and tested against an isolated database.

## Handoff manifest

Provide one immutable manifest with:

- Schema version, dataset/snapshot ID, source artifact SHA-256, extraction timestamp, source snapshot identifier, and licensing/attribution statement.
- Per-city stable ID, canonical city/state, center latitude/longitude, requested radius, and expected unique membership counts.
- Per-city counts for accepted, quarantined, nearby-escape candidates, and category totals; counts may overlap by category but must be stated as such.
- Expected distinct source-key count and checksum of the sorted identity set, plus the exact source-row count.
- Extraction version and validation report; do not repeat extraction just to create this manifest.

## Record contract

Every place row must preserve the original OSM `source_type`, positive `source_id`, stable `source_key` (`node|way|relation` plus ID), source URL, unmodified raw tags, raw record, geometry method, source snapshot, license, and attribution. Preserve missing-name rows with a deterministic quarantine reason. Do not invent names, navigation points, hours, ratings, or visit durations.

Represent a place once per OSM source key and link it to every applicable city through explicit memberships. Distance and area classification are city-specific; a source entity may be core for one city and an escape candidate for another. Categories may overlap. Preserve unresolved identity and routing state as review-only/non-routable.

## Import and security expectations

- Import is additive, idempotent, and scoped by immutable snapshot plus source key; same identity/same content is a no-op, while conflicting content is rejected.
- Each batch is bounded and carries the manifest identity. Finalization reconciles all counts and freezes the snapshot; it does not publish records.
- Validate distances against each manifest city center and radius, not a hard-coded Hyderabad center or radius. Store city-scoped membership and classification explicitly.
- Keep staging tables and RPCs unavailable to public/authenticated roles over direct SQL and HTTP/PostgREST. Only the service role may call the import RPC.
- Test retries, duplicates across city membership, conflicting identities, missing-name quarantine, provenance, count mismatch, finalization freeze, RLS, and Worker HTTP behavior in a new disposable database.
- Public visibility requires a separate human approval path for each reviewed record. The staging importer must not set approval or itinerary readiness.

## Current compatibility gap

The verified Session A migration and Worker validator are intentionally Hyderabad-specific: `core_hyderabad` is the stored core class, validation uses the Hyderabad center, and staging rows are keyed to one snapshot. Session B's multi-city output must not be forced into this shape. Generalize the schema and validation in a separate reviewed change, then run isolated multi-city database and HTTP integration tests before accepting the dataset.
