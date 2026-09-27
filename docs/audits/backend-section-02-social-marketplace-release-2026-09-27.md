# Section 2 — save/audit/marketplace production verification

PR [#218](https://github.com/112kratoss/ugc-copy/pull/218) deployed as
`18e8fc1e7c802378e0d75925d14117986cdfd613`.

- Final PR Quality: [36290407154](https://github.com/112kratoss/ugc-copy/actions/runs/36290407154), success.
- Exact-main Quality: [36290792323](https://github.com/112kratoss/ugc-copy/actions/runs/36290792323), success.
- Production release: [36291244817](https://github.com/112kratoss/ugc-copy/actions/runs/36291244817), success at 2026-09-27 03:26:07 UTC. Migration, staged public/authenticated health, promotion, live SHA and protected health gates passed.
- Independent `/api/app-version` check returned the exact deployed SHA.
- Clean database replay: 252 migrations, 75 test files, 1,429 assertions passed.

At 03:27:15 UTC, `scripts/ops/verify-social-table-boundaries.mjs` passed all
**29 live checks** using two disposable registered identities:

- Four save/audit tables: forged inserts and direct deletes rejected; owner reads work and foreign reads return no rows.
- The real save API rejects a private foreign post (404).
- Marketplace draft creation and owner editing succeed (200); foreign editing is rejected (404), leaving the owner's content intact.
- Both identities are denied direct marketplace content reads and mutations.
- Revoking the owner session removes read access to all four save/audit tables.

Both identities and their private post, inert generation and draft listing were
removed. Independent SQL counts returned **zero** remaining fixture users,
generations, posts and listings. No provider jobs, payments, public content or
existing-account changes were used.

Post-release advisors: no ERROR findings. Security retained 63 INFO findings
and 42 WARN findings (including the six authenticated definer functions awaiting
the RPC audit). Performance retained 97 INFO findings. These are not a clean
bill of health for the remaining backend surfaces.

This closes only the save/audit/marketplace batch. Notification, preference and
push-token behavior, public projections, RPCs, Storage and Realtime remain
separate coverage items in `backend-section-02-tables-2026-09-27.md`.
