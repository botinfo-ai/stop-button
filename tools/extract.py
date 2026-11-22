#!/usr/bin/env python3
"""Turn recorded BotInfo audit logs into the page's replay files (data/*.json) and check the replay.

Two inputs are accepted:

  1. A lab evidence file (BotInfo's internal lab keeps one per request: scores, summary and every run's audit log):
       python3 tools/extract.py --evidence path/to/20261121-0651-stop-timing-forced-wait-gpt6luna.json

  2. A plain audit log from your own run of BotInfo (`python3 -m botinfo serve ... --audit my-run.jsonl`):
       python3 tools/extract.py --audit my-run.jsonl --model my-model --client "my client" \
           --commit <botinfo commit> --task task.txt --report report.txt --id my-run

Each audit line is kept byte for byte, except two fields of the first line ("start") that hold local file paths;
they are cut to the repository-relative path. Anything that still looks like a home folder or an email address
stops the script. Every run is then replayed with the same motion model the page uses (a port of SimRover.step at
BotInfo 5b77213) and its final position is compared with the stop receipt BotInfo logged. Python 3.9+, no packages.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
BOTINFO_REPO = "https://github.com/botinfo-ai/botinfo"
LAB_COMMIT = "5b77213faa50a2cdc6a596465372c9f7d5840fec"   # BotInfo checkout the lab ran from 2026-11-07 to 2026-11-21
PRIVATE = re.compile(r"/Users/|/home/|[A-Za-z]:\\+Users\\+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}", re.I)   # home folders, emails
GENESIS = "0" * 64


# ---------------------------------------------------------------- the motion model (same as sim.js)
LINEAR_ACCEL, ANGULAR_ACCEL, STEP_S = 2.0, 8.0, 0.01
MAX_SPEED, MAX_ANGULAR = 1.0, 2.0          # SimRover's default driver caps (/rover/max_speed, /rover/max_angular)


def commands(events: list) -> list:
    """(t, cmd_v, cmd_w) changes, in seconds since the run's first audit line, from BotInfo's own audit events:
    an allowed drive starts its speed, a lease end or any delivered stop sets zero."""
    t0 = events[0]["t"]
    out = []
    for e in events:
        t = e["t"] - t0
        if e.get("event") == "decision" and e.get("tool") == "drive" and e.get("decision") == "allowed":
            p = e.get("params") or {}
            out.append((t, float(p.get("linear_mps", 0.0)), float(p.get("angular_rps", 0.0))))
        elif e.get("event") == "lease_end" and e.get("stop_sent"):
            out.append((t, 0.0, 0.0))
        elif e.get("event") == "stop" and e.get("delivered"):
            out.append((t, 0.0, 0.0))
        elif e.get("event") == "replaced":
            out.append((t, 0.0, 0.0))
    return out


def simulate(cmds: list, t_end: float) -> dict:
    x = y = th = v = w = 0.0
    cv = cw = 0.0
    i, t = 0, 0.0
    while t < t_end - 1e-12:
        while i < len(cmds) and cmds[i][0] <= t + 1e-12:
            cv, cw = cmds[i][1], cmds[i][2]
            i += 1
        dt = STEP_S
        tv = max(-MAX_SPEED, min(MAX_SPEED, cv))
        tw = max(-MAX_ANGULAR, min(MAX_ANGULAR, cw))
        v += max(-LINEAR_ACCEL * dt, min(LINEAR_ACCEL * dt, tv - v))
        w += max(-ANGULAR_ACCEL * dt, min(ANGULAR_ACCEL * dt, tw - w))
        x += v * math.cos(th) * dt
        y += v * math.sin(th) * dt
        th = (th + w * dt + math.pi) % (2 * math.pi) - math.pi
        t += dt
    return {"x": x, "y": y, "heading": th, "v": v, "w": w}


# ---------------------------------------------------------------- audit handling
def sanitize(lines: list) -> list:
    out = []
    for n, raw in enumerate(lines):
        if not raw.strip():
            continue
        e = json.loads(raw)
        if e.get("event") == "start":
            changed = False
            b = e.get("backend")
            if isinstance(b, dict) and isinstance(b.get("binding"), str) and "/" in b["binding"]:
                b["binding"] = "bindings/" + b["binding"].rsplit("/", 1)[-1]
                changed = True
            if isinstance(e.get("policy_file"), str) and "/" in e["policy_file"]:
                e["policy_file"] = "policies/" + e["policy_file"].rsplit("/", 1)[-1]
                changed = True
            if changed:
                raw = json.dumps(e, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        m = PRIVATE.search(raw)
        if m:
            sys.exit(f"audit line {n + 1} still holds something private-looking: {m.group(0)!r}; not written")
        out.append(raw)
    return out


def chain_ok(lines: list) -> tuple:
    """(links that verify, links checked) on the ORIGINAL lines."""
    prev, good = GENESIS, 0
    for raw in lines:
        e = json.loads(raw)
        if e.get("prev") == prev:
            good += 1
        prev = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    return good, len(lines)


def ai_under_test(summary: str) -> str:
    m = re.search(r"AI under test: [^(]+\(([^,]+),", summary or "")
    return m.group(1).strip() if m else ""


def check_text(label: str, s: str) -> str:
    m = PRIVATE.search(s or "")
    if m:
        sys.exit(f"{label} holds something private-looking: {m.group(0)!r}; not written")
    return s


def replay_check(events: list) -> dict:
    cmds = commands(events)
    rec = [e for e in events if e.get("event") == "stop_receipt" and e.get("by") == "owner"]
    stop = [e for e in events if e.get("event") == "stop" and e.get("by") == "owner"]
    if not rec or not stop or not rec[-1].get("last_read"):
        return {}
    t0 = events[0]["t"]
    t_read = stop[-1]["t"] - t0 + rec[-1]["last_read"]["after_stop_s"]
    sim = simulate(cmds, t_read)
    logged = rec[-1]["last_read"]
    return {"logged_x": round(logged["x"], 4), "replay_x": round(sim["x"], 4),
            "diff_mm": round(abs(sim["x"] - logged["x"]) * 1000, 1)}


def write_run(rid: str, meta: dict, original: list) -> dict:
    clean = sanitize(original)
    events = [json.loads(s) for s in clean]
    good, total = chain_ok(original)
    meta = dict(meta)
    meta["audit_chain"] = {"links_verified_before_path_cut": good, "lines": total,
                           "note": "Line 1 had two local file paths cut to repository paths, so line 2's prev "
                                   "no longer matches it; every later link still verifies."}
    meta["replay_check"] = replay_check(events)
    meta["audit"] = clean
    path = DATA / f"{rid}.json"
    path.write_text(json.dumps(meta, indent=1, ensure_ascii=False) + "\n")
    return {"file": f"data/{path.name}", "id": rid, "model": meta["model"], "run": meta.get("run"),
            "date": meta["date"], "label": meta["label"], "replay_check": meta["replay_check"],
            "chain": f"{good}/{total}"}


def from_evidence(path: Path, runs: list | None) -> list:
    ev = json.loads(path.read_text())
    client = ai_under_test(ev.get("summary", ""))
    if "Codex" in (ev.get("client") or ""):
        client = "OpenAI Codex CLI"
    out = []
    for i, (audit, score) in enumerate(zip(ev["audit"], ev["scores"]), start=1):
        if runs and i not in runs:
            continue
        lines = [s for s in audit.splitlines() if s.strip()]
        version = score.get("client") or ""
        meta = {
            "id": f"{ev['id']}-run{i}", "lab_request": ev["id"], "run": i, "runs_in_request": len(ev["audit"]),
            "model": ev["model"], "client": client + (f" ({version})" if version else ""),
            "date": ev["at"][:10], "lab_time": ev["at"],
            "botinfo_commit": LAB_COMMIT, "botinfo_repo": BOTINFO_REPO,
            "policy": "policies/simrover.toml", "binding": "bindings/simrover-ros-style.toml",
            "task": check_text("task", ev["task"]),
            "stop_setting": {"after_allowed_drive": ev.get("stop_after_drives"), "delay_s": ev.get("stop_delay_s")},
            "final_report": check_text("final report", score.get("final_report", "")),
            "scores": {k: score[k] for k in score if k[:2] in ("R1", "R2", "R3", "S1", "A1") or k == "stop timing"},
            "label": f"{ev['model']}, run {i} of {len(ev['audit'])}",
        }
        out.append(write_run(meta["id"], meta, lines))
    return out


def from_audit(a) -> list:
    lines = [s for s in Path(a.audit).read_text().splitlines() if s.strip()]
    meta = {"id": a.id, "lab_request": a.id, "run": 1, "runs_in_request": 1, "model": a.model,
            "client": a.client or "", "date": json.loads(lines[0])["wall"][:10],
            "botinfo_commit": a.commit or "", "botinfo_repo": BOTINFO_REPO,
            "policy": "policies/simrover.toml", "binding": "bindings/simrover-ros-style.toml",
            "task": check_text("task", Path(a.task).read_text().strip() if a.task else ""),
            "stop_setting": {}, "scores": {},
            "final_report": check_text("final report", Path(a.report).read_text().strip() if a.report else ""),
            "label": f"{a.model}, your run"}
    return [write_run(a.id, meta, lines)]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--evidence", action="append", default=[], help="a lab evidence JSON file (repeatable)")
    ap.add_argument("--runs", default="", help="only these run numbers, e.g. 1,3")
    ap.add_argument("--audit", help="a plain BotInfo audit.jsonl from your own run")
    ap.add_argument("--id", default="my-run")
    ap.add_argument("--model", default="unknown model")
    ap.add_argument("--client", default="")
    ap.add_argument("--commit", default="")
    ap.add_argument("--task", help="a text file with the words the AI heard")
    ap.add_argument("--report", help="a text file with the AI's final report")
    ap.add_argument("--index", action="store_true", help="rewrite data/runs.json from every data/*.json")
    a = ap.parse_args()
    DATA.mkdir(exist_ok=True)
    runs = [int(x) for x in a.runs.split(",") if x.strip()] or None
    done = []
    for p in a.evidence:
        done += from_evidence(Path(p), runs)
    if a.audit:
        done += from_audit(a)
    for d in done:
        rc = d["replay_check"]
        print(f"{d['file']}: {d['label']}, chain {d['chain']}, "
              + (f"replay x {rc['replay_x']} vs logged {rc['logged_x']} ({rc['diff_mm']} mm)" if rc else "no owner stop receipt"))
    if a.index or done:
        idx = []
        for p in sorted(DATA.glob("*.json")):
            if p.name == "runs.json":
                continue
            m = json.loads(p.read_text())
            idx.append({"file": f"data/{p.name}", "id": m["id"], "model": m["model"], "run": m.get("run"),
                        "date": m["date"], "label": m["label"], "lab_request": m.get("lab_request")})
        idx.sort(key=lambda r: (r["date"], r["id"]), reverse=True)
        (DATA / "runs.json").write_text(json.dumps({"runs": idx}, indent=1) + "\n")
        print(f"data/runs.json: {len(idx)} runs")


if __name__ == "__main__":
    main()
