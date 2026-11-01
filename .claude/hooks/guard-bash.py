#!/usr/bin/env python3
"""PreToolUse hook for Bash and Monitor: refuse commands that break the repo's standing rules, naming the right form.

Each rule here is one AGENTS.md or memory rule that was re-learned the hard way. Exit 2 blocks the command and the
stderr message reaches Claude; anything not matched passes untouched.

Since 2026-11-01 this hook, protect-migrations.py and guard-prompt.py are the only guard on secrets files (.env*,
.mcp.json): deny rules also refused the `grep -c` check and the `>>` install that AGENTS.md prescribes. A command is
judged by its command word and its arguments as the shell reads them, quotes resolved, so text that only names a
secrets file (a commit message, a PR title, a search for the name) passes. settings.json leaves this hook fail-open
when python3 cannot start, so a session can still repair things through Bash, but a command that names a secrets
file is refused when the check itself errors.
"""
import json
import os
import re
import shlex
import subprocess
import sys


def block(message):
    sys.stderr.write("Blocked by .claude/hooks/guard-bash.py: " + message + "\n")
    sys.exit(2)


# A secrets file: .env, .env.local, .env.production and the like (not .env.example) and .mcp.json, in any case (a
# macOS volume ignores it).
SECRET_NAME = re.compile(r"\.env(?!\.example$)(?:\.[\w.-]+)?|\.mcp\.json", re.IGNORECASE)
# The same inside a longer text (a find pattern, a line shlex cannot read), starting a word or a path component, so
# `process.env.KEY`, `next-env.d.ts` and a regex's `\.env` are not one.
SECRET_TEXT = r"(?<![\w$.\\-])(?i:\.env(?!\.example\b)(?:\.[\w.-]+)?\b|\.mcp\.json\b)"
PRINTERS = {"cat", "tac", "less", "more", "head", "tail", "bat", "batcat", "strings", "od", "xxd", "hexdump", "base64",
            "nl", "cut", "sort", "uniq", "tee", "awk", "gawk", "mawk", "diff", "comm", "paste", "rev", "column", "jq",
            "yq", "fold", "fmt", "pr", "expand", "unexpand", "iconv", "zcat", "look", "vis", "view"}
SEARCHERS = {"grep", "egrep", "fgrep", "ugrep", "rg", "ag", "ack"}
MOVERS = {"rm", "unlink", "shred", "truncate", "mv", "cp", "ln", "rsync", "dd", "install"}
WRAPPERS = {"sudo", "doas", "xargs", "exec", "time", "nice", "nohup", "command", "builtin", "env"}
SHELL_SYNTAX = {"(", ")", "{", "}", "!", "if", "then", "elif", "else", "do", "while", "until"}
SHELLS = {"bash", "sh", "zsh", "dash", "ksh"}
TRUNCATE_OPS = {">", ">|", "&>", ">&", "&>|"}
APPEND_OPS = {">>", "&>>"}
# Search flags that take the next word as their value when they end a cluster (grep, rg, ugrep, ag and ack share most).
SHORT_WITH_VALUE = set("efABCmdDgtTrjM")
LONG_WITH_VALUE = {"--regexp", "--file", "--after-context", "--before-context", "--context", "--max-count", "--glob",
                   "--iglob", "--type", "--type-not", "--replace", "--threads", "--max-columns", "--devices",
                   "--directories", "--encoding", "--label"}
HEREDOC = re.compile(r"(?<!<)<<(-?)\s*(['\"]?)([A-Za-z_][\w.-]*)\2")
# For a line shlex cannot read: a redirection's target naming a secrets file, quoted, escaped or bare.
TARGET = r"\s*(?:\"[^\"\n]*\"|'[^'\n]*'|\\.|[^\s\"'|;&<>\\])*?(?:\"[^\"\n]*?|'[^'\n]*?)?(?:" + SECRET_TEXT + ")"
TRUNCATING = r"(?<![<>])>[|&]?(?!>)" + TARGET
READING = r"(?<![<])<(?![<>&(])" + TARGET

APPEND_HINT = "Append with `>>` (`printf 'NAME=%s\\n' \"$(pbpaste)\" >> .env.local`) or toggle a block with `sed -i`."
TRUNCATE_MESSAGE = "that truncates a secrets file; never overwrite one. " + APPEND_HINT
READ_MESSAGE = ("that reads a secrets file through `<`, which prints or passes on its values. Check a name with "
                "`grep -c '^NAME=' .env.local`, or the size with `wc -c .env.local`.")
PRINT_MESSAGE = ("that prints a secrets file (.env*, .mcp.json) into the transcript. Check presence with "
                 "`grep -c '^NAME=' .env.local` or `wc -c`; install a value with `printf 'NAME=%s\\n' \"$(pbpaste)\" >> .env.local`.")
SED_MESSAGE = "sed without -i prints a secrets file. Use `grep -c` to check a name, or `sed -i` to toggle a block in place."
MOVE_MESSAGE = ("that deletes, moves, copies or overwrites a secrets file. Leave .env* and .mcp.json where they are; the "
                "owner removes, rotates or copies them (a worktree loads the primary checkout's env into the process instead).")
SEARCH_MESSAGE = ("searching a secrets file prints matching lines. Use `grep -c`, `grep -l` or `grep -q`; the one line a "
                  "search may print is the project's, `grep '^NEXT_PUBLIC_SUPABASE_URL=' .env.local`.")
FIND_MESSAGE = "that finds a secrets file to print, run or delete. Check a name with `grep -c '^NAME=' .env.local`."


def names_secret(word):
    """Whether a shell word names a secrets file, by its last path part or after `=` (dd's of=, --env-file=)."""
    return any(SECRET_NAME.fullmatch(os.path.basename(part.rstrip("/"))) for part in (word, word.split("=", 1)[-1]))


def executable_lines(command):
    """The command's lines without the bodies of complete here-documents that feed anything but a shell: a commit
    message or a file written through `cat <<EOF` is data, while `bash <<EOF` runs its body."""
    lines, skipped, i = command.split("\n"), set(), 0
    while i < len(lines):
        for match in HEREDOC.finditer(lines[i]):
            feeds_shell = re.search(r"(?:^|[;&|(`]|\$\()\s*(?:sudo\s+)?(?:" + "|".join(SHELLS) + r")\b",
                                    lines[i][:match.start()])
            end = next((j for j in range(i + 1, len(lines))
                        if (lines[j].lstrip("\t") if match.group(1) else lines[j]) == match.group(3)), None)
            if end is not None:
                if not feeds_shell:
                    skipped.update(range(i + 1, end + 1))
                i = end
                break
        i += 1
    return "\n".join(line for number, line in enumerate(lines) if number not in skipped)


def segments(command):
    """The simple commands of a command line: split at ;, |, ||, &&, a lone & outside quotes, and at every line break.

    A line break always ends one, even inside a quote: prose is full of apostrophes, and an unbalanced one would
    otherwise run every later line into one command. `>|`, `2>&1` and `&>` are redirections, not separators."""
    parts, current, quote, i = [], [], None, 0
    while i < len(command):
        char = command[i]
        text = "".join(current)
        if char == "\n":
            parts.append(text)
            current, quote = [], None
        elif quote:
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
        elif (char == ";" or (char == "|" and not text.endswith(">"))
              or (char == "&" and not text.endswith((">", "<")) and command[i + 1:i + 2] != ">")):
            parts.append(text)
            current = []
            if char in "|&" and command[i + 1:i + 2] == char:
                i += 1
        else:
            current.append(char)
        i += 1
    parts.append("".join(current))
    return [part.strip() for part in parts if part.strip()]


def substitutions(text):
    """The bodies of $(…), <(…), >(…) and `…` in a command (one left open runs to the end)."""
    bodies, i = [], 0
    while i < len(text):
        if text[i] == "`":
            end = text.find("`", i + 1)
            bodies.append(text[i + 1:] if end == -1 else text[i + 1:end])
            i = len(text) if end == -1 else end + 1
        elif text[i] in "$<>" and text[i + 1:i + 2] == "(" and text[i + 2:i + 3] != "(":
            depth, j = 1, i + 2
            while j < len(text) and depth:
                depth += {"(": 1, ")": -1}.get(text[j], 0)
                j += 1
            bodies.append(text[i + 2:j - 1] if depth == 0 else text[i + 2:])
            i = j
        else:
            i += 1
    return bodies


def shell_words(text):
    lexer = shlex.shlex(text, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    lexer.commenters = ""
    return list(lexer)


def command_start(args):
    """The index of the command word, past VAR=value assignments, wrappers such as sudo or xargs, and shell keywords."""
    i = 0
    while i < len(args):
        if re.fullmatch(r"[A-Za-z_]\w*=.*", args[i], re.S) or args[i] in SHELL_SYNTAX:
            i += 1
        elif os.path.basename(args[i]) in WRAPPERS:
            i += 1
            while i < len(args) and args[i].startswith("-"):
                i += 1
        else:
            return i
    return None


def search_prints(args):
    """Whether a grep-like search prints lines of a secrets file it searches. Not when it only counts, lists or tests,
    nor for the one line allowed, the project URL. A secrets name that is the pattern, with files after it, is text
    being looked for; with nothing after it, it is the file, whatever came before."""
    letters, longs, pattern_given, positionals, i = set(), set(), False, [], 0
    while i < len(args):
        arg = args[i]
        if arg == "--":
            positionals += args[i + 1:]
            break
        if arg.startswith("--"):
            name = arg.split("=", 1)[0]
            longs.add(name)
            pattern_given |= name in ("--regexp", "--file")
            i += 2 if ("=" not in arg and name in LONG_WITH_VALUE) else 1
        elif arg.startswith("-") and len(arg) > 1:
            step = 1
            for position, letter in enumerate(arg[1:]):
                letters.add(letter)
                if letter in SHORT_WITH_VALUE:
                    pattern_given |= letter in "ef"
                    step = 2 if position == len(arg) - 2 else 1
                    break
            i += step
        else:
            positionals.append(arg)
            i += 1
    pattern = None if pattern_given or not positionals else positionals[0]
    files = positionals if pattern is None else positionals[1:] or [pattern]
    if not any(names_secret(file) for file in files):
        return False
    if letters & set("clq") or longs & {"--count", "--files-with-matches", "--files-without-match", "--quiet", "--silent"}:
        return False
    inverted = "v" in letters or "--invert-match" in longs
    return not (pattern is not None and not inverted and re.fullmatch(r"\^?(?:NEXT_PUBLIC_)?SUPABASE_URL=?", pattern))


def check_words(words, depth):
    args, i = [], 0
    while i < len(words):
        word, following = words[i], (words[i + 1] if i + 1 < len(words) else None)
        if re.fullmatch(r"\d+", word) and following in TRUNCATE_OPS | APPEND_OPS | {"<"}:
            i += 1  # the file descriptor of the redirection that follows
        elif word in TRUNCATE_OPS and following is not None:
            if names_secret(following):
                block(TRUNCATE_MESSAGE)
            i += 2
        elif word == "<" and following is not None:
            if names_secret(following):
                block(READ_MESSAGE)
            i += 2
        elif word in APPEND_OPS | {"<<", "<<-", "<<<"} and following is not None:
            i += 2  # an append target is written to, not read; a here-document's delimiter or a here-string's word
        else:
            args.append(word)
            i += 1
    start = command_start(args)
    if start is None:
        return
    name, rest = os.path.basename(args[start]).lower(), args[start + 1:]
    if name in SHELLS and "-c" in rest and rest.index("-c") + 1 < len(rest):
        check_command(rest[rest.index("-c") + 1], depth + 1)  # sh -c '…' runs its script
    elif name == "eval":
        check_command(" ".join(rest), depth + 1)
    elif name == "find":
        if any(re.search(SECRET_TEXT, arg) for arg in rest) and any(
                arg in ("-delete", "-exec", "-execdir", "-ok", "-okdir") for arg in rest):
            block(FIND_MESSAGE)
    elif any(names_secret(arg) for arg in rest):
        if name in PRINTERS:
            block(PRINT_MESSAGE)
        if name == "sed" and not any(re.fullmatch(r"-[a-zA-Z]*[iI]\S*|--in-place(?:=.*)?", arg) for arg in rest):
            block(SED_MESSAGE)
        if name in MOVERS:
            block(MOVE_MESSAGE)
        if name in SEARCHERS and search_prints(rest):
            block(SEARCH_MESSAGE)


def check_unparsed(segment):
    """A line shlex cannot read (an unbalanced quote, usually prose): redirections by pattern, the command by its first
    word."""
    if re.search(TRUNCATING, segment):
        block(TRUNCATE_MESSAGE)
    if re.search(READING, segment):
        block(READ_MESSAGE)
    if not re.search(SECRET_TEXT, segment):
        return
    first = os.path.basename((segment.split() or [""])[0]).lower()
    if first in PRINTERS:
        block(PRINT_MESSAGE)
    if first in MOVERS:
        block(MOVE_MESSAGE)
    if first == "sed" and not re.search(r"\s(?:-[a-zA-Z]*[iI]|--in-place)", segment):
        block(SED_MESSAGE)
    if first in SEARCHERS and not re.search(r"\s(?:-[a-zA-Z]*[clq]|--(?:count|files-with-matches|quiet|silent)\b)", segment):
        block(SEARCH_MESSAGE)


def check_command(command, depth=0):
    if depth > 3:
        return
    for segment in segments(command):
        for body in substitutions(segment):
            check_command(body, depth + 1)
        try:
            words = shell_words(segment)
        except ValueError:
            check_unparsed(segment)
            continue
        check_words(words, depth)


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
        check_command(executable_lines(command))
        check_processes(command)
        check_tooling(command)
except SystemExit:
    raise
except Exception as error:  # a fault in the check itself: refuse what touches a secrets file, let the rest through
    if re.search(r"(?i)\.env|\.mcp\.json", raw):
        block(f"the check failed ({type(error).__name__}: {error}) on a command that names a secrets file, so it is refused. Fix .claude/hooks/guard-bash.py.")
sys.exit(0)
