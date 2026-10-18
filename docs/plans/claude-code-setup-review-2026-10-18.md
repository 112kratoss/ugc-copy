# Claude Code setup review: what Anthropic does, what we do, what to adopt

Status (2026-10-18): P1 shipped in PR #475 (`AGENTS.md` split into a 21 KB core plus eight path-scoped rules, three hooks and a committed `.claude/settings.json`, a compaction section, symlinked mirrors at the top level). P2 shipped in the PR that carries this revision (four repo skills, the design skill split into a core plus references, `npm run test:quiet`). P3 is open; see "What shipped and what is left" at the end.

## Why

The owner asked how Anthropic sets up and uses Claude Code and which of it is worth copying here. Three research passes (official docs and engineering posts; how Anthropic staff and teams work; the current feature set) were read against a measured inventory of this workspace. Every claim links a source in the list at the end; nothing the researchers could not verify from a primary source is used.

## Our setup, measured

- **Instructions.** `AGENTS.md` is 50.5 KB ≈ 12.6k tokens in 214 lines of long paragraphs, loaded into every session. Sections: Conventions and cautions 25.8 KB (18.3 KB of it mobile-only), Web ↔ mobile contract 8.9 KB, everything else 16 KB. The top-level `UGC copy/AGENTS.md` (22 lines, outside git) imports it.
- **Auto memory.** 475 files, 2.2 MB, under `~/.claude/projects/-Users-athuls-UGC-copy/memory/`. `MEMORY.md` indexes 153 of them (19.6 KB ≈ 4.9k tokens, loaded each session; the loader stops at 200 lines / 25 KB). The other 324 are not in the index, but 321 of them are linked from indexed hub files with `[[name]]` and remain recall candidates; only 3 (superseded fingerprint notes) are unreachable. There are no duplicate bodies; 12 `[[links]]` point at files that no longer exist.
- **Skills.** Two (`add-generation-model`, `emil-design-eng`) in `.agents/skills/`, symlinked into `.claude/skills/` at both levels. `emil-design-eng/SKILL.md` is 27 KB and loads whole when invoked.
- **Absent.** A committed `.claude/settings.json` (only a gitignored `settings.local.json` with a personal allowlist), hooks, `.claude/rules/`, `.claude/agents/`, a Claude GitHub Action. Formatting is eslint only; no prettier.
- **Session shape.** Desktop-app sessions are rooted at `UGC copy` (not a git repo; `ugc-app/` is the repo root); worktree sessions are rooted inside `ugc-app/.claude/worktrees/`. Permission mode: bypass. Output style: Concise. Ten official plugins at user level.
- **Baseline.** ≈ 17.5k tokens of project text per session before any work, loaded whether the session touches mobile, web or docs.

## What Anthropic does (the parts that matter here)

Source keys are expanded in the Sources section.

**Instructions**
- Keep each instruction file under ~200 lines of what Claude cannot infer from the code; "Bloated CLAUDE.md files cause Claude to ignore your actual instructions!" Prune on a trigger (same mistake twice, a review catch) and audit with `/doctor prompt-audit`. (BP, MEM)
- Part-of-tree knowledge goes in `.claude/rules/*.md` with `paths:` frontmatter, loaded only when Claude works on matching files; unscoped rules load at launch like the main file. (MEM)
- The instruction file is "context, not enforced configuration": a rule that must hold every time is a hook. A `PreToolUse` deny holds even under `--dangerously-skip-permissions`. (MEM, HK)
- `AGENTS.md` is read natively since v2.1.277 when no `CLAUDE.md` sits at or above the cwd (this Mac runs 2.1.302). Nothing under `.agents/` is read, so our skill symlinks stay necessary. (MEM, C)
- The Claude Code team edits its one committed instruction file a few times a week; every correction becomes a line so the mistake is not repeated. (BC1, PU)

**Context and cost**
- `/clear` between unrelated tasks; `/compact <focus>`; a `# Compact instructions` section steers what survives compaction. (BP, MEM)
- Delegate exploration, test runs and log reading so only summaries return; a `PreToolUse` hook that trims test-runner output cuts "tens of thousands of tokens to hundreds". (CW, COST)
- Prefer CLIs to MCP servers, disable unused servers, inspect `/context`. (COST, BP)
- Skills: description under 1,536 characters, body under 500 lines, `disable-model-invocation: true` for side-effecting workflows, bundled scripts for "deterministic reliability that only code can provide". Every line of a loaded skill "is a recurring token cost". (SK, AS)
- Auto memory: review with `/memory`; the index loads its first 200 lines / 25 KB. (MEM)

**Workflow**
- Plan mode for multi-file or unfamiliar work, not for one-sentence diffs; a second session critiques the plan; re-plan when a session derails. (BP, BC2)
- Verification is the most-cited lever: give Claude a check it can run itself (tests, browser, simulator) and demand evidence. "If you can't verify it, don't ship it." (BP, PU)
- Review in a fresh context: `/code-review`, or a reviewer told to report gaps, not style. Code Review runs on every Anthropic team's PRs. (BP, CWC)
- Repeated workflows become committed skills, with inline shell gathering state so fewer model turns; `/commit-push-pr` runs dozens of times a day. (BC1)
- Three to five parallel sessions, one per worktree. (BC2, CW)
- Internal survey, Dec 2025: delegate the self-contained, easy-to-verify, boring work; keep design, taste and sub-ten-minute tasks. (RS)

**Safety and sharing**
- Commit `.claude/settings.json` (hooks, permissions), skills, agents and rules; personal bits go in `settings.local.json`. (BP, HK)
- No `--dangerously-skip-permissions` day to day: an allowlist plus sandbox, and in 2026 auto mode, the default since v2.1.283; the Claude Code lead moved to it by June 2026. Checkpoints and `/rewind` track only Claude's edit tools. (BC1, BP, HB)

## Gap analysis

| Practice | Anthropic | Here | Verdict |
|---|---|---|---|
| Instruction file size | ≤ ~200 short lines | 12.6k tokens, 214 paragraph-lines | adopt: split |
| Path-scoped rules | `.claude/rules` with `paths:` | none; 18 KB of mobile text loads in every web session | adopt |
| Hooks for must-hold rules | PreToolUse deny, PostToolUse format | none; rules live as prose and memory | adopt |
| Committed settings | `.claude/settings.json` | only a personal local file | adopt |
| Memory hygiene | ≤ 200 lines / 25 KB, reviewed | 153 lines / 19.6 KB, hub-linked, 3 unreachable files | aligned; index at 78% of its cap |
| Repeated workflows as skills | skills with scripts | recipes live in one user's memory | adopt for three or four |
| Verification loop | self-run checks, evidence | strong: device recordings, E2E, Auto-fix CI | aligned |
| Plan first, re-plan | plan mode, second critique | plan mode in use | aligned |
| Parallel sessions, worktrees | 3–5 | yes (desktop sessions, worktrees) | aligned |
| Fresh-context review | `/code-review`, CI review | manual; no CI review | optional |
| Subagents for context hygiene | exploration, tests, review | owner rule: none unless asked | optional, narrow |
| Permission mode | allowlist + sandbox, or auto | bypass | owner's call |
| CLIs over MCP | fewer servers | six servers, deferred-loaded in the desktop app | low |

## Proposals, ranked

### P1: cheap, large effect (one PR, about half a day)

1. **Split `AGENTS.md` into a lean core plus path-scoped rules.** The core (about 18–20 KB ≈ 5k tokens) keeps: what this is, commands, local environment, architecture, cross-cutting conventions (reproduce first, deploys, secrets, metric queries, the paywall, path aliases, Blob uploads, blog), the docs index, and one line per rules file saying when it applies. The rest moves, unreworded, to `.claude/rules/` with `paths:`:
   - `mobile-runtime.md` (`ugc-mobile/**`): runtime gotchas, player touches, the dev-launcher load, the fullscreen activity, Modal blur, keyboard insets, the theme hook, HIG, native-API-first, bundle shaping, React Compiler, the waiting clip.
   - `mobile-release.md` (`ugc-mobile/**`, `.github/workflows/mobile-store-release.yml`): store builds, OTA fingerprints and the publish script, the R8 shape, EAS limits. The one-line fact that merging to `main` never reaches phones stays in the core.
   - `web-mobile-contract.md` (`contracts/**`, `src/proxy.ts`, `src/app/api/**`, `src/lib/route-identity-policy.ts`, `ugc-mobile/lib/notifications.ts`, `ugc-mobile/lib/model-catalog/**`): the contract files and shared modules, deep links, bearer admission and the guest lists.
   - `supabase-migrations.md` (`supabase/**`): stamping, the ledger, grants, pgTAP.
   - `web-css.md` (`src/app/**`, `src/components/**`, `src/**/*.css`): the two-sheet split; rewrites defeat interception.
   - `admin-console.md` (`src/app/admin/**`, `src/lib/admin-*`).
   - `e2e.md` (`tests/e2e/**`, `playwright.config.ts`): the three E2E gotchas.

   `model-onboarding-runbook.test.ts` is the only test that reads `AGENTS.md`; it needs the core to keep naming `docs/model-onboarding.md`. Follow the split with `/doctor prompt-audit` from a terminal `claude` to catch stale or conflicting lines.

   Verify first: path-scoped rules trigger on the paths the Read, Edit and Write tools touch. Under bypass mode the harness steers Claude to Bash `cat` and `sed` instead, which may never trigger them. The core's one-line pointers cover that case, and `/context` after touching a mobile file shows whether the rule loaded.

2. **Hooks for the rules we keep re-learning**, in a committed `.claude/settings.json` with scripts under `.claude/hooks/`. Each block message names the right alternative, so a blocked step corrects itself. These hold in bypass mode too.
   - `PreToolUse` on Edit and Write: block an edit to a migration file that already exists on `origin/main` (never edit an applied migration); block a migration stamp ahead of the UTC clock.
   - `PreToolUse` on Bash: block `cat`, `echo`, `head` and the like on `.env*` and `.mcp.json` (the `grep -c '^NAME='` form stays allowed); `ps aux` and `pgrep -fl` (process listings leak secrets); `npx expo` (the pinned local CLI instead); `EXPO_ATLAS=1`; `eas update` outside `publish-ota.mjs`; `npm run build` while `next dev` listens on :3000.
   - `permissions.deny` for `Read` of `.env*` and `.mcp.json`: deny rules apply before workspace trust and are the preferred hard stop.

3. **Memory: measured, not pruned.** The first measurement called 324 files orphans; a link scan shows 321 of them are reachable from hub files and serve recall, so nothing was deleted. The repo-truth rules that lived only in memory (process listings leak secrets, `npx expo`, `EXPO_ATLAS`, the Metro cache and the OTA publish script, `.env.local` handling, applied migrations) are now enforced by the hooks and stated in the rules files. Left for a later pass: the 12 dangling links, the 3 superseded fingerprint notes, and the index at 78% of its cap.

4. **A `# Compact instructions` section** in the core: keep the current branch and PR, which Supabase `.env.local` points at, the devices in use, and the paths of verification evidence. Verify once that the section is honoured from `AGENTS.md` as it is from `CLAUDE.md`.

### P2: moderate effort, clear value

5. **Three or four recipes become repo skills**, versioned and runnable by any session: `ship-ota` (dry run → publish → verify → the `releases/ota/<sha>` record; `disable-model-invocation: true`), `local-checks` (the CI-equivalent gate: test with `--reporter=dot`, lint, the three typechecks, mobile test and typecheck), `android-device` (emulator or S24 with the lock-file and screen-on checks), `ios-dev-client` (cold start on both simulators). Bundled scripts wherever the steps are deterministic.
6. **Trim `emil-design-eng`.** 27 KB loads whole and stays for the session. Keep `SKILL.md` under 500 lines and move the long reference material into files it points at; `/skill-doctor` reports the cost.
7. **Quieter test output.** vitest 4 supports `--silent=passed-only`; a `test:quiet` script, or the Bash hook from item 2 appending it, keeps a 1,059-file run to its failures.

### P3: the owner's decisions

8. **Session root.** Most mechanisms key off the session's root folder. Sessions rooted at `UGC copy` (not a git repo) do not see `ugc-app/.claude/settings.json`, hooks or rules without symlinks or copies at the top level, which is what already happened with skills. Options: root sessions at `ugc-app` and add `UGC copy` as an extra directory for `archive/`, `releases/` and `store-assets/`; or mirror `rules/`, `hooks/` and `settings.json` by symlink at the top level. Also verify with `/context` whether a session rooted in `ugc-app` or a worktree loads `ugc-app/AGENTS.md` twice: natively, and again through the top-level file's `@ugc-app/AGENTS.md` import.
9. **Permission mode.** Anthropic staff do not run bypass day to day; auto mode is the default and the Claude Code lead uses it. Two concrete costs of bypass here: the harness pushes edits through Bash, which `/rewind` cannot undo and path-scoped rules do not see. A week on auto mode with `/fewer-permission-prompts` would show whether device tooling (adb, simctl, eas) prompts too often.
10. **Fresh-context review.** `/code-review` before each merge costs tokens but no infrastructure. The GitHub Action (`anthropics/claude-code-action@v1` with the code-review plugin and `--comment`) reviews every PR for the price of API usage or a Max OAuth token stored as a repository secret; the repo is public, so Actions minutes are free. Installing it needs `/install-github-app` by the owner and the clipboard flow for the secret.
11. **A narrow subagent exception.** The standing rule is no subagents. Anthropic's strongest case for them is context hygiene: a Bash-only `test-runner` agent on a cheap model that returns failures only, and a reviewer with uncorrelated context. Today's research used three agents for about 685k tokens while this session stayed lean; the trade is real in both directions. Proposed only as an explicit, named exception if wanted.

## Not proposing

- Agent teams: experimental, about 7× the tokens, and coding has few truly parallel tasks.
- More MCP servers: the current six are deferred-loaded in the desktop app, so their cost is small, and Supabase MCP is the only route to production from this Mac.
- A `CLAUDE.md`: native `AGENTS.md` reading makes it unnecessary, and one at or above the cwd would shadow `AGENTS.md`.
- Removing plugins: run `/skill-doctor` first.

## Expected effect

- Per-session baseline for a web or docs session: ≈ 17.5k → ≈ 10.2k tokens of project text (measured: the core is 21.2 KB; mobile sessions load the mobile rules on demand), with fewer instructions ignored for being buried.
- Rules that were re-learned from memory become blocks with a hint.
- Recipes that live in one user's memory become repo skills every session can run.

## Claude Code in the cloud (claude.dev, 2026-10-06)

The owner pointed at Addy Osmani's "Claude Code in the cloud" guide. It is not an Anthropic docs page (the site links to code.claude.com and claude.ai but names no publisher), so it is read as a well-informed guide. What it adds for this repo:

- **Cloud sessions are within reach.** Pro, Max and Team plans run them at no separate compute charge against the same usage limits; a public repository needs only the GitHub sign-in; each session has its own VM (about 4 vCPUs, 16 GB, 30 GB), branch and ports, and ends on a branch. Idle VMs are reclaimed, so commit as you go.
- **Repository setup that travels:** the repo's instruction file, rules, skills, agents, commands and `.mcp.json` travel; `~/.claude` (memory, personal settings) does not. Installs belong in a `SessionStart` hook that checks `CLAUDE_CODE_REMOTE`, which is now `.claude/hooks/cloud-setup.sh` (an `npm ci` in both workspaces, a no-op locally). Foreground commands time out at 2 minutes by default, raised with `BASH_DEFAULT_TIMEOUT_MS` in the environment's variables.
- **Habits:** one task per session; push before starting; name the proof in the prompt ("prove it by running the suite 30 times"); ask for a rebase when the base branch moves, since conflicts are not pushed to the session; set network to None for untrusted code.
- **Routines (research preview):** a saved prompt plus repos and environment, run on a schedule, an HTTP call or a GitHub event, pushing to `claude/`-prefixed branches. A candidate here is a weekly `/doctor prompt-audit` of `AGENTS.md` and the rules, or the feed scorecard read; both are P3 decisions.
- **Not usable here:** memory consolidation (memory is local), device verification (simulators and phones stay on the Mac), and anything that needs the production Supabase MCP token, which must not go into an environment's variables because they are visible to everyone who uses that environment.

## What shipped and what is left

Shipped in this PR (P1 plus the one cloud item):

- `AGENTS.md` 50.5 KB → 21.2 KB. Eight rules under `.claude/rules/` with `paths:` (`**/` prefixed so they match from the repo root, a worktree and the parent folder): `mobile-ui`, `mobile-runtime`, `mobile-release`, `web-mobile-contract`, `supabase-migrations`, `web-routes-and-css`, `admin-console`, `e2e`. Every long paragraph of the original is present exactly once across the core and the rules (checked by script); `model-onboarding-runbook.test.ts` passes.
- `.claude/settings.json` (committed): `permissions.deny` for Read, Edit and Write of `.env*` and `.mcp.json`; `PreToolUse` hooks `protect-migrations.py` (an edit to a migration already on `origin/main`, a stamp ahead of UTC) and `guard-bash.py` (secrets files printed, process listings, `pgrep -fl`, `npx expo`, `EXPO_ATLAS`, `eas update` outside the publish script, a build beside a running `next dev`); `SessionStart` `cloud-setup.sh`. The guard was run against 32 commands (14 allowed, 18 blocked) and the migration hook against 4 paths, all as intended.
- `# Compact instructions` and a rules index in the core.
- Top-level mirrors: `UGC copy/.claude/{rules,hooks,settings.json}` symlink into the repo, as the skills already did.

Shipped in the second PR (P2):

- Four repo skills under `.agents/skills/`, symlinked into `.claude/skills/` at the repo and at the parent folder, each with a description under 500 characters and a body under 60 lines, with the long steps in bundled scripts: `ship-ota` (`disable-model-invocation: true`; the publish script's flags, the dry-run reading, the served-manifest checker `verify_served_ipv4.py`, the on-phone check, the record's shape, the rollback form), `local-checks` (`scripts/run.sh`: the Quality workflow's laptop-runnable steps in CI's order, one verdict line per step, failing output only, `--build`, `--e2e`, `--ci-like`), `android-device` (`emulator.sh` for the lock, boot, launch, screenshot and restart history; `phone.sh`, `keep-awake.sh` and `ui_find.py` for the S24, with the phone's serial taken from `ANDROID_SERIAL` and never written down), `ios-dev-client` (`sim.sh` for which app is the dev client, boot, the single launch, screenshots, appearance). The recipes came from the memory notes of September and October 2026; the memory files stay as the history behind them.
- `emil-design-eng/SKILL.md` went from 679 lines (27 KB) to 93 lines: the initial response, the philosophy, the required review format and the checklist stay, and the eight topic blocks moved unchanged into `reference/*.md`, indexed by a table that says which file to read for which topic. Every content line of the original is present exactly once across the core and the references (checked by script).
- `npm run test:quiet` (`vitest run --reporter=dot --silent=passed-only`) and its line in the Commands section.
- The live rule-loading check is done: in a session rooted at `UGC copy`, a Read of `ugc-mobile/lib/notifications.ts` loaded `mobile-ui`, `mobile-runtime`, `mobile-release` and `web-mobile-contract` through the symlinked rules directory, about 7k tokens of mobile material, as designed.

Still to verify in a live session: whether a session rooted in `ugc-app` or a worktree loads `ugc-app/AGENTS.md` twice through the top-level import (`/context` shows it), and `/doctor prompt-audit` on the core and the rules.

Open: the P3 decisions (session root, permission mode, CI review, a subagent exception, Routines). The session-root question matters less now that rules, hooks, settings and skills are mirrored at the top level.

## Sources

- BP: Claude Code best practices, https://code.claude.com/docs/en/best-practices (the April 2025 engineering post now redirects here)
- MEM: Memory, https://code.claude.com/docs/en/memory
- CW: Common workflows, https://code.claude.com/docs/en/common-workflows
- COST: Manage costs, https://code.claude.com/docs/en/costs
- SK: Skills, https://code.claude.com/docs/en/skills
- HK: Hooks guide, https://code.claude.com/docs/en/hooks-guide; reference https://code.claude.com/docs/en/hooks
- Sub-agents https://code.claude.com/docs/en/sub-agents; settings https://code.claude.com/docs/en/settings; GitHub Action https://code.claude.com/docs/en/github-actions; headless https://code.claude.com/docs/en/headless
- CE: Effective context engineering for AI agents (2025-09-29), https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- AS: Equipping agents for the real world with Agent Skills (2025-10-16), https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- HB: How we built Claude Code auto mode (2026-03-25), https://www.anthropic.com/engineering/claude-code-auto-mode
- TM: How Anthropic teams use Claude Code (2025-07-24), https://www.claude.com/blog/how-anthropic-teams-use-claude-code
- BC1: Boris Cherny, how I use Claude Code (2026-01-02), https://x.com/bcherny/status/2007179832300581177
- BC2: Boris Cherny, tips from the Claude Code team (2026-01-31), https://x.com/bcherny/status/2017742741636321619
- PU: Claude Code power user tips (support article, updated 2026-10), https://support.claude.com/en/articles/14554000-claude-code-power-user-tips
- EV: Every, "How to use Claude Code like the people who built it" with Cat Wu and Boris Cherny (2025-10-29), https://every.to/podcast/transcript-how-to-use-claude-code-like-the-people-who-built-it
- RS: How AI is transforming work at Anthropic (2025-12-02), https://www.anthropic.com/research/how-ai-is-transforming-work-at-anthropic
- CWC: Code w/ Claude 2026 live notes (2026-05-06), https://simonwillison.net/2026/May/6/code-w-claude-2026/
- C: Claude Code changelog and release notes, https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
- CD: Addy Osmani, Claude Code in the cloud (2026-10-06, claude.dev, not an Anthropic docs page), https://claude.dev/blog/claude-code-in-the-cloud/
