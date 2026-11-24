#!/usr/bin/env python3
import argparse
import csv
import getpass
import io
import json
import os
import sys
import urllib.request
import zipfile
from urllib.parse import urlsplit


URL = "https://download.geonames.org/export/dump/cities500.zip"
COLS = [
    "geonameid",
    "name",
    "asciiname",
    "alternatenames",
    "latitude",
    "longitude",
    "feature_class",
    "feature_code",
    "country_code",
    "cc2",
    "admin1",
    "admin2",
    "admin3",
    "admin4",
    "population",
    "elevation",
    "dem",
    "timezone",
    "modification_date",
]


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "IndiaTourismCitySeeder/1.0"})
    with urllib.request.urlopen(req, timeout=180) as response:
        return response.read()


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def resolve_supabase_secret_key():
    secret_key = os.environ.get("SUPABASE_SECRET_KEY")
    if secret_key and secret_key.strip():
        return secret_key
    if not sys.stdin.isatty() or not sys.stderr.isatty():
        return None
    secret_key = getpass.getpass("Enter SUPABASE_SECRET_KEY: ")
    return secret_key if secret_key.strip() else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--supabase-url", default=os.environ.get("SUPABASE_URL"))
    parser.add_argument("--limit", type=int, default=500)
    parser.add_argument("--csv")
    args = parser.parse_args()

    if not args.supabase_url:
        parser.error("Set SUPABASE_URL or pass --supabase-url")

    parsed_url = urlsplit(args.supabase_url)
    if (
        parsed_url.scheme != "https"
        or not parsed_url.hostname
        or parsed_url.username is not None
        or parsed_url.password is not None
        or parsed_url.path not in ("", "/")
        or parsed_url.query
        or parsed_url.fragment
    ):
        parser.error("SUPABASE_URL must be a valid HTTPS origin without credentials or URL parameters")

    args.supabase_secret_key = resolve_supabase_secret_key()
    if not args.supabase_secret_key:
        parser.error("Set SUPABASE_SECRET_KEY in the environment or use an interactive terminal")

    if not 1 <= args.limit <= 500:
        parser.error("--limit must be between 1 and 500")

    if args.csv:
        with open(args.csv, encoding="utf-8-sig", newline="") as source:
            raw = list(csv.DictReader(source))
        cities = [
            {
                "name": row["name"],
                "state_name": row.get("state_name"),
                "latitude": float(row["latitude"]),
                "longitude": float(row["longitude"]),
                "population": int(row["population"]) if row.get("population") else None,
                "city_source": "curated",
                "country_code": "IN",
                "radius_km": 40,
            }
            for row in raw[: args.limit]
        ]
    else:
        archive = zipfile.ZipFile(io.BytesIO(get(URL)))
        records = []
        with archive.open(archive.namelist()[0]) as source:
            for line in io.TextIOWrapper(source, encoding="utf-8"):
                values = line.rstrip("\n").split("\t")
                if len(values) < 19 or values[8] != "IN" or values[6] != "P":
                    continue
                try:
                    latitude, longitude = float(values[4]), float(values[5])
                except ValueError:
                    continue
                records.append(
                    {
                        "geonames_id": int(values[0]),
                        "name": values[1],
                        "latitude": latitude,
                        "longitude": longitude,
                        "population": int(values[14] or 0),
                        "city_source": "GeoNames",
                        "country_code": "IN",
                        "radius_km": 40,
                        "state_name": values[10] or None,
                    }
                )

        records.sort(key=lambda city: city["population"], reverse=True)
        seen = set()
        cities = []
        for city in records:
            key = (city["name"].lower(), round(city["latitude"], 2), round(city["longitude"], 2))
            if key in seen:
                continue
            seen.add(key)
            cities.append(city)
            if len(cities) >= args.limit:
                break

    if not cities:
        raise SystemExit("No city records found")

    endpoint = args.supabase_url.rstrip("/") + "/rest/v1/tourism_cities?on_conflict=geonames_id"
    headers = {
        "apikey": args.supabase_secret_key,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    if not args.supabase_secret_key.startswith("sb_secret_"):
        headers["Authorization"] = "Bearer " + args.supabase_secret_key

    opener = urllib.request.build_opener(NoRedirectHandler())
    for index in range(0, len(cities), 100):
        batch = cities[index : index + 100]
        request = urllib.request.Request(
            endpoint,
            data=json.dumps(batch).encode(),
            headers=headers,
            method="POST",
        )
        with opener.open(request, timeout=90) as response:
            print("Uploaded", len(batch), "HTTP", response.status)

    print("Imported", len(cities), "cities. Review city list before running collection.")


if __name__ == "__main__":
    main()
