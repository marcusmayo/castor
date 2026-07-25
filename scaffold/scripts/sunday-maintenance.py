#!/usr/bin/env python3
"""sunday-maintenance.py — weekly context hygiene.

This is the SOLE writer of MEMORY.md. Per the Castor operating rule, MEMORY.md
is refreshed only by this weekly path and never mid-conversation, so state
written here is stable and deliberate rather than accumulated ad hoc.

Actions:
  1. Refresh MEMORY.md from a deterministic snapshot of durable state (pipeline
     counts by stage, open action count, last digest). No conversational
     content ever enters MEMORY.md.
  2. Prune inbox/archive entries older than the retention window.
  3. Report what it did. Read-only elsewhere; writes only MEMORY.md and prunes
     the archive.

Usage:  python3 scripts/sunday-maintenance.py [--dry-run]
"""
import os
import sys
import glob
import time
import datetime

AGENT_ROOT = os.environ.get("AGENT_ROOT", os.path.join(os.path.expanduser("~"), "castor"))
MEMORY = os.path.join(AGENT_ROOT, "MEMORY.md")
PIPELINE_DIR = os.path.join(AGENT_ROOT, "state", "pipeline")
REGISTER = os.path.join(AGENT_ROOT, "state", "action-register.md")
INBOX_ARCHIVE = os.path.join(AGENT_ROOT, "inbox", "archive")
REPORTS = os.path.join(AGENT_ROOT, "state", "weekly-reports")
RETENTION_DAYS = int(os.environ.get("ARCHIVE_RETENTION_DAYS", "90"))

DRY = "--dry-run" in sys.argv


def pipeline_counts():
    counts = {}
    for f in glob.glob(os.path.join(PIPELINE_DIR, "*.yaml")):
        if os.path.basename(f) == "_item-template.yaml":
            continue
        stage = "unknown"
        try:
            for line in open(f, encoding="utf-8"):
                s = line.strip()
                if s.startswith("stage:"):
                    stage = s.split(":", 1)[1].strip() or "unknown"
                    break
        except OSError:
            stage = "unreadable"
        counts[stage] = counts.get(stage, 0) + 1
    return counts


def open_action_count():
    # Count register rows whose status is not 'done'. Deterministic line parse.
    n = 0
    try:
        for line in open(REGISTER, encoding="utf-8"):
            s = line.strip()
            if not s.startswith("| ACT-"):
                continue
            cells = [c.strip() for c in s.split("|")[1:-1]]
            if len(cells) >= 5 and cells[4] != "done":
                n += 1
    except OSError:
        pass
    return n


def last_digest():
    try:
        files = sorted(glob.glob(os.path.join(REPORTS, "*-digest*.md")))
        return os.path.basename(files[-1]) if files else "(none)"
    except OSError:
        return "(none)"


def refresh_memory():
    counts = pipeline_counts()
    stages = ", ".join(f"{k}: {v}" for k, v in sorted(counts.items())) or "(no items)"
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    body = (
        "# MEMORY\n\n"
        "Durable state snapshot. Written only by the weekly maintenance path\n"
        "(scripts/sunday-maintenance.py) — never mid-conversation. Contains no\n"
        "conversational content, only deterministic counts of durable state.\n\n"
        f"- Last refreshed: {now}\n"
        f"- Pipeline by stage: {stages}\n"
        f"- Open actions: {open_action_count()}\n"
        f"- Last digest: {last_digest()}\n"
    )
    if DRY:
        print("[dry-run] would write MEMORY.md:\n" + body)
        return
    with open(MEMORY, "w", encoding="utf-8") as fh:
        fh.write(body)
    os.chmod(MEMORY, 0o600)
    print(f"MEMORY.md refreshed (pipeline: {stages}; open actions: {open_action_count()})")


def prune_archive():
    if not os.path.isdir(INBOX_ARCHIVE):
        print("inbox/archive: nothing to prune")
        return
    cutoff = time.time() - RETENTION_DAYS * 86400
    pruned = 0
    for f in glob.glob(os.path.join(INBOX_ARCHIVE, "*")):
        try:
            if os.path.isfile(f) and os.path.getmtime(f) < cutoff:
                if DRY:
                    pruned += 1
                else:
                    os.remove(f)
                    pruned += 1
        except OSError:
            continue
    print(f"inbox/archive: {'would prune' if DRY else 'pruned'} {pruned} file(s) older than {RETENTION_DAYS}d")


def main():
    refresh_memory()
    prune_archive()
    print("sunday-maintenance: done")


if __name__ == "__main__":
    main()
