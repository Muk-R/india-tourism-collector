#!/usr/bin/env python3
import argparse
import getpass
import json
import os
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def resolve_admin_token():
    token = os.environ.get("ADMIN_TOKEN")
    if token and token.strip():
        return token
    if not sys.stdin.isatty() or not sys.stderr.isatty():
        return None
    token = getpass.getpass("Enter ADMIN_TOKEN: ")
    return token if token.strip() else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker-url", required=True)
    parser.add_argument("--calls", type=int, default=100)
    parser.add_argument(
        "--cities-per-call",
        type=int,
        default=1,
        help="Compatibility option; each Worker request processes one five-item chunk",
    )
    parser.add_argument("--delay", type=int, default=30)
    parser.add_argument("--radius-km", type=int, choices=[30, 40, 50])
    args = parser.parse_args()

    parsed_url = urlsplit(args.worker_url)
    if (
        parsed_url.scheme != "https"
        or not parsed_url.hostname
        or parsed_url.username is not None
        or parsed_url.password is not None
        or parsed_url.path not in ("", "/")
        or parsed_url.query
        or parsed_url.fragment
    ):
        parser.error("--worker-url must be a valid HTTPS origin without credentials or URL parameters")

    args.admin_token = resolve_admin_token()
    if not args.admin_token:
        parser.error("Set ADMIN_TOKEN in the environment or use an interactive terminal")

    opener = urllib.request.build_opener(NoRedirectHandler())
    for index in range(args.calls):
        url = args.worker_url.rstrip("/") + "/admin/collect"
        if args.radius_km:
            url += f"?radiusKm={args.radius_km}"
        request = urllib.request.Request(
            url,
            data=b"{}",
            headers={
                "Authorization": "Bearer " + args.admin_token,
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with opener.open(request, timeout=180) as response:
                body = response.read().decode()
                result = json.loads(body)
                print(f"{index + 1}/{args.calls} HTTP {response.status}: {body}")
                if result.get("status") == "idle":
                    print("No pending cities.")
                    break
                if result.get("processed", 0) == 0 and result.get("remaining", 0) > 0:
                    time.sleep(max(args.delay, 300))
        except urllib.error.HTTPError as error:
            print("HTTP", error.code, error.read().decode()[:500])
            if error.code not in (429, 500, 502, 503, 504):
                raise
            time.sleep(max(args.delay, 90))
        time.sleep(args.delay)


if __name__ == "__main__":
    main()
