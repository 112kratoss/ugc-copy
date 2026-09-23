---
name: add-generation-model
description: Use when adding a generation model (image, video or motion) to Magicbooklet, including a new tier of a model it already runs, or when changing a live model's prices, caps or options. Covers the Kie provider checks, where the model is registered in code, emitting and pinning the catalog release, and the deploy-then-publish rollout, with the points where the owner must approve.
---

# Add a generation model

Read `docs/model-onboarding.md` in full and follow it in order. It is the source of truth. This
skill only adds how an agent runs it.

## Before you start

- Work on a new branch in a git worktree, not in the primary checkout, which other sessions
  share. Copy the gitignored root `.env.local` into the worktree if you will run the id probe or
  the catalog CLI there.
- Pin down the Kie market slug for each model. If the request names a product rather than a
  slug, list the slugs with `node scripts/ops/kie-evidence.mjs slugs`.

## Stop and ask the owner before

- any Kie request that can create a task. Every real run costs credits, and the empty-input id
  probe does too when the spec lists no required fields;
- pushing a branch or opening a PR, because the repository is public;
- `stage --apply`, `publish --apply` or `rollback --apply`;
- a change that needs a mobile store build or OTA update (the runbook's Mobile section says when).

Say what the step does, what it costs and what it changes, then wait for a yes.

## Rules

- Evidence before code: every id, field and price comes from the spec body or the market page and
  is written to `docs/model-api-references/` before it is used.
- Never write or edit a release manifest by hand. Emit it, then pin it with a manifest test.
- Never print `KIE_AI_API_KEY` or the Supabase service-role key; read them inside the command.
- Pin the full price when the market page marks a price as discounted, unless the owner decides
  otherwise.
- Before any catalog command, check which Supabase block is active in `.env.local`. That is the
  database the command reads or changes.

## Before handing off

Run the tests the runbook lists, the new manifest test, `npm run lint`, `npm run typecheck` and
`npm run typecheck:tests`. Then report the evidence file, the files changed, the release file and
its revision, the exact `stage` and `publish` commands with their revision guards, and what is
left for the owner: paid runs, the publish, and phone checks.
