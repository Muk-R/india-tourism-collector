"""Streaming, resumable OSM PBF extraction into local SQLite/JSONL staging."""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
import math
import os
import re
import shutil
import sqlite3
import sys
import threading
import time
import unicodedata
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    import osmium
except ImportError as error:  # pragma: no cover - exercised by CLI smoke check
    raise SystemExit("Install the isolated extraction requirements before running this tool") from error


ATTRIBUTION = "© OpenStreetMap contributors"
LICENSE = "ODbL-1.0"
OSM_COPYRIGHT = "https://www.openstreetmap.org/copyright"
EARTH_RADIUS_KM = 6371.0088
DEFAULT_CENTER = (17.3850, 78.4867)
CORE_RADIUS_KM = 40
DISK_WARN_BYTES = 30 * 1024**3
DISK_PAUSE_BYTES = 20 * 1024**3
DISK_CHECK_SECONDS = 15 * 60
CHECKPOINT_OBJECTS = 10_000
MEMORY_PAUSE_BYTES = 1900 * 1024**2

ATTRACTION_TAGS = {
    "tourism": {"attraction", "museum", "gallery", "viewpoint", "artwork", "theme_park", "zoo", "aquarium", "picnic_site", "heritage"},
    "historic": {"castle", "fort", "fortification", "ruins", "monument", "memorial", "archaeological_site", "city_gate", "battlefield", "temple", "church", "mosque", "palace", "manor", "wayside_shrine", "heritage"},
    "natural": {"peak", "waterfall", "spring", "cave_entrance", "hot_spring", "cliff", "volcano", "glacier", "beach", "geyser"},
    "waterway": {"waterfall"},
    "leisure": {"park", "garden", "nature_reserve", "water_park", "marina"},
}
LODGING_VALUES = {"hotel", "hostel", "guest_house", "motel", "apartment", "chalet", "alpine_hut", "wilderness_hut", "camp_site", "caravan_site", "camp_pitch", "resort"}
FOOD_VALUES = {"restaurant", "cafe", "food_court", "fast_food", "pub", "bar", "ice_cream", "biergarten"}
TRANSPORT_TAGS = {
    "amenity": {"bus_station", "ferry_terminal", "taxi", "bicycle_rental", "car_rental"},
    "public_transport": {"station", "stop_position", "platform"},
    "railway": {"station", "halt", "tram_stop"},
    "aeroway": {"aerodrome", "terminal"},
}
GENERIC_VALUES = {"", "yes", "no", "true", "false", "1", "0"}
QID_RE = re.compile(r"^Q[1-9][0-9]*$")


class StorageSafetyStop(RuntimeError):
    pass


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi, d_lam = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lam / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(min(1.0, a)))


def validate_radius(radius_km: int) -> int:
    if isinstance(radius_km, bool) or not isinstance(radius_km, int) or not 10 <= radius_km <= 150:
        raise ValueError("collection radius must be an integer from 10 through 150 km")
    return radius_km


def classify_tags(tags: dict[str, str]) -> dict[str, Any] | None:
    categories: list[str] = []
    matched: list[tuple[str, str]] = []
    for key, allowed in ATTRACTION_TAGS.items():
        value = tags.get(key, "").strip().lower()
        if value in allowed:
            if "attraction" not in categories:
                categories.append("attraction")
            matched.append((key, value))
    tourism = tags.get("tourism", "").strip().lower()
    if tourism in LODGING_VALUES:
        categories.append("accommodation")
        matched.append(("tourism", tourism))
    amenity = tags.get("amenity", "").strip().lower()
    if amenity in FOOD_VALUES:
        categories.append("food")
        matched.append(("amenity", amenity))
    for key, allowed in TRANSPORT_TAGS.items():
        value = tags.get(key, "").strip().lower()
        if value in allowed:
            categories.append("transport")
            matched.append((key, value))
    if not categories:
        return None
    # Use only a semantic tag value; generic historic=yes is never a category.
    subcategory = next((value for _, value in matched if value not in GENERIC_VALUES), None)
    return {"categories": sorted(set(categories)), "subcategory": subcategory, "matched_tags": matched}


def _valid_point(lat: Any, lon: Any) -> tuple[float, float] | None:
    try:
        lat_value, lon_value = float(lat), float(lon)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(lat_value) or not math.isfinite(lon_value):
        return None
    if not -90 <= lat_value <= 90 or not -180 <= lon_value <= 180:
        return None
    return lat_value, lon_value


def _node_points(nodes: Any) -> list[tuple[float, float]]:
    points = []
    for node in nodes:
        try:
            location = node.location
            if location.valid():
                point = _valid_point(location.lat, location.lon)
                if point:
                    points.append(point)
        except (AttributeError, RuntimeError, ValueError):
            continue
    return points


def line_representative(points: list[tuple[float, float]]) -> tuple[float, float] | None:
    if not points:
        return None
    # Average actual OSM vertices, not the bounding-box center. Marked approximate.
    return (sum(point[0] for point in points) / len(points), sum(point[1] for point in points) / len(points))


def point_in_ring(point: tuple[float, float], ring: list[tuple[float, float]]) -> bool:
    lat, lon = point
    inside = False
    if len(ring) < 3:
        return False
    previous_lat, previous_lon = ring[-1]
    for current_lat, current_lon in ring:
        crosses = (current_lat > lat) != (previous_lat > lat)
        if crosses:
            intersection_lon = (previous_lon - current_lon) * (lat - current_lat) / (previous_lat - current_lat) + current_lon
            if lon < intersection_lon:
                inside = not inside
        previous_lat, previous_lon = current_lat, current_lon
    return inside


def _ring_centroid(ring: list[tuple[float, float]]) -> tuple[float, float] | None:
    if len(ring) < 4:
        return None
    area_twice = 0.0
    lat_sum = 0.0
    lon_sum = 0.0
    for (lat1, lon1), (lat2, lon2) in zip(ring, ring[1:]):
        cross = lon1 * lat2 - lon2 * lat1
        area_twice += cross
        lon_sum += (lon1 + lon2) * cross
        lat_sum += (lat1 + lat2) * cross
    if abs(area_twice) < 1e-15:
        return None
    return lat_sum / (3 * area_twice), lon_sum / (3 * area_twice)


def polygon_representative(outer: list[tuple[float, float]], holes: list[list[tuple[float, float]]]) -> tuple[float, float] | None:
    centroid = _ring_centroid(outer)
    if centroid and point_in_ring(centroid, outer) and not any(point_in_ring(centroid, hole) for hole in holes):
        return centroid
    # Scan horizontal slices; choose the midpoint of the widest valid interior span.
    lats = [lat for lat, _ in outer]
    low, high = min(lats), max(lats)
    if low == high:
        return None
    scan_lats = [low + (high - low) * fraction / 20 for fraction in range(1, 20)]
    scan_lats.extend((a + b) / 2 for a, b in zip(sorted(set(lats)), sorted(set(lats))[1:]) if a < b)
    best: tuple[float, tuple[float, float]] | None = None
    for lat in scan_lats:
        crossings = []
        for ring in [outer, *holes]:
            xs = []
            for (lat1, lon1), (lat2, lon2) in zip(ring, ring[1:]):
                if (lat1 > lat) != (lat2 > lat):
                    xs.append(lon1 + (lat - lat1) * (lon2 - lon1) / (lat2 - lat1))
            crossings.extend((x, ring is outer) for x in xs)
        outer_x = sorted(x for x, is_outer in crossings if is_outer)
        hole_x = sorted(x for x, is_outer in crossings if not is_outer)
        for left, right in zip(outer_x[::2], outer_x[1::2]):
            candidates = [left + 1e-10, *[x for x in hole_x if left < x < right], right - 1e-10]
            candidates.sort()
            for x1, x2 in zip(candidates, candidates[1:]):
                point = (lat, (x1 + x2) / 2)
                if x2 > x1 and point_in_ring(point, outer) and not any(point_in_ring(point, hole) for hole in holes):
                    width = x2 - x1
                    if best is None or width > best[0]:
                        best = (width, point)
    return best[1] if best else None


def _area_point(area: Any) -> tuple[float, float] | None:
    best: tuple[float, tuple[float, float]] | None = None
    for outer_ring in area.outer_rings():
        outer = _node_points(outer_ring)
        holes = [_node_points(ring) for ring in area.inner_rings(outer_ring)]
        point = polygon_representative(outer, holes)
        if point:
            score = abs((max(lat for lat, _ in outer) - min(lat for lat, _ in outer)) * (max(lon for _, lon in outer) - min(lon for _, lon in outer)))
            if best is None or score > best[0]:
                best = score, point
    return best[1] if best else None


def _tags(obj: Any) -> dict[str, str]:
    return {str(tag.k): str(tag.v) for tag in obj.tags}


def _identity(obj: Any) -> tuple[str, int]:
    if obj.is_area():
        source_type = "way" if obj.from_way() else "relation"
        source_id = int(obj.orig_id())
    elif obj.is_node():
        source_type, source_id = "node", int(obj.id)
    elif obj.is_way():
        source_type, source_id = "way", int(obj.id)
    else:
        source_type, source_id = "relation", int(obj.id)
    return source_type, source_id


def _point(obj: Any) -> tuple[tuple[float, float] | None, str]:
    if obj.is_node():
        try:
            return _valid_point(obj.location.lat, obj.location.lon), "osm_node_coordinate"
        except (AttributeError, RuntimeError, ValueError):
            return None, "invalid_node_coordinate"
    if obj.is_area():
        return _area_point(obj), "polygon_interior_point"
    if obj.is_way():
        return line_representative(_node_points(obj.nodes)), "mean_osm_way_vertices"
    return None, "relation_geometry_unavailable"


def _names(tags: dict[str, str]) -> dict[str, str]:
    keys = {"name", "official_name", "short_name", "alt_name"}
    keys.update(key for key in tags if key.startswith("name:") or key.startswith("alt_name:"))
    return {key: tags[key] for key in sorted(keys) if tags.get(key)}


def _name_for_display(names: dict[str, str]) -> str | None:
    return names.get("name") or names.get("name:en") or names.get("official_name") or next(iter(names.values()), None)


def _normalize_name(name: str | None) -> str | None:
    if not name:
        return None
    return " ".join(unicodedata.normalize("NFKC", name).casefold().split()) or None


def _importance(tags: dict[str, str], classification: dict[str, Any]) -> tuple[int, list[str]]:
    signals: list[str] = []
    score = 0
    if QID_RE.fullmatch(tags.get("wikidata", "")):
        signals.append("wikidata_link")
        score += 2
    if tags.get("wikipedia"):
        signals.append("wikipedia_link_only")
        score += 1
    if tags.get("heritage") not in (None, "", "no", "0") or tags.get("heritage:operator"):
        signals.append("heritage_tag")
        score += 3
    if tags.get("historic") in {"castle", "fort", "fortification", "monument", "memorial", "archaeological_site", "palace"}:
        signals.append("historic_category")
        score += 2
    if tags.get("tourism") == "attraction":
        signals.append("tourism_attraction_tag")
        score += 2
    if tags.get("natural") in {"peak", "waterfall"} or tags.get("waterway") == "waterfall":
        signals.append("named_natural_feature_tag")
        score += 1
    return min(score, 10), signals


def _extended_evidence(tags: dict[str, str], names: dict[str, str], score: int, categories: list[str]) -> bool:
    if "attraction" not in categories or not names:
        return False
    if QID_RE.fullmatch(tags.get("wikidata", "")) or tags.get("wikipedia") or tags.get("heritage") not in (None, "", "no", "0"):
        return True
    return tags.get("tourism") == "attraction" or tags.get("natural") in {"peak", "waterfall"} or tags.get("waterway") == "waterfall"


def _header_metadata(header: Any) -> dict[str, Any]:
    keys = ("generator", "osmosis_replication_timestamp", "osmosis_replication_sequence_number", "osmosis_replication_base_url")
    return {key: header.get(key) for key in keys if header.get(key) is not None}


def sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _process_memory_counters() -> Any | None:
    if os.name != "nt":
        return None
    import ctypes
    from ctypes import wintypes

    class Counters(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD), ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t), ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t), ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]

    counters = Counters()
    counters.cb = ctypes.sizeof(counters)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetCurrentProcess.argtypes = []
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
    psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
    if psapi.GetProcessMemoryInfo(kernel32.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
        return counters
    return None


def _peak_memory_bytes() -> int | None:
    counters = _process_memory_counters()
    return int(counters.PeakWorkingSetSize) if counters is not None else None


def _current_working_set_bytes() -> int | None:
    counters = _process_memory_counters()
    return int(counters.WorkingSetSize) if counters is not None else None


class ResourceGuard:
    """Poll disk and working-set use while native Pyosmium code is reading."""

    def __init__(self, drive_root: str):
        self.drive_root = drive_root
        self.stop_event = threading.Event()
        self.pause_reason: str | None = None
        self.warned_low_disk = False
        self.thread = threading.Thread(target=self._watch, name="pbf-resource-guard", daemon=True)

    def _watch(self) -> None:
        while not self.stop_event.wait(5):
            free = shutil.disk_usage(self.drive_root).free
            if free < DISK_PAUSE_BYTES:
                self.pause_reason = f"C: free space {free} bytes is below the 20 GB pause threshold"
                return
            if free < DISK_WARN_BYTES and not self.warned_low_disk:
                print(json.dumps({"event": "disk_warning", "free_bytes": free}), flush=True)
                self.warned_low_disk = True
            memory = _current_working_set_bytes()
            if memory is not None and memory >= MEMORY_PAUSE_BYTES:
                self.pause_reason = f"process working set {memory} bytes reached the 1.9 GiB pause guard"
                return

    def start(self) -> None:
        self.thread.start()

    def check(self) -> None:
        if self.pause_reason:
            raise StorageSafetyStop(self.pause_reason)

    def close(self) -> None:
        self.stop_event.set()
        if self.thread.is_alive():
            self.thread.join(timeout=1)


class PbfExtractor:
    def __init__(self, input_path: Path, output_db: Path, latitude: float, longitude: float, radius_km: int, resume: bool, benchmark: bool, checkpoint_objects: int = CHECKPOINT_OBJECTS, allow_xml_fixture: bool = False, index_type: str = "sparse_file_array"):
        self.input_path = input_path.resolve()
        self.output_db = output_db.resolve()
        self.latitude = latitude
        self.longitude = longitude
        self.radius_km = validate_radius(radius_km)
        self.resume = resume
        self.benchmark = benchmark
        self.checkpoint_objects = max(100, checkpoint_objects)
        self.allow_xml_fixture = allow_xml_fixture
        self.index_type = index_type
        self.run_fingerprint: dict[str, Any] = {}
        self.connection: sqlite3.Connection | None = None
        self.processed = Counter()
        self.rejected = Counter()
        self.started = 0.0
        self.last_disk_check = 0.0
        self.warned_low_disk = False
        self.pending_commit = 0

    def _prepare(self) -> tuple[Any, dict[str, Any]]:
        if not self.input_path.is_file():
            raise FileNotFoundError(self.input_path)
        if not self.input_path.name.lower().endswith(".osm.pbf") and not (self.allow_xml_fixture and self.input_path.suffix.lower() == ".osm"):
            raise ValueError("production input must be an OSM PBF")
        if not self.output_db.parent.exists():
            self.output_db.parent.mkdir(parents=True)
        if self.input_path.resolve() == self.output_db.resolve():
            raise ValueError("output must not overwrite the source PBF")
        pbf_hash = sha256_file(self.input_path)
        stat = self.input_path.stat()
        processor = osmium.FileProcessor(str(self.input_path))
        header = _header_metadata(processor.header)
        metadata = {
            "input_path": str(self.input_path),
            "input_size_bytes": stat.st_size,
            "input_mtime_utc": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
            "input_sha256": pbf_hash,
            "input_header": header,
            "filename_snapshot_hint": self.input_path.stem,
            "snapshot_timestamp": header.get("osmosis_replication_timestamp"),
            "city": "Hyderabad",
            "center": {"latitude": self.latitude, "longitude": self.longitude},
            "radius_km": self.radius_km,
            "core_radius_km": CORE_RADIUS_KM,
            "benchmark_only": self.benchmark,
            "attribution": ATTRIBUTION,
            "license": LICENSE,
            "copyright_url": OSM_COPYRIGHT,
        }
        self.run_fingerprint = metadata
        if self.output_db.exists() and not self.resume:
            raise FileExistsError(f"output exists; pass --resume only for the same input and scope: {self.output_db}")
        self.connection = sqlite3.connect(self.output_db)
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA synchronous=FULL")
        self.connection.execute("PRAGMA temp_store=FILE")
        self.connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS run_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS places (
                source_type TEXT NOT NULL, source_id INTEGER NOT NULL, source_key TEXT NOT NULL UNIQUE,
                name TEXT, normalized_name TEXT, name_variants_json TEXT NOT NULL,
                categories_json TEXT NOT NULL, subcategory TEXT, latitude REAL NOT NULL, longitude REAL NOT NULL,
                distance_km REAL NOT NULL, area_class TEXT NOT NULL, importance_evidence_score INTEGER NOT NULL,
                importance_signals_json TEXT NOT NULL, wikidata_qid TEXT, wikipedia_ref TEXT,
                accommodation_type TEXT, hotel_stars_evidence TEXT, cuisine TEXT, dietary_claims_json TEXT NOT NULL,
                raw_tags_json TEXT NOT NULL, geometry_method TEXT NOT NULL, geometry_rank INTEGER NOT NULL,
                source_url TEXT NOT NULL, attribution TEXT NOT NULL, license TEXT NOT NULL,
                source_snapshot TEXT, data_status TEXT NOT NULL DEFAULT 'needs_review', itinerary_ready INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(source_type, source_id)
            );
            CREATE TABLE IF NOT EXISTS sightings (
                source_type TEXT NOT NULL, source_id INTEGER NOT NULL, geometry_method TEXT NOT NULL,
                PRIMARY KEY(source_type, source_id, geometry_method)
            );
            CREATE TABLE IF NOT EXISTS potential_duplicate_groups (
                group_key TEXT NOT NULL, reason TEXT NOT NULL, member_count INTEGER NOT NULL,
                PRIMARY KEY(group_key, reason)
            );
            """
        )
        prior = self.connection.execute("SELECT value FROM run_meta WHERE key='fingerprint'").fetchone()
        fingerprint_json = json.dumps(metadata, sort_keys=True, separators=(",", ":"))
        if prior and prior[0] != fingerprint_json:
            self.connection.close()
            self.connection = None
            raise ValueError("resume fingerprint does not match PBF checksum and extraction scope")
        if not prior and self.resume:
            self.connection.close()
            self.connection = None
            raise ValueError("--resume requested but no matching checkpoint exists")
        if not prior:
            self.connection.execute("INSERT INTO run_meta(key,value) VALUES('fingerprint',?)", (fingerprint_json,))
        self.connection.execute("INSERT OR REPLACE INTO run_meta(key,value) VALUES('status','running')")
        self.connection.execute("INSERT OR REPLACE INTO run_meta(key,value) VALUES('started_utc',?)", (datetime.now(timezone.utc).isoformat(),))
        self.connection.commit()
        return processor, metadata

    def _storage_check(self, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self.last_disk_check < DISK_CHECK_SECONDS:
            return
        free = shutil.disk_usage(self.output_db.anchor or str(self.output_db.parent)).free
        self.last_disk_check = now
        if free < DISK_PAUSE_BYTES:
            raise StorageSafetyStop(f"C: free space {free} bytes is below the 20 GB pause threshold")
        if free < DISK_WARN_BYTES and not self.warned_low_disk:
            print(json.dumps({"event": "disk_warning", "free_bytes": free}), flush=True)
            self.warned_low_disk = True

    def _write_candidate(self, obj: Any, geometry_kind: str, geometry_rank: int) -> None:
        identity_type, identity_id = _identity(obj)
        source_key = f"{identity_type}/{identity_id}"
        tags = _tags(obj)
        classification = classify_tags(tags)
        if classification is None:
            return
        point, geometry_method = _point(obj)
        if point is None:
            self.rejected["missing_or_invalid_geometry"] += 1
            return
        distance = haversine_km(self.latitude, self.longitude, point[0], point[1])
        if distance > self.radius_km:
            if geometry_rank >= 4:
                self.connection.execute("DELETE FROM places WHERE source_type=? AND source_id=?", (identity_type, identity_id))
            self.rejected["outside_requested_radius"] += 1
            return
        names = _names(tags)
        score, signals = _importance(tags, classification)
        if distance > CORE_RADIUS_KM:
            if not _extended_evidence(tags, names, score, classification["categories"]):
                self.rejected["extended_attraction_lacks_significance_evidence"] += 1
                return
            area_class = "nearby_escape_candidate"
        else:
            area_class = "core_hyderabad"
        wikidata = tags.get("wikidata", "").strip()
        qid = wikidata if QID_RE.fullmatch(wikidata) else None
        row = {
            "source_type": identity_type,
            "source_id": identity_id,
            "source_key": source_key,
            "name": _name_for_display(names),
            "normalized_name": _normalize_name(_name_for_display(names)),
            "name_variants_json": json.dumps(names, ensure_ascii=False, sort_keys=True),
            "categories_json": json.dumps(classification["categories"], ensure_ascii=False),
            "subcategory": classification["subcategory"],
            "latitude": point[0],
            "longitude": point[1],
            "distance_km": round(distance, 4),
            "area_class": area_class,
            "importance_evidence_score": score,
            "importance_signals_json": json.dumps(signals),
            "wikidata_qid": qid,
            "wikipedia_ref": tags.get("wikipedia"),
            "accommodation_type": tags.get("tourism") if "accommodation" in classification["categories"] else None,
            "hotel_stars_evidence": tags.get("stars"),
            "cuisine": tags.get("cuisine"),
            "dietary_claims_json": json.dumps({key: value for key, value in tags.items() if key.startswith("diet:") or key.startswith("diet_")}, ensure_ascii=False, sort_keys=True),
            "raw_tags_json": json.dumps(tags, ensure_ascii=False, sort_keys=True),
            "geometry_method": geometry_method,
            "geometry_rank": geometry_rank,
            "source_url": f"https://www.openstreetmap.org/{identity_type}/{identity_id}",
            "attribution": ATTRIBUTION,
            "license": LICENSE,
            "source_snapshot": self.run_fingerprint.get("snapshot_timestamp"),
            "data_status": "needs_review",
            "itinerary_ready": 0,
        }
        columns = tuple(row)
        placeholders = ",".join("?" for _ in columns)
        updates = ",".join(f"{column}=excluded.{column}" for column in columns if column not in {"source_type", "source_id", "source_key"})
        self.connection.execute(
            f"INSERT INTO places({','.join(columns)}) VALUES({placeholders}) ON CONFLICT(source_type,source_id) DO UPDATE SET "
            f"{updates} WHERE excluded.geometry_rank > places.geometry_rank",
            tuple(row[column] for column in columns),
        )
        self.connection.execute("INSERT OR IGNORE INTO sightings VALUES(?,?,?)", (identity_type, identity_id, geometry_kind))

    def _checkpoint(self, obj_type: str | None = None, obj_id: int | None = None, check_storage: bool = True) -> None:
        if check_storage:
            self._storage_check()
        self.connection.execute("INSERT OR REPLACE INTO run_meta(key,value) VALUES('last_checkpoint_utc',?)", (datetime.now(timezone.utc).isoformat(),))
        self.connection.execute("INSERT OR REPLACE INTO run_meta(key,value) VALUES('last_source_object',?)", (json.dumps({"type": obj_type, "id": obj_id}),))
        self.connection.execute("INSERT OR REPLACE INTO run_meta(key,value) VALUES('processed_counts',?)", (json.dumps(self.processed, sort_keys=True),))
        self.connection.commit()
        self.pending_commit = 0
        if sum(self.processed.values()) and sum(self.processed.values()) % 50_000 < self.checkpoint_objects:
            print(json.dumps({"event": "progress", "processed": dict(self.processed), "accepted": self.connection.execute("SELECT COUNT(*) FROM places").fetchone()[0]}), flush=True)

    def run(self) -> dict[str, Any]:
        processor, metadata = self._prepare()
        self._storage_check(force=True)
        index_path = self.output_db.with_suffix(".nodes.store")
        self.started = time.monotonic()
        guard = ResourceGuard(self.output_db.anchor or str(self.output_db.parent))
        try:
            guard.start()
            location_store = f"{self.index_type},{index_path}" if self.index_type.endswith("file_array") else self.index_type
            processor.with_locations(location_store).with_areas()
            for obj in processor:
                guard.check()
                if obj.is_node():
                    kind, rank = "node", 3
                elif obj.is_area():
                    kind, rank = "area", 4
                elif obj.is_way():
                    kind, rank = "way", 2 if obj.is_closed() else 1
                elif obj.is_relation():
                    kind, rank = "relation", 0
                else:
                    continue
                self.processed[kind] += 1
                self._write_candidate(obj, kind, rank)
                self.pending_commit += 1
                if self.pending_commit >= self.checkpoint_objects:
                    self._checkpoint(kind, int(getattr(obj, "id", 0)))
            self._checkpoint()
            self._build_duplicate_flags()
            elapsed = time.monotonic() - self.started
            summary = self._summary(metadata, elapsed, "complete")
            self.connection.execute("INSERT OR REPLACE INTO run_meta(key,value) VALUES('status','complete')")
            self.connection.execute("INSERT OR REPLACE INTO run_meta(key,value) VALUES('summary',?)", (json.dumps(summary, sort_keys=True),))
            self.connection.commit()
            self._export_jsonl()
            self._write_summary(summary)
            return summary
        except KeyboardInterrupt:
            self._checkpoint(check_storage=False)
            self.connection.execute("INSERT OR REPLACE INTO run_meta(key,value) VALUES('status','interrupted')")
            self.connection.commit()
            raise
        except StorageSafetyStop as error:
            self._checkpoint(check_storage=False)
            status = "paused_resource" if "working set" in str(error) else "paused_storage"
            self.connection.execute("INSERT OR REPLACE INTO run_meta(key,value) VALUES('status',?)", (status,))
            self.connection.execute("INSERT OR REPLACE INTO run_meta(key,value) VALUES('stop_reason',?)", (str(error),))
            self.connection.commit()
            raise
        except Exception as error:
            self._checkpoint(check_storage=False)
            self.connection.execute("INSERT OR REPLACE INTO run_meta(key,value) VALUES('status','failed')")
            self.connection.execute("INSERT OR REPLACE INTO run_meta(key,value) VALUES('stop_reason',?)", (str(error)[:500],))
            self.connection.commit()
            raise
        finally:
            guard.close()
            try:
                processor.node_location_storage.clear()
            except (AttributeError, RuntimeError):
                pass
            if "obj" in locals():
                obj = None
            processor = None
            gc.collect()
            if self.connection is not None:
                self.connection.close()

    def _build_duplicate_flags(self) -> None:
        self.connection.execute("DELETE FROM potential_duplicate_groups")
        self.connection.execute(
            "INSERT OR IGNORE INTO potential_duplicate_groups "
            "SELECT 'qid:'||wikidata_qid,'shared_wikidata_identity',COUNT(*) FROM places "
            "WHERE wikidata_qid IS NOT NULL GROUP BY wikidata_qid HAVING COUNT(*) > 1"
        )
        self.connection.execute(
            "INSERT OR IGNORE INTO potential_duplicate_groups "
            "SELECT 'name:'||normalized_name||':'||ROUND(latitude,4)||':'||ROUND(longitude,4),"
            "'same_name_and_nearby_coordinate',COUNT(*) FROM places WHERE normalized_name IS NOT NULL "
            "GROUP BY normalized_name,ROUND(latitude,4),ROUND(longitude,4) HAVING COUNT(*) > 1"
        )
        self.connection.commit()

    def _summary(self, metadata: dict[str, Any], elapsed: float, status: str) -> dict[str, Any]:
        row_count = self.connection.execute("SELECT COUNT(*) FROM places").fetchone()[0]
        categories = Counter()
        for (value,) in self.connection.execute("SELECT categories_json FROM places"):
            for category in json.loads(value):
                categories[category] += 1
        area_classes = dict(self.connection.execute("SELECT area_class,COUNT(*) FROM places GROUP BY area_class"))
        sightings = self.connection.execute("SELECT COUNT(*)-COUNT(DISTINCT source_type||'/'||source_id) FROM sightings").fetchone()[0]
        duplicates = self.connection.execute("SELECT COUNT(*) FROM potential_duplicate_groups").fetchone()[0]
        free_bytes = shutil.disk_usage(self.output_db.anchor or str(self.output_db.parent)).free
        return {
            **metadata,
            "status": status,
            "benchmark_only": self.benchmark,
            "elapsed_seconds": round(elapsed, 2),
            "processed_objects": dict(self.processed),
            "accepted_unique_records": row_count,
            "category_record_counts": dict(categories),
            "area_class_counts": area_classes,
            "rejected_counts": dict(self.rejected),
            "deduplicated_geometry_observations": sightings,
            "potential_duplicate_groups_not_merged": duplicates,
            "output_sqlite_bytes": self.output_db.stat().st_size if self.output_db.exists() else 0,
            "index_file_bytes": self.output_db.with_suffix(".nodes.store").stat().st_size if self.output_db.with_suffix(".nodes.store").exists() else 0,
            "disk_free_bytes_after": free_bytes,
            "peak_working_set_bytes": _peak_memory_bytes(),
            "records_are_routable": False,
            "records_are_benchmark_only": self.benchmark,
            "attribution": ATTRIBUTION,
            "license": LICENSE,
            "copyright_url": OSM_COPYRIGHT,
        }

    def _export_jsonl(self) -> None:
        target = self.output_db.with_suffix(".places.jsonl")
        temporary = target.with_suffix(target.suffix + ".partial")
        with temporary.open("w", encoding="utf-8", newline="\n") as output:
            for (record_json,) in self.connection.execute(
                "SELECT json_object('source_type',source_type,'source_id',source_id,'source_key',source_key,'name',name,'name_variants',json(name_variants_json),'categories',json(categories_json),'subcategory',subcategory,'latitude',latitude,'longitude',longitude,'distance_km',distance_km,'area_class',area_class,'importance_evidence_score',importance_evidence_score,'importance_signals',json(importance_signals_json),'wikidata_qid',wikidata_qid,'wikipedia_ref',wikipedia_ref,'accommodation_type',accommodation_type,'hotel_stars_evidence',hotel_stars_evidence,'cuisine',cuisine,'dietary_claims',json(dietary_claims_json),'raw_tags',json(raw_tags_json),'geometry_method',geometry_method,'source_url',source_url,'attribution',attribution,'license',license,'source_snapshot',source_snapshot,'data_status',data_status,'itinerary_ready',itinerary_ready) FROM places ORDER BY importance_evidence_score DESC,source_type,source_id"):
                output.write(record_json + "\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, target)

    def _write_summary(self, summary: dict[str, Any]) -> None:
        target = self.output_db.with_suffix(".summary.json")
        temporary = target.with_suffix(target.suffix + ".partial")
        with temporary.open("w", encoding="utf-8", newline="\n") as output:
            json.dump(summary, output, ensure_ascii=False, indent=2, sort_keys=True)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, target)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path, help="completed local OSM PBF; source is read-only")
    parser.add_argument("--output-db", required=True, type=Path, help="new local SQLite output; never an existing database")
    parser.add_argument("--latitude", type=float, default=DEFAULT_CENTER[0])
    parser.add_argument("--longitude", type=float, default=DEFAULT_CENTER[1])
    parser.add_argument("--radius-km", type=int, default=40)
    parser.add_argument("--resume", action="store_true", help="replay immutable PBF into the matching checkpoint using unique source keys")
    parser.add_argument("--benchmark", action="store_true", help="mark outputs as benchmark-only and never pilot-ready")
    parser.add_argument("--allow-xml-fixture", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--checkpoint-objects", type=int, default=CHECKPOINT_OBJECTS)
    args = parser.parse_args(argv)
    try:
        validate_radius(args.radius_km)
    except ValueError as error:
        parser.error(str(error))
    if not -90 <= args.latitude <= 90 or not -180 <= args.longitude <= 180:
        parser.error("center coordinates are outside valid latitude/longitude bounds")
    if args.allow_xml_fixture and not args.benchmark:
        parser.error("XML fixtures are allowed only for benchmark-only runs")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        summary = PbfExtractor(args.input, args.output_db, args.latitude, args.longitude, args.radius_km, args.resume, args.benchmark, args.checkpoint_objects, args.allow_xml_fixture).run()
    except Exception as error:
        print(json.dumps({"status": "failed", "error": str(error)[:500]}), file=sys.stderr)
        return 2
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
