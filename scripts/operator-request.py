#!/usr/bin/env python3
"""Local operator CLI. Secret comes from environment; request body comes from stdin."""
import argparse
import os
import sys
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("route", choices=["command", "public-interactions"])
parser.add_argument("--get", action="store_true", help="read private interaction diagnostics")
parser.add_argument("--port", type=int, default=8155)
args = parser.parse_args()
token = os.environ.get("BLOCKHEAD_OPERATOR_TOKEN", "")
if len(token) < 32:
    parser.error("BLOCKHEAD_OPERATOR_TOKEN must contain at least 32 characters")
if args.get and args.route != "public-interactions":
    parser.error("GET is only supported for public-interactions")
body = None if args.get else sys.stdin.buffer.read(4097)
if body is not None and len(body) > 4096:
    parser.error("body exceeds 4096 bytes")
req = urllib.request.Request(
    f"http://127.0.0.1:{args.port}/{args.route}", data=body,
    headers={"Authorization": "Bearer " + token,
             "Content-Type": "text/plain" if args.route == "command" else "application/json"},
    method="GET" if args.get else "POST",
)
with urllib.request.urlopen(req, timeout=8) as response:
    sys.stdout.buffer.write(response.read(65536))
