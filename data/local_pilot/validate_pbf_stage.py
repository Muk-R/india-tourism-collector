"""Validate a completed local OSM staging export without modifying it."""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

from pbf_extract import ATTRIBUTION, CORE_RADIUS_KM, LICENSE, OSM_COPYRIGHT, haversine_km

QID_RE = re.compile(r"^Q[1-9][0-9]*$")
SOURCE_TYPES = {"node", "way", "relation"}
CATEGORIES = {"attraction", "accommodation", "food", "transport"}
DISTANCE_TOLERANCE_KM = 0.0001


def validate_record(record: dict[str, Any], center: tuple[float, float], radius_km: int) -> list[str]:
    errors: list[str] = []
    source_type = record.get("source_type")
    source_id = record.get("source_id")
    if source_type not in SOURCE_TYPES or isinstance(source_id, bool) or not isinstance(source_id, int) or source_id <= 0:
        errors.append("invalid_source_identity")
    elif record.get("source_key") != f"{source_type}/{source_id}":
        errors.append("source_key_mismatch")

    latitude, longitude = record.get("latitude"), record.get("longitude")
    if (
        isinstance(latitude, bool)
        or isinstance(longitude, bool)
        or not isinstance(latitude, (int, float))
        or not isinstance(longitude, (int, float))
        or not math.isfinite(latitude)
        or not math.isfinite(longitude)
        or not -90 <= latitude <= 90
        or not -180 <= longitude <= 180
    ):
        errors.append("invalid_coordinates")
    else:
        exact_distance = haversine_km(center[0], center[1], latitude, longitude)
        stored_distance = record.get("distance_km")
        if isinstance(stored_distance, bool) or not isinstance(stored_distance, (int, float)) or not math.isfinite(stored_distance):
            errors.append("invalid_stored_distance")
        else:
            if abs(exact_distance - stored_distance) > DISTANCE_TOLERANCE_KM:
                errors.append("stored_distance_mismatch")
            if exact_distance > radius_km + DISTANCE_TOLERANCE_KM:
                errors.append("outside_requested_radius")
            expected_area = "core_hyderabad" if exact_distance <= CORE_RADIUS_KM else "nearby_escape_candidate"
            if record.get("area_class") != expected_area:
                errors.append("incorrect_core_or_extended_class")

    categories = record.get("categories")
    if not isinstance(categories, list) or not categories or not set(categories) <= CATEGORIES:
        errors.append("invalid_categories")
        categories = []
    if record.get("area_class") == "nearby_escape_candidate" and "attraction" not in categories:
        errors.append("non_attraction_in_extended_area")

    qid = record.get("wikidata_qid")
    if qid is not None and (not isinstance(qid, str) or not QID_RE.fullmatch(qid)):
        errors.append("invalid_wikidata_qid")
    score = record.get("importance_evidence_score")
    if isinstance(score, bool) or not isinstance(score, int) or not 0 <= score <= 10:
        errors.append("invalid_importance_score")
    if record.get("attribution") != ATTRIBUTION or record.get("license") != LICENSE:
        errors.append("missing_or_incorrect_attribution")
    if record.get("source_url") != f"https://www.openstreetmap.org/{source_type}/{source_id}":
        errors.append("source_url_mismatch")
    if not record.get("source_snapshot"):
        errors.append("missing_source_snapshot")
    if record.get("data_status") != "needs_review" or record.get("itinerary_ready") not in (0, False):
        errors.append("candidate_inappropriately_promoted")
    return errors


def validate_stage(summary_path: Path, records_path: Path) -> dict[str, Any]:
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    errors: Counter[str] = Counter()
    if summary.get("status") != "complete":
        errors["extraction_not_complete"] += 1
    if summary.get("benchmark_only") or summary.get("records_are_benchmark_only"):
        errors["benchmark_artifact_not_pilot_data"] += 1
    if summary.get("records_are_routable"):
        errors["summary_marks_records_routable"] += 1
    radius = summary.get("radius_km")
    center_data = summary.get("center", {})
    if isinstance(radius, bool) or not isinstance(radius, int) or not 10 <= radius <= 150:
        errors["invalid_summary_radius"] += 1
        radius = 0
    try:
        center = (float(center_data["latitude"]), float(center_data["longitude"]))
    except (KeyError, TypeError, ValueError):
        center = (math.nan, math.nan)
        errors["invalid_summary_center"] += 1
    if summary.get("license") != LICENSE or summary.get("attribution") != ATTRIBUTION or summary.get("copyright_url") != OSM_COPYRIGHT:
        errors["summary_attribution_mismatch"] += 1
    if not summary.get("input_sha256") or not summary.get("snapshot_timestamp"):
        errors["missing_source_snapshot_metadata"] += 1

    counts: Counter[str] = Counter()
    category_counts: Counter[str] = Counter()
    area_counts: Counter[str] = Counter()
    sources: Counter[str] = Counter()
    seen: set[str] = set()
    max_error_examples: list[dict[str, Any]] = []
    with records_path.open("r", encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, 1):
            if not line.strip():
                continue
            counts["records"] += 1
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                errors["invalid_jsonl_record"] += 1
                continue
            if not isinstance(record, dict):
                errors["record_not_object"] += 1
                continue
            source_key = record.get("source_key")
            if isinstance(source_key, str):
                if source_key in seen:
                    errors["duplicate_source_key"] += 1
                seen.add(source_key)
            for code in validate_record(record, center, radius):
                errors[code] += 1
                if len(max_error_examples) < 100:
                    max_error_examples.append({"line": line_number, "source_key": source_key, "code": code})
            if record.get("source_type") in SOURCE_TYPES:
                sources[record["source_type"]] += 1
            if record.get("area_class") in {"core_hyderabad", "nearby_escape_candidate"}:
                area_counts[record["area_class"]] += 1
            if isinstance(record.get("categories"), list):
                category_counts.update(set(record["categories"]) & CATEGORIES)
    expected = summary.get("accepted_unique_records")
    if expected != counts["records"]:
        errors["summary_record_count_mismatch"] += 1
    return {
        "status": "passed" if not errors else "failed",
        "city": summary.get("city"),
        "radius_km": radius,
        "input_sha256": summary.get("input_sha256"),
        "snapshot_timestamp": summary.get("snapshot_timestamp"),
        "record_count": counts["records"],
        "source_type_counts": dict(sorted(sources.items())),
        "category_record_counts": dict(sorted(category_counts.items())),
        "area_class_counts": dict(sorted(area_counts.items())),
        "possible_duplicate_groups_not_merged": summary.get("potential_duplicate_groups_not_merged", 0),
        "validation_error_counts": dict(sorted(errors.items())),
        "validation_error_examples": max_error_examples,
        "records_are_routable": False,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--summary", required=True, type=Path)
    parser.add_argument("--records", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        report = validate_stage(args.summary, args.records)
    except (OSError, ValueError, TypeError) as error:
        print(json.dumps({"status": "failed", "error": str(error)[:300]}), file=sys.stderr)
        return 2
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0 if report["status"] == "passed" else 2


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
