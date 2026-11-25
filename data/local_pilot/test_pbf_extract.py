import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from pbf_extract import PbfExtractor, _current_working_set_bytes, _importance, _peak_memory_bytes, classify_tags, haversine_km, polygon_representative, validate_radius
from landmark_osm_audit import audit_landmarks
from validate_pbf_stage import validate_record


HYDERABAD = (17.3850, 78.4867)


def write_synthetic_osm(path: Path) -> None:
    path.write_text(
        '''<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="localise-test">
  <node id="1" lat="17.3850" lon="78.4867"><tag k="amenity" v="restaurant"/><tag k="name" v="Cafe One"/><tag k="name:te" v="కేఫ్ వన్"/><tag k="cuisine" v="indian"/><tag k="diet:vegetarian" v="yes"/></node>
  <node id="2" lat="17.3860" lon="78.4867"/>
  <node id="3" lat="17.3860" lon="78.4870"/>
  <node id="4" lat="17.3863" lon="78.4870"/>
  <way id="10"><nd ref="2"/><nd ref="3"/><nd ref="4"/><nd ref="2"/><tag k="tourism" v="attraction"/><tag k="name" v="Small Fort"/><tag k="area" v="yes"/><tag k="historic" v="fort"/></way>
  <relation id="20"><member type="way" ref="10" role="outer"/><tag k="type" v="multipolygon"/><tag k="historic" v="fort"/><tag k="name" v="Fort Relation"/><tag k="wikidata" v="Q123"/></relation>
</osm>''',
        encoding="utf-8",
    )


class NormalizationTests(unittest.TestCase):
    def test_radius_requires_integer_between_ten_and_150(self):
        for value in (9, 151, 40.5, True):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_radius(value)
        self.assertEqual(validate_radius(40), 40)
        self.assertEqual(validate_radius(150), 150)


class LandmarkAuditTests(unittest.TestCase):
    def test_exact_name_candidates_are_reported_without_promoting_drafts(self):
        landmarks = {
            "status": "draft_not_routable",
            "landmarks": [
                {"reference_id": "hyd-1", "name": "Charminar", "approved": False, "latitude": None, "longitude": None},
                {"reference_id": "hyd-2", "name": "Golconda Fort", "approved": False, "latitude": None, "longitude": None},
            ],
        }
        records = [
            {"source_key": "node/1", "name": "Charminar", "name_variants": {"name:ur": "Charminar Urdu"}, "latitude": 17.36, "longitude": 78.47, "source_url": "https://www.openstreetmap.org/node/1", "source_snapshot": "2026-11-23T21:21:17Z", "attribution": "© OpenStreetMap contributors", "license": "ODbL-1.0"},
            {"source_key": "way/2", "name": "Charminar", "name_variants": {}, "latitude": 17.36, "longitude": 78.47, "source_url": "https://www.openstreetmap.org/way/2"},
            {"source_key": "node/3", "name": "Golconda", "name_variants": {}, "latitude": 17.38, "longitude": 78.40, "source_url": "https://www.openstreetmap.org/node/3"},
        ]

        report = audit_landmarks(landmarks, records)

        self.assertEqual(report["status"], "draft_not_routable")
        self.assertEqual(report["candidate_count"], 2)
        self.assertEqual(report["exact_name_candidate_count"], 1)
        self.assertEqual(report["ambiguous_candidate_count"], 1)
        charminar = report["landmarks"][0]
        self.assertEqual(charminar["review_status"], "ambiguous_exact_name_candidates")
        self.assertEqual([item["source_key"] for item in charminar["matches"]], ["node/1", "way/2"])
        self.assertEqual(charminar["matches"][0]["license"], "ODbL-1.0")
        self.assertEqual(charminar["matches"][0]["attribution"], "© OpenStreetMap contributors")
        self.assertEqual(charminar["matches"][0]["source_snapshot"], "2026-11-23T21:21:17Z")
        self.assertEqual(report["landmarks"][1]["review_status"], "no_exact_name_candidate")
        self.assertTrue(all(item["approved"] is False for item in report["landmarks"]))

    def test_unmatched_name_gets_only_a_nonbinding_token_overlap_suggestion(self):
        report = audit_landmarks(
            {"status": "draft_not_routable", "landmarks": [{"reference_id": "hyd-3", "name": "Qutb Shahi Tombs"}]},
            [{"source_key": "relation/4", "name": "Qutub Shahi Tombs", "categories": ["attraction"], "latitude": 17.4, "longitude": 78.4, "source_url": "https://www.openstreetmap.org/relation/4"}],
        )

        landmark = report["landmarks"][0]
        self.assertEqual(landmark["review_status"], "no_exact_name_candidate")
        self.assertEqual(landmark["matches"], [])
        self.assertEqual(landmark["suggestions"][0]["source_key"], "relation/4")
        self.assertEqual(landmark["suggestions"][0]["shared_tokens"], ["shahi", "tombs"])
        self.assertFalse(report["identity_verified"])

    def test_historic_yes_is_not_a_subcategory_or_attraction(self):
        self.assertIsNone(classify_tags({"historic": "yes"}))
        self.assertEqual(classify_tags({"historic": "fort"})["subcategory"], "fort")

    def test_coordinates_use_exact_haversine_radius(self):
        self.assertEqual(haversine_km(*HYDERABAD, *HYDERABAD), 0)
        self.assertGreater(haversine_km(*HYDERABAD, 18.0, 78.4867), 40)

    def test_concave_polygon_representative_is_inside(self):
        outer = [(0, 0), (0, 4), (1, 4), (1, 1), (4, 1), (4, 0), (0, 0)]
        point = polygon_representative(outer, [])
        self.assertIsNotNone(point)
        self.assertTrue(0 <= point[0] <= 4 and 0 <= point[1] <= 4)

    def test_invalid_wikidata_value_does_not_inflate_importance(self):
        classification = {"categories": ["attraction"]}
        score, signals = _importance({"wikidata": "Q-not-an-id"}, classification)
        self.assertEqual(score, 0)
        self.assertNotIn("wikidata_link", signals)

    @unittest.skipUnless(os.name == "nt", "Windows process counters are platform-specific")
    def test_windows_process_memory_metrics_are_available(self):
        current = _current_working_set_bytes()
        peak = _peak_memory_bytes()
        self.assertIsNotNone(current)
        self.assertIsNotNone(peak)
        self.assertGreater(current, 0)
        self.assertGreaterEqual(peak, current)

    def test_stage_validator_accepts_review_only_extended_attraction(self):
        record = {
            "source_type": "node",
            "source_id": 123,
            "source_key": "node/123",
            "latitude": 17.835,
            "longitude": 78.4867,
            "distance_km": round(haversine_km(*HYDERABAD, 17.835, 78.4867), 4),
            "area_class": "nearby_escape_candidate",
            "categories": ["attraction"],
            "wikidata_qid": "Q123",
            "importance_evidence_score": 5,
            "attribution": "© OpenStreetMap contributors",
            "license": "ODbL-1.0",
            "source_url": "https://www.openstreetmap.org/node/123",
            "source_snapshot": "2026-11-23T21:21:17Z",
            "data_status": "needs_review",
            "itinerary_ready": 0,
        }
        self.assertEqual(validate_record(record, HYDERABAD, 150), [])

    def test_stage_validator_rejects_out_of_radius_and_promoted_candidates(self):
        record = {
            "source_type": "node",
            "source_id": 124,
            "source_key": "node/124",
            "latitude": 19.0,
            "longitude": 78.4867,
            "distance_km": 179.6,
            "area_class": "nearby_escape_candidate",
            "categories": ["attraction"],
            "wikidata_qid": None,
            "importance_evidence_score": 2,
            "attribution": "© OpenStreetMap contributors",
            "license": "ODbL-1.0",
            "source_url": "https://www.openstreetmap.org/node/124",
            "source_snapshot": "2026-11-23T21:21:17Z",
            "data_status": "verified",
            "itinerary_ready": 1,
        }
        errors = validate_record(record, HYDERABAD, 150)
        self.assertIn("outside_requested_radius", errors)
        self.assertIn("candidate_inappropriately_promoted", errors)


class StreamingExtractionTests(unittest.TestCase):
    def test_synthetic_streaming_extraction_keeps_provenance_and_deduplicates_area(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "synthetic.osm"
            output = root / "benchmark.sqlite3"
            write_synthetic_osm(source)
            script = Path(__file__).with_name("pbf_extract.py")
            process = subprocess.run(
                [sys.executable, "-B", str(script), "--input", str(source), "--output-db", str(output), "--radius-km", "40", "--benchmark", "--allow-xml-fixture"],
                capture_output=True,
                text=True,
                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
                check=False,
            )
            self.assertEqual(process.returncode, 0, process.stderr)
            result = json.loads(process.stdout.splitlines()[-1])

            self.assertEqual(result["status"], "complete")
            self.assertTrue(result["benchmark_only"])
            self.assertFalse(result["records_are_routable"])
            self.assertEqual(result["accepted_unique_records"], 3)
            rows = [json.loads(line) for line in output.with_suffix(".places.jsonl").read_text(encoding="utf-8").splitlines()]
            by_key = {row["source_key"]: row for row in rows}
            self.assertEqual(set(by_key), {"node/1", "way/10", "relation/20"})
            self.assertEqual(by_key["node/1"]["attribution"], "© OpenStreetMap contributors")
            self.assertEqual(by_key["node/1"]["license"], "ODbL-1.0")
            self.assertEqual(by_key["node/1"]["name_variants"]["name:te"], "కేఫ్ వన్")
            self.assertEqual(by_key["node/1"]["dietary_claims"]["diet:vegetarian"], "yes")
            self.assertEqual(by_key["way/10"]["data_status"], "needs_review")
            self.assertFalse(by_key["way/10"]["itinerary_ready"])

    def test_interrupted_sqlite_stage_resumes_idempotently(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, output = root / "synthetic.osm", root / "resumable.sqlite3"
            write_synthetic_osm(source)
            extractor = PbfExtractor(source, output, *HYDERABAD, 40, False, True, allow_xml_fixture=True, index_type="sparse_mem_array")
            original = extractor._write_candidate
            failed = False

            def fail_after_first_write(obj, kind, rank):
                nonlocal failed
                original(obj, kind, rank)
                if not failed:
                    failed = True
                    raise RuntimeError("synthetic interruption")

            with patch.object(extractor, "_write_candidate", side_effect=fail_after_first_write):
                with self.assertRaisesRegex(RuntimeError, "synthetic interruption"):
                    extractor.run()
            resumed = PbfExtractor(source, output, *HYDERABAD, 40, True, True, allow_xml_fixture=True, index_type="sparse_mem_array").run()
            rows = output.with_suffix(".places.jsonl").read_text(encoding="utf-8").splitlines()
            self.assertEqual(resumed["accepted_unique_records"], 3)
            self.assertEqual(len(rows), 3)

    def test_resume_rejects_changed_scope(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, output = root / "synthetic.osm", root / "scope.sqlite3"
            write_synthetic_osm(source)
            PbfExtractor(source, output, *HYDERABAD, 40, False, True, allow_xml_fixture=True, index_type="sparse_mem_array").run()
            with self.assertRaisesRegex(ValueError, "fingerprint"):
                PbfExtractor(source, output, *HYDERABAD, 41, True, True, allow_xml_fixture=True, index_type="sparse_mem_array").run()


if __name__ == "__main__":
    unittest.main()
