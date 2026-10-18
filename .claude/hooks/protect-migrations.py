#!/usr/bin/env python3
"""PreToolUse hook for Edit|Write: refuse a change to an applied migration, or a stamp ahead of UTC.

Reads the hook payload on stdin. Exit 2 blocks the tool call and the message on stderr reaches Claude.
"""
import datetime
import json
import os
import re
import subprocess
import sys

payload = json.load(sys.stdin)
file_path = (payload.get("tool_input") or {}).get("file_path") or ""
match = re.search(r"(?:^|/)supabase/migrations/((\d{14})_[^/]+\.sql)$", file_path)
if not match:
    sys.exit(0)
name, stamp = match.group(1), match.group(2)

directory = os.path.dirname(file_path)
while directory and not os.path.isdir(directory):
    directory = os.path.dirname(directory)


def git(*args):
    return subprocess.run(["git", "-C", directory or ".", *args], capture_output=True, text=True)


for ref in ("origin/main", "main"):
    if git("cat-file", "-e", f"{ref}:supabase/migrations/{name}").returncode == 0:
        sys.stderr.write(
            f"Blocked: supabase/migrations/{name} already exists on {ref}, so it has been applied. "
            "Never edit an applied migration: add a new one stamped with `date -u +%Y%m%d%H%M%S`.\n"
        )
        sys.exit(2)

now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d%H%M%S")
if stamp > now:
    sys.stderr.write(
        f"Blocked: {name} is stamped {stamp}, ahead of the UTC clock ({now}). Stamp with `date -u +%Y%m%d%H%M%S`; "
        "supabase-migration-future-stamp.test.ts fails a future stamp and the release refuses to apply one.\n"
    )
    sys.exit(2)
sys.exit(0)
