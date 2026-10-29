#!/usr/bin/env python3
"""Read-only Maia preflight; emits evidence, never grants deployment admission.

Run on Maia (or feed to python3 over SSH). No feature toggles, game commands,
service changes, database checkpoint operations or remote file writes.
"""
import datetime
import hashlib
import json
import os
import pathlib
import socket
import sqlite3
import subprocess
import urllib.request


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def get(port, path):
    headers = {}
    if path == "/public-interactions":
        headers["Authorization"] = "Bearer " + os.environ["BLOCKHEAD_OPERATOR_TOKEN"]
    request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", headers=headers)
    with urllib.request.urlopen(request, timeout=8) as response:
        return json.load(response)


def command(*args):
    return subprocess.check_output(args, text=True, timeout=15).strip()


def main():
    assert socket.gethostname() == "maia", "Run only on Maia"
    source = pathlib.Path("/mnt/Repos/Games/Blockhead")
    manifest = json.loads((source / "docs/investigations/public-actions-2026-10-20-observability-deployment.json").read_text())
    runtime = pathlib.Path(manifest["runtime"])
    status_before = get(8155, "/status")
    flags = get(8155, "/public-interactions")
    files = []
    for entry in manifest["files"]:
        installed, candidate = digest(runtime / entry["path"]), digest(source / entry["path"])
        files.append({**entry, "installed_sha256": installed, "source_sha256": candidate,
                      "baseline_matches": installed == entry["before_sha256"],
                      "candidate_matches": candidate == entry["candidate_sha256"]})
    installed = {str(p.relative_to(runtime)): digest(p) for p in sorted((runtime / "src").rglob("*")) if p.is_file()}
    candidates = {str(p.relative_to(source)): digest(p) for p in sorted((source / "src").rglob("*")) if p.is_file()}
    differences = sorted(p for p in installed.keys() | candidates.keys()
                         if not p.endswith(".test.ts") and installed.get(p) != candidates.get(p))
    with sqlite3.connect(f"file:{source}/data/blockhead.db?mode=ro", uri=True, timeout=5) as db:
        db.execute("PRAGMA query_only=ON")
        db.row_factory = sqlite3.Row
        unfinished = [dict(row) for row in db.execute("SELECT * FROM tasks WHERE status NOT IN ('completed','failed','cancelled') ORDER BY id")]
        task_counts = {row[0]: row[1] for row in db.execute("SELECT status,count(*) FROM tasks GROUP BY status")}
    dashboard = get(3000, "/api/state")
    journal = command("journalctl", "--user", "-u", "blockhead.service", "--since", "10 minutes ago", "--no-pager", "-o", "json", "-n", "100")
    messages = []
    for line in journal.splitlines():
        try:
            record = json.loads(json.loads(line)["MESSAGE"])
            messages.append({"time": record.get("time"), "level": record.get("level"), "msg": record.get("msg")})
        except (ValueError, KeyError, TypeError):
            continue
    defaults = [line.strip() for line in (source / "config/minecraft.yaml").read_text().splitlines()
                if line.strip().startswith(("questions_enabled:", "actions_enabled:"))]
    result = {
        "recorded_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "method": "read-only HTTP GET, filesystem hashes, query-only SQLite and systemd show; no injection or game connection",
        "source_commit": command("git", "-C", str(source), "rev-parse", "HEAD"),
        "status_before": status_before, "flags": flags,
        "services": command("systemctl", "--user", "show", "blockhead.service", "minecraft-server.service", "llama-server.service", "-p", "Id", "-p", "ActiveState", "-p", "MainPID", "-p", "NRestarts"),
        "files": files, "runtime_source_differences": differences,
        "installed_src_hashes": installed, "unfinished_tasks": unfinished, "task_counts": task_counts,
        "dashboard_diagnostic": {key: dashboard.get(key) for key in ("danger", "llmActivity", "buildProject", "worldProject")},
        "journal_summary": {"parsed_records": len(messages),
                            "standing_by_times": [m["time"] for m in messages if m["msg"] == "director standing by"],
                            "warning_or_error_count": sum(isinstance(m["level"], int) and m["level"] >= 40 for m in messages)},
        "startup_defaults": defaults,
        "backup_proposed_exists": pathlib.Path(manifest["backup_proposed"]).exists(),
        "original_threat_backup_exists": pathlib.Path(manifest["original_threat_backup"]).is_dir(),
        "status_after": get(8155, "/status"), "flags_after": get(8155, "/public-interactions"),
        "deployment_performed": False, "feature_mutations_performed": False,
        "primitive_settlement": "unknown: existing GET APIs do not expose dispatcher execution count or all primitive state; null task is insufficient",
        "effect_acceptance": "unverified; independent server effects and complete outgoing attack/use coverage still required",
    }
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
