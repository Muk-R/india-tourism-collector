"""Find exact-name OSM candidates for draft landmarks without validating identity."""

from __future__ import annotations

import argparse
import json
import sys
import unicodedata
from pathlib import Path
from typing import Any, Iterable


def _normalize_name(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = " ".join(unicodedata.normalize("NFKC", value).casefold().split())
    return normalized or None


def audit_landmarks(landmark_document: dict[str, Any], records: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Return exact-name candidate links; never approve or promote draft records."""
    if not isinstance(landmark_document, dict) or not isinstance(landmark_document.get("landmarks"), list):
        raise ValueError("landmark document must contain a landmarks array")

    index: dict[str, list[dict[str, Any]]] = {}
    candidates_by_key: dict[str, dict[str, Any]] = {}
    candidate_names: dict[str, set[str]] = {}
    for record in records:
        if not isinstance(record, dict):
            continue
        source_key = record.get("source_key")
        source_url = record.get("source_url")
        latitude, longitude = record.get("latitude"), record.get("longitude")
        if not isinstance(source_key, str) or not isinstance(source_url, str):
            continue
        if isinstance(latitude, bool) or not isinstance(latitude, (int, float)):
            continue
        if isinstance(longitude, bool) or not isinstance(longitude, (int, float)):
            continue
        names = {record.get("name")}
        variants = record.get("name_variants")
        if isinstance(variants, dict):
            names.update(variants.values())
        candidate = {
            "source_key": source_key,
            "name": record.get("name"),
            "categories": record.get("categories", []),
            "latitude": latitude,
            "longitude": longitude,
            "distance_km": record.get("distance_km"),
            "area_class": record.get("area_class"),
            "source_url": source_url,
            "source_snapshot": record.get("source_snapshot"),
            "attribution": record.get("attribution"),
            "license": record.get("license"),
        }
        candidates_by_key[source_key] = candidate
        candidate_names.setdefault(source_key, set())
        for name in names:
            normalized = _normalize_name(name)
            if normalized:
                candidate_names[source_key].add(normalized)
                index.setdefault(normalized, []).append(candidate)

    output: list[dict[str, Any]] = []
    for landmark in landmark_document["landmarks"]:
        if not isinstance(landmark, dict):
            raise ValueError("each landmark must be an object")
        normalized_name = _normalize_name(landmark.get("name"))
        matches_by_key = {
            match["source_key"]: match
            for match in index.get(normalized_name, [])
        } if normalized_name else {}
        matches = [matches_by_key[key] for key in sorted(matches_by_key)]
        suggestions: list[dict[str, Any]] = []
        if not matches and normalized_name:
            query_tokens = set(normalized_name.split())
            for source_key, normalized_names in candidate_names.items():
                best: tuple[float, list[str]] | None = None
                for candidate_name in sorted(normalized_names):
                    candidate_tokens = set(candidate_name.split())
                    shared = sorted(query_tokens & candidate_tokens)
                    union = query_tokens | candidate_tokens
                    score = len(shared) / len(union) if union else 0.0
                    if len(shared) >= 2 and score >= 0.3 and (best is None or score > best[0]):
                        best = score, shared
                if best:
                    suggestions.append({
                        **candidates_by_key[source_key],
                        "token_overlap_score": round(best[0], 3),
                        "shared_tokens": best[1],
                    })
            suggestions.sort(key=lambda item: (-item["token_overlap_score"], item["source_key"]))
            suggestions = suggestions[:5]
        if len(matches) == 0:
            review_status = "no_exact_name_candidate"
        elif len(matches) == 1:
            review_status = "single_exact_name_candidate_requires_identity_review"
        else:
            review_status = "ambiguous_exact_name_candidates"
        output.append({
            "reference_id": landmark.get("reference_id", landmark.get("place_id")),
            "name": landmark.get("name"),
            "review_status": review_status,
            "approved": False,
            "itinerary_ready": False,
            "matches": matches,
            "suggestions": suggestions,
        })

    matched_count = sum(bool(item["matches"]) for item in output)
    ambiguous_count = sum(len(item["matches"]) > 1 for item in output)
    return {
        "status": "draft_not_routable",
        "match_method": "normalized_exact_name_only",
        "identity_verified": False,
        "candidate_count": len(output),
        "exact_name_candidate_count": matched_count,
        "ambiguous_candidate_count": ambiguous_count,
        "landmarks": output,
    }


def _read_records(path: Path) -> Iterable[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, 1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(f"invalid JSONL at line {line_number}") from error
            if isinstance(record, dict):
                yield record


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--landmarks", required=True, type=Path)
    parser.add_argument("--records", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        document = json.loads(args.landmarks.read_text(encoding="utf-8"))
        report = audit_landmarks(document, _read_records(args.records))
    except (OSError, ValueError, TypeError) as error:
        print(json.dumps({"status": "failed", "error": str(error)[:300]}), file=sys.stderr)
        return 2
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
