#!/usr/bin/env python3
"""PreToolUse hook for Bash: refuse commands that break the repo's standing rules, naming the right form instead.

Each rule here is one AGENTS.md or memory rule that was re-learned the hard way. Exit 2 blocks the command and
the stderr message reaches Claude; anything not matched passes untouched.
"""
import json
import re
import subprocess
import sys

payload = json.load(sys.stdin)
command = (payload.get("tool_input") or {}).get("command") or ""
if not command.strip():
    sys.exit(0)


def block(message):
    sys.stderr.write("Blocked by .claude/hooks/guard-bash.py: " + message + "\n")
    sys.exit(2)


SECRET_FILE = r"\.env(?!\.example\b)(?:\.[\w.-]+)?\b|\.mcp\.json\b"
PRINTERS = r"\b(?:cat|less|more|head|tail|bat|strings|od|xxd|hexdump|base64|nl|cut|sort|uniq|tee|awk|diff|comm|paste)\b"

for segment in re.split(r"\|\||&&|;|\||\n", command):
    segment = segment.strip()
    if not segment or not re.search(SECRET_FILE, segment):
        continue
    if re.search(PRINTERS + r"[^|;&\n]*(?:" + SECRET_FILE + ")", segment):
        block(
            "that prints a secrets file (.env*, .mcp.json) into the transcript. Check presence with "
            "`grep -c '^NAME=' .env.local` or `wc -c`; install a value with `printf 'NAME=%s\\n' \"$(pbpaste)\" >> .env.local`."
        )
    if re.search(r"\bsed\b(?![^|;&\n]*\s-i\b)[^|;&\n]*(?:" + SECRET_FILE + ")", segment):
        block("sed without -i prints a secrets file. Use `grep -c` to check a name, or `sed -i` to toggle a block in place.")
    grep = re.search(r"\bgrep\b([^|;&\n]*)", segment)
    if grep and not re.search(r"(?:^|\s)-\w*[clq]", grep.group(1)) and not re.search(r"URL", grep.group(1)):
        block("grep on a secrets file prints matching lines. Use `grep -c`, `grep -l` or `grep -q`, or match only `_URL` lines.")

if re.search(r"\bps\s+(?:-?\w+\s+)*(?:aux|-ef|-Af|-ax|-eo|-axo)\b", command) or (
    re.search(r"\bps\b[^|;&\n]*\s-o\s*[\w,=]*\b(?:args|command|cmd)\b", command) and not re.search(r"\s-p\s*\d", command)
):
    block(
        "process listings print every process's full command line and can leak tokens passed as arguments. "
        "Use `pgrep -l <name>`, `ps -o pid,ppid,etime,comm -p <pid>` or `lsof -nP -iTCP:<port> -sTCP:LISTEN`."
    )

for pgrep in re.finditer(r"\bpgrep\b([^|;&\n]*)", command):
    flags = "".join(f[1:] for f in re.findall(r"(?:^|\s)(-[a-zA-Z]+)", pgrep.group(1)))
    if "f" in flags and ("l" in flags or "a" in flags):
        block("`pgrep -f` with `-l` or `-a` prints full command lines (secrets in argv). Use `pgrep -l <name>`, or `pgrep -f <pattern>` alone for PIDs.")

if re.search(r"\bnpx\s+(?:--yes\s+|-y\s+)?expo\b", command):
    block("`npx expo` falls through to the registry and can install a different major when node_modules/.bin is incomplete. Run `./node_modules/.bin/expo` from ugc-mobile, as .claude/launch.json does.")

if re.search(r"\bEXPO_ATLAS=", command):
    block("EXPO_ATLAS installs expo-atlas into package.json, a runtime-fingerprint input. Measure bundles from `expo export --source-maps` instead.")

if re.search(r"\beas(?:-cli(?:@[\w.-]+)?)?\s+update\b", command):
    block("OTAs go out only through `node ugc-mobile/scripts/publish-ota.mjs --platform <ios|android|all>` (a dry run until --publish): it checks the fingerprint target, builds in a clean worktree with a private Metro cache and verifies the artifact.")

if re.search(r"\bnpm\s+run\s+build\b(?!:)|\bnext\s+build\b", command):
    dev_servers = subprocess.run(["pgrep", "-f", "next dev"], capture_output=True, text=True).stdout.split()
    if dev_servers:
        block(f"{len(dev_servers)} `next dev` process(es) are running and `next build` shares .next with them. Stop the preview or dev server first, then build.")

sys.exit(0)
