# Section 2 — notification production verification

PR [#219](https://github.com/112kratoss/ugc-copy/pull/219) deployed as
`711d2a2fcfa5a0fd5535495912401f216c1adcc7`.

- PR Quality: [36292749778](https://github.com/112kratoss/ugc-copy/actions/runs/36292749778), success.
- Exact-main Quality: [36293272327](https://github.com/112kratoss/ugc-copy/actions/runs/36293272327), success: 5,992 web tests, 2,602 mobile tests, 1,469 database assertions across 76 files, browser smoke tests, lint, type checks and production build.
- Production release: [36293756589](https://github.com/112kratoss/ugc-copy/actions/runs/36293756589), success at 2026-09-27 04:18:22 UTC. Migration, staged health, promotion, exact live SHA and protected health checks passed.
- Independent `/api/app-version` read confirmed the deployed SHA.

At 04:29:40 UTC, `scripts/ops/verify-notification-table-boundaries.mjs` passed
all **36 live checks** using two disposable registered accounts and one real
anonymous account. Registered users can read their own rows and use the
preferences, inbox, mark-read, mark-all-read, token registration and unregister
APIs. Cross-account reads and updates are denied. Guests cannot read or mutate
their historical fixture rows, insert tokens, or upsert preferences; the API
also rejects them. Notification content cannot be forged. Revoked sessions
lose access to all three tables.

Fixture preferences disabled push delivery. Seed tokens were inactive; the
registration API used a random non-device token that was immediately
unregistered. Inbox rows were seeded directly without creating delivery jobs.
No physical push notification, payment or provider job was initiated.

All three identities and dependent fixtures were removed. Independent SQL
counts confirmed **zero** remaining tagged users, audit tokens and fixture
notifications. User deletion cascades their preferences.

Production and clean local replay agree on all 127 policies
(`8c2a7b6399e92ab2782a81855bc19db8`) and 833 table grants
(`250854c22a5524fe70fc9e1ed842629c`), as well as columns, constraints, routine
grants, indexes, tables, triggers and views. Previously recorded differences
remain in column order, installed extensions and function definition text;
this is not a claim of byte-identical schemas.

Post-migration advisors reported no ERROR findings: security retained 63 INFO
and 42 WARN findings, and performance retained 97 INFO findings. The existing
warnings remain part of the broader audit.

This closes the notification **table-ownership** batch. Physical device push
delivery, provider retries, public projection review, RPCs, Storage, Realtime
and the rest of the backend remain separate coverage items. An exploratory
21-assertion local matrix for the next projection group passed; its evidence is
saved under `.audit-evidence/section2-projections/` and is not a production
certificate.
