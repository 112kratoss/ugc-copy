# Section 2 — projection production verification

PR [#221](https://github.com/112kratoss/ugc-copy/pull/221) deployed as
`0b4ab93018f5d139aa28b6df383e093ec5e405a4`.

- Final PR Quality: [36295120583](https://github.com/112kratoss/ugc-copy/actions/runs/36295120583), success. The initial database run exposed an additional missing input-media SELECT grant; the exact failure was reproduced locally before correction.
- Exact-main Quality: [36295762651](https://github.com/112kratoss/ugc-copy/actions/runs/36295762651), success across web, mobile, database and browser jobs.
- Production release: [36296239196](https://github.com/112kratoss/ugc-copy/actions/runs/36296239196), success at 2026-09-27 05:09:58 UTC. Staged health, promotion, live commit and protected health gates passed.
- Independent `/api/app-version` check returned the exact released commit.

The final PR passed 5,998 web tests, 2,615 mobile tests and 1,521 database
assertions across 77 files. Clean local replay completed all 254 migrations.
The focused projection matrix has 52 assertions; the no-ambient-grants
reproduction passed after the migration explicitly restored all four contracts.

At 05:10:35 UTC, `scripts/ops/verify-projection-table-boundaries.mjs` passed
**61 production checks**. This repeats the pre-release 61-check pass and covers
private generation/input/usage ownership, draft-template isolation, excluded
columns, inactive catalog visibility, rejected direct writes, guests, bans and
revoked sessions. Production fixtures were private or inactive. No provider
work, payments, public posts, social actions or stored media files were created.

All three identities and their fixtures were removed. Independent counts were
zero for tagged users, generations, input metadata, usage events, templates,
source tools and source models.

All **16 schema fingerprint categories were identical before and after** the
production migration. In particular, 127 policies retained fingerprint
`8c2a7b6399e92ab2782a81855bc19db8` and 833 table grants retained fingerprint
`250854c22a5524fe70fc9e1ed842629c`. This supports the intended unchanged
production behavior while repairing clean rebuilds. These policy/grant
fingerprints also match local replay. Historical local/production differences
in column order, extensions and function definition text remain separately
documented; this does not claim byte-identical environments.

Post-release advisors: security 63 INFO / 42 WARN; performance 96 INFO;
no ERROR findings. Existing advisory warnings remain in the wider audit.

The current catalog contains 130 public base tables (all RLS-enabled), two
views and 25 client-readable relations. The earlier inventory had 26 before
marketplace content became service-only in PR #218.

This closes the public/private projection batch, not the entire backend.
An additional 40-assertion financial-table matrix passed locally during CI;
its rollback-only fixtures and output are saved in
`.audit-evidence/section2-financial/`. The later financial batch is recorded in
backend-section-02-financial-2026-09-27.md. Callable RPC/trigger paths, Storage,
Realtime and business workflows remain open.
