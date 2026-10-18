#!/bin/sh
# SessionStart hook: in a Claude Code cloud session (CLAUDE_CODE_REMOTE is set) install both workspaces'
# dependencies so tests, lint and typechecks can run. Locally it exits at once. It never fails the session.
[ -n "$CLAUDE_CODE_REMOTE" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
if [ ! -d node_modules ]; then
  npm ci --no-audit --no-fund > /tmp/claude-npm-ci.log 2>&1 || echo "npm ci failed; see /tmp/claude-npm-ci.log" >&2
fi
if [ -d ugc-mobile ] && [ ! -d ugc-mobile/node_modules ]; then
  (cd ugc-mobile && npm ci --no-audit --no-fund > /tmp/claude-npm-ci-mobile.log 2>&1) || echo "ugc-mobile npm ci failed; see /tmp/claude-npm-ci-mobile.log" >&2
fi
exit 0
