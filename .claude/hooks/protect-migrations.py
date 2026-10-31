#!/usr/bin/env python3
"""PreToolUse hook for Read|Edit|Write|Grep: keep secrets files away from the file tools, and refuse a change to an
applied migration or a migration stamped ahead of UTC.

Reads the hook payload on stdin. Exit 2 blocks the tool call and the message on stderr reaches Claude.

Secrets files (.env*, but not .env.example, and .mcp.json) are refused here rather than by Read(...) and Edit(...)
deny rules in settings.json, because a deny rule also covers every Bash command that names the path: on Claude Code
2.1.309 a Read deny refused `grep -c '^NAME=' .env.local`, `wc -c` and `stat` on it (checked 2026-11-01), and an Edit
deny refuses the `>> .env.local` install and the `sed -i` toggle. guard-bash.py keeps the shell side: printing,
truncating or deleting a secrets file. .mcp.json keeps its Read deny too, as no shell recipe needs it.
"""
import datetime
import json
import os
import re
import subprocess
import sys

payload = json.load(sys.stdin)
tool = payload.get("tool_name") or ""
tool_input = payload.get("tool_input") or {}
SECRET_NAME = re.compile(r"\.env(?!\.example$)(?:\.[\w.-]+)?|\.mcp\.json")


def secret_name(path):
    name = os.path.basename(str(path or "").rstrip("/"))
    return name if SECRET_NAME.fullmatch(name) else None


# Grep searches a path (a file, or a folder whose gitignored .env files it skips) and may narrow it with a glob.
named = secret_name(tool_input.get("path") if tool == "Grep" else tool_input.get("file_path"))
glob = str(tool_input.get("glob") or "") if tool == "Grep" else ""
if named or re.search(r"\.env(?!\.example\b)|\.mcp\.json", glob):
    sys.stderr.write(
        f"Blocked by .claude/hooks/protect-migrations.py: {named or glob} names a secrets file, closed to the Read, Edit, "
        "Write and Grep tools so no value reaches the transcript. Check a name with `grep -c '^NAME=' .env.local`, "
        "install a value the owner copied with `printf 'NAME=%s\\n' \"$(pbpaste)\" >> .env.local`, toggle a block with `sed -i`.\n"
    )
    sys.exit(2)

if tool not in ("Edit", "Write"):
    sys.exit(0)
file_path = tool_input.get("file_path") or ""
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
