#!/usr/bin/env python3
"""Read-only gesture eligibility sampler. Run ON MAIA; never changes anything.

Polls the private loopback GET /public-interactions and appends one line per
sample with only gate names, the threat reason and timing, never coordinates,
entity details or the token:

    python3 scripts/gesture-eligibility-sample.py OUT.jsonl [--interval 30] [--hours 24]
    python3 scripts/gesture-eligibility-sample.py --summary OUT.jsonl

The operator token is read from ~/.config/blockhead/operator.env on Maia.
An "eligible" sample means every admission gate passed at that instant; a
public gesture would additionally need actions enabled and no cooldown.
"""
import argparse
import collections
import json
import os
import sys
import time
import urllib.request

parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
parser.add_argument("out")
parser.add_argument("--interval", type=float, default=30.0)
parser.add_argument("--hours", type=float, default=24.0)
parser.add_argument("--summary", action="store_true")
args = parser.parse_args()


def summarize(path):
    rows = [json.loads(line) for line in open(path)]
    ok = [r for r in rows if "error" not in r]
    eligible = [r for r in ok if r["safe"]]
    runs, run = [], 0
    for r in ok:
        run = run + 1 if r["safe"] else 0
        if r["safe"]:
            runs.append(run)
    print(json.dumps({
        "samples": len(rows), "errors": len(rows) - len(ok), "eligible": len(eligible),
        "eligible_fraction": round(len(eligible) / len(ok), 4) if ok else None,
        "longest_eligible_run_samples": max(runs, default=0),
        "first": ok[0]["t"] if ok else None, "last": ok[-1]["t"] if ok else None,
        "blocked": dict(collections.Counter(g for r in ok for g in r["blocked"]).most_common()),
        "physical": dict(collections.Counter(g for r in ok for g in r["physical"]).most_common()),
        "threat": dict(collections.Counter(f'{r["threat"]}:{r.get("mob")}' for r in ok).most_common()),
        "only_threats_blocking": sum(1 for r in ok if r["blocked"] == ["threats"]),
        "eligible_times": [r["t"] for r in eligible][:50],
    }, indent=2))


if args.summary:
    summarize(args.out)
    sys.exit(0)

if not (5 <= args.interval <= 600) or not (0 < args.hours <= 72):
    parser.error("interval 5-600 s, hours up to 72")
env = {}
for line in open(os.path.expanduser("~/.config/blockhead/operator.env")):
    if "=" in line and not line.lstrip().startswith("#"):
        key, value = line.strip().split("=", 1)
        env[key] = value.strip().strip('"')
token = env["BLOCKHEAD_OPERATOR_TOKEN"]
deadline = time.time() + args.hours * 3600
fd = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
with os.fdopen(fd, "a") as out:
    i = 0
    while time.time() < deadline:
        row = {"i": i, "t": int(time.time())}
        try:
            req = urllib.request.Request("http://127.0.0.1:8155/public-interactions",
                                         headers={"Authorization": "Bearer " + token}, method="GET")
            d = json.load(urllib.request.urlopen(req, timeout=8))
            admission = d.get("admission") or {}
            row.update({
                "safe": admission.get("safe") is True,
                "blocked": sorted(k for k, v in (admission.get("checks") or {}).items() if v != "pass"),
                "physical": sorted(k for k, v in ((d.get("physical") or {}).get("checks") or {}).items() if v != "pass"),
                "threat": (d.get("threats") or {}).get("reason"), "mob": (d.get("threats") or {}).get("mob"),
                "configuredActions": d.get("configuredActions"),
                "quarantined": (d.get("gesture") or {}).get("quarantined"),
            })
        except Exception as error:  # an unreachable bot is data, not a crash
            row["error"] = type(error).__name__
        out.write(json.dumps(row) + "\n")
        out.flush()
        i += 1
        time.sleep(args.interval)
