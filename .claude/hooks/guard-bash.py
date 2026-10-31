#!/usr/bin/env python3
"""PreToolUse hook for Bash and Monitor: refuse commands that break the repo's standing rules, naming the right form.

Each rule here is one AGENTS.md or memory rule that was re-learned the hard way. Exit 2 blocks the command and the
stderr message reaches Claude; anything not matched passes untouched.

Since 2026-11-01 this hook, protect-migrations.py and guard-prompt.py are the only guard on secrets files (.env*,
.mcp.json): deny rules also refused the `grep -c` check and the `>>` install that AGENTS.md prescribes. settings.json
leaves this hook fail-open when python3 cannot start, so a session can still repair things through Bash, but a
command that names a secrets file is refused when the check itself errors.
"""
import json
import re
import subprocess
import sys


def block(message):
    sys.stderr.write("Blocked by .claude/hooks/guard-bash.py: " + message + "\n")
    sys.exit(2)


# A secrets file named in the command: .env, .env.local, .env.production and the like (not .env.example) and
# .mcp.json, in any case (a macOS volume ignores it), starting a word or a path component, so `process.env.KEY`,
# `next-env.d.ts` and a regex's `\.env` are not one.
SECRET_FILE = r"(?<![\w$.\\-])(?i:\.env(?!\.example\b)(?:\.[\w.-]+)?\b|\.mcp\.json\b)"
# A redirection target naming one: any run of quoted parts, escapes and bare characters, then the name, which may sit
# inside an opening quote: "/Users/athuls/UGC copy/ugc-app/.env.local", "$ROOT"/.env.local, UGC\ copy/.env.local.
TARGET = r"\s*(?:\"[^\"\n]*\"|'[^'\n]*'|\\.|[^\s\"'|;&<>\\])*?(?:\"[^\"\n]*?|'[^'\n]*?)?(?:" + SECRET_FILE + ")"
TRUNCATING = r"(?<![<>])>[|&]?(?!>)" + TARGET  # `>`, `>|`, `>&`, `&>`, `N>`; `>>` appends and passes
READING = r"(?<![<])<(?![<>&(])" + TARGET  # `< file` and `$(< file)`; not `<<`, `<<<`, `<>` or `<(`
APPENDING = r"(?<![<>])\d*&?>>" + TARGET  # written to, not read: dropped before the readers below are matched
PRINTERS = (r"\b(?:cat|tac|less|more|head|tail|bat|strings|od|xxd|hexdump|base64|nl|cut|sort|uniq|tee|awk|diff|comm|"
            r"paste|rev|column|jq|yq|fold|fmt|pr|expand|unexpand|iconv|zcat|look)\b")
SEARCHERS = r"(?<![\w-])(?:grep|egrep|fgrep|ugrep|rg|ag|ack)\b"
MOVERS = r"(?<![\w-])(?:rm|unlink|shred|truncate|mv|cp|ln|rsync|dd)\b"
COUNTING = r"(?:^|\s)(?:-\w*[clq]|--(?:count|files-with-matches|quiet|silent)\b)"
# The one search allowed to print: the project URL line, which names the Supabase project and holds no key.
PROJECT_URL = r"^\s*(?:-[a-zA-Z]+\s+)*(['\"]?)\^?(?:NEXT_PUBLIC_)?SUPABASE_URL=?\1\s+\S+\s*$"
IN_PLACE = r"\s(?:-[a-zA-Z]*[iI][a-zA-Z]*|--in-place)\b"
APPEND_HINT = "Append with `>>` (`printf 'NAME=%s\\n' \"$(pbpaste)\" >> .env.local`) or toggle a block with `sed -i`."


def segments(command):
    """The simple commands of a command line: split at ;, |, ||, &&, a lone & and line breaks, outside quotes."""
    parts, current, quote, i = [], [], None, 0
    while i < len(command):
        char = command[i]
        if quote:
            current.append(char)
            if char == "\\" and quote == '"' and i + 1 < len(command):
                current.append(command[i + 1])
                i += 1
            elif char == quote:
                quote = None
        elif char == "\\" and i + 1 < len(command):
            current.append(command[i:i + 2])
            i += 1
        elif char in "'\"":
            quote = char
            current.append(char)
        elif char in ";|\n" or (char == "&" and not "".join(current).endswith((">", "<")) and command[i + 1:i + 2] != ">"):
            parts.append("".join(current))
            current = []
            if char in "|&" and command[i + 1:i + 2] == char:
                i += 1
        else:
            current.append(char)
        i += 1
    parts.append("".join(current))
    return [part.strip() for part in parts if part.strip()]


def check_secrets(command):
    # Redirections on the whole line: the split below would cut `>|` apart.
    if re.search(TRUNCATING, command):
        block("that truncates a secrets file; never overwrite one. " + APPEND_HINT)
    if re.search(READING, command):
        block("that reads a secrets file through `<`, which prints or passes on its values. Check a name with "
              "`grep -c '^NAME=' .env.local`, or the size with `wc -c .env.local`.")
    for segment in segments(command):
        reads = re.sub(APPENDING, " ", segment)
        if not re.search(SECRET_FILE, reads):
            continue
        if re.search(PRINTERS + r"[\s\S]*?(?:" + SECRET_FILE + ")", reads):
            block("that prints a secrets file (.env*, .mcp.json) into the transcript. Check presence with "
                  "`grep -c '^NAME=' .env.local` or `wc -c`; install a value with `printf 'NAME=%s\\n' \"$(pbpaste)\" >> .env.local`.")
        if re.search(r"\bsed\b(?![\s\S]*" + IN_PLACE + r")[\s\S]*?(?:" + SECRET_FILE + ")", reads):
            block("sed without -i prints a secrets file. Use `grep -c` to check a name, or `sed -i` to toggle a block in place.")
        if re.search(MOVERS + r"[\s\S]*?(?:" + SECRET_FILE + ")", reads) or (
            re.search(r"\bfind\b", reads) and re.search(r"\s-delete\b", reads)
        ):
            block("that deletes, moves, copies or overwrites a secrets file. Leave .env* and .mcp.json where they are; "
                  "the owner removes, rotates or copies them.")
        search = re.search(SEARCHERS + r"([\s\S]*)", reads)
        if search and not re.search(COUNTING, search.group(1)) and not re.search(PROJECT_URL, search.group(1)):
            block("searching a secrets file prints matching lines. Use `grep -c`, `grep -l` or `grep -q`; the one line a "
                  "search may print is the project's, `grep '^NEXT_PUBLIC_SUPABASE_URL=' .env.local`.")


def check_processes(command):
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


def check_tooling(command):
    if re.search(r"\bnpx\s+(?:--yes\s+|-y\s+)?expo\b", command):
        block("`npx expo` falls through to the registry and can install a different major when node_modules/.bin is incomplete. Run `./node_modules/.bin/expo` from ugc-mobile, as .claude/launch.json does.")
    if re.search(r"\bEXPO_ATLAS=", command):
        block("EXPO_ATLAS installs expo-atlas into package.json, a runtime-fingerprint input. Measure bundles from `expo export --source-maps` instead.")
    if re.search(r"\beas(?:-cli(?:@[\w.-]+)?)?\s+update\b", command):
        block("OTAs go out only through `node ugc-mobile/scripts/publish-ota.mjs --platform <ios|android|all>` (a dry run until --publish): it checks the fingerprint target, builds in a clean worktree with a private Metro cache and verifies the artifact.")
    if re.search(r"\bnpm\s+run\s+build\b(?!:)|\bnext\s+build\b", command):
        try:
            dev_servers = subprocess.run(["pgrep", "-f", "next dev"], capture_output=True, text=True).stdout.split()
        except FileNotFoundError:  # no procps on this image: nothing to compare against
            dev_servers = []
        if dev_servers:
            block(f"{len(dev_servers)} `next dev` process(es) are running and `next build` shares .next with them. Stop the preview or dev server first, then build.")


raw = sys.stdin.read()
try:
    command = (json.loads(raw).get("tool_input") or {}).get("command") or ""
    if command.strip():
        command = re.sub(r"\\\r?\n", " ", command)  # a continued line is one command
        check_secrets(command)
        check_processes(command)
        check_tooling(command)
except SystemExit:
    raise
except Exception as error:  # a fault in the check itself: refuse what touches a secrets file, let the rest through
    if re.search(r"(?i)\.env|\.mcp\.json", raw):
        block(f"the check failed ({type(error).__name__}: {error}) on a command that names a secrets file, so it is refused. Fix .claude/hooks/guard-bash.py.")
sys.exit(0)
