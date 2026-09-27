# Section 2 — saves, audit records and marketplace content

Status: fixes validated locally; release pending. Continues the public table/view audit after PR #216.

## Confirmed findings

1. `post_saves` and `showcase_saves` permitted direct authenticated inserts/deletes. A self-owned save could point at another user's private post/generation, bypassing the API's visibility, moderation and blocking checks. Direct deletion also bypassed the RPC's save-count update. This is an integrity/authorization bypass; it does not establish private-media disclosure through the guarded saved-media API.
2. `post_save_events` and `post_deletion_audits` allowed direct authenticated inserts with fabricated event outcomes, sales counts and earnings snapshots. The user ID check prevented impersonating another owner but did not make the supplied audit facts trustworthy. Forged earnings snapshots do not change wallet balances.
3. The marketplace save service used a user client for tables whose parent grants had already become service-only. A disposable production account reproduced HTTP 500 `Failed to save listing.` when creating a valid draft guide. A grant-aware regression test failed at the same boundary. The fixture was removed.

## Changes

- Four save/audit tables retain owner-scoped SELECT but lose direct client mutation. Existing server save RPCs, event writes, deletion history and account cleanup retain service-role access. The code search found all current web/mobile save writes already routed through these service paths.
- Remove mutation policies and separately granted column privileges as well as relation grants. Explicitly reinstall active-identity policies so fresh Supabase databases match production.
- Marketplace content becomes service-only, consistent with its parent assets/purchases. Existing content reads already pass through server entitlement checks.
- Marketplace creation/editing now uses the service client after the existing profile/post/canvas checks, with explicit seller filters for existing assets. Tests prove foreign or missing listing IDs cannot be used to overwrite content.
- No stored records are rewritten. The migration has a five-second lock timeout and is compatible with the existing save/read API paths. Marketplace creation was already failing before this schema change; the app release restores it.

## Validation

- Six direct-write bypass assertions reproduced before the database fix. The initial 30-assertion suite failed 15 checks, including downstream row/counter effects and ACL assertions.
- Pre-fix production draft-create reproduction: HTTP 500; disposable account removed.
- Focused save, saved-state, marketplace service/adapter tests: 21 passed. Three migration contract tests passed. New marketplace cases cover draft creation, own edits, foreign/missing assets, and foreign linked posts.
- Clean replay of 252 migrations completed. Full database suite passed (75 files; final count recorded with release evidence).
- Live verifier `scripts/ops/verify-social-table-boundaries.mjs` uses two disposable accounts, a private post, an inert generation and a draft guide. It checks owner/foreign/revoked reads, denies direct writes, verifies the private-post API rejection, creates/edits a draft via the real marketplace API and rejects a foreign edit. Cleanup targets only its fixtures. Pending deployment before execution.

The previous workflow batch's production evidence is in `backend-section-02-workflow-release-2026-09-27.md`. Remaining Section 2 items include notification/preferences/push-token behavior, public table projections, and the separate RPC/Storage/Realtime batches. This report does not certify those surfaces.
