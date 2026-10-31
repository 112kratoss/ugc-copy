#!/usr/bin/env python3
"""UserPromptSubmit hook: refuse a prompt that @-mentions a secrets file (.env*, not .env.example, or .mcp.json).

Claude Code pastes an @-mentioned file into the conversation while it builds the prompt, with no tool call, so the
PreToolUse hooks never see it. A Read deny rule used to refuse it; since 2026-11-01 those rules are gone (see
protect-migrations.py for why). Exit 2 blocks the prompt before it reaches Claude.
"""
import json
import os
import re
import sys

SECRET_NAME = re.compile(r"\.env(?!\.example$)(?:\.[\w.-]+)?|\.mcp\.json", re.IGNORECASE)

payload = json.load(sys.stdin)
prompt = payload.get("prompt") or ""
cwd = payload.get("cwd") or os.getcwd()
# An @-mention starts a word (so an email address is not one) and runs to the next space, or sits in quotes.
for mention in re.finditer(r"(?<![\w.@])@(\"[^\"\n]+\"|'[^'\n]+'|\S+)", prompt):
    path = mention.group(1).strip("\"'").rstrip(",.;:!?)]}>")
    if not path:
        continue
    for candidate in (path, os.path.realpath(os.path.join(cwd, os.path.expanduser(path)))):
        name = os.path.basename(candidate.rstrip("/"))
        if SECRET_NAME.fullmatch(name):
            sys.stderr.write(
                f"Blocked by .claude/hooks/guard-prompt.py: @{path} would paste {name}, a secrets file, into the "
                "conversation. Send it without the @ and ask for a check instead, such as whether NAME is set in it.\n"
            )
            sys.exit(2)
sys.exit(0)
