# Section 5C — marketplace quote production verification

[PR #236](https://github.com/112kratoss/ugc-copy/pull/236) merged and deployed as `bd0f983e18b13990b0fbd9355ab6b89b259119c4`.

- [PR Quality](https://github.com/112kratoss/ugc-copy/actions/runs/36379261246): passed all four jobs.
- [Exact-main Quality](https://github.com/112kratoss/ugc-copy/actions/runs/36379991804): passed all four jobs.
- [Production release](https://github.com/112kratoss/ugc-copy/actions/runs/36380693661): succeeded at 2026-09-28 05:14:14 UTC, including migration, stage verification, promotion and live health. Independent `/api/app-version` matched the merge SHA.

The deployed marketplace completion function matches local replay digest `d5d061d79300d5c2942a595a9d57bb0e`; the immutable quote trigger function matches `7c9986c6fe4342c5447059002f9c9fb1`. Production recorded `pin_marketplace_cash_quotes` as version `20260928051127`; repository filename is `20260928044248`. The release runner supports this through unique migration-name matching.

All **26 production SQL assertions passed**, including price increases/decreases, a listing becoming free, duplicate capture, refunds, quote immutability, missing evidence and service-only settlement. The probe used fixture records inside one rolled-back transaction. Independent cleanup checks found zero fixture users, profiles, assets, orders, purchases, wallets, wallet entries or cash adjustments. No pending cash orders without quotes remained.

All **16 post-release HTTP checks passed** at 2026-09-28T05:16:19.085Z: eight commerce endpoints rejected forged bearer authentication and returned no-store responses. The reusable probe is `scripts/ops/verify-commerce-admission.mjs --base-url https://magicbooklet.com`.

Before release, the existing financial ownership probe passed **48 production SQL assertions**, with no fixtures remaining. Read-only integrity queries found no paid bundle orders without entitlements, no bundle purchase prices differing from their recorded quotes, and no sale wallet entries with incorrect 85/15 splits. There were zero marketplace orders and checkout intents at preflight; 25 bundle orders existed.

Schema fingerprints changed only in the expected column-order, columns, constraints, functions and triggers classes. Grants, indexes, policies, storage and other classes stayed unchanged. Local/production parity matches 13 of 16 classes; pre-existing column order, local pgTAP and unrelated function-body representations account for the outstanding classes noted in the preceding section 5B release report. Both functions shipped here match exactly. Production now has 309 public functions, 131 tables and 100 triggers.

Security advisors remain 1 INFO group, 37 WARN groups and 0 ERROR groups. This is an existing warning backlog, not a clean security certification; the [Supabase linter remediation guide](https://supabase.com/docs/guides/database/database-linter) explains the notices.

Validation before release: 260 cleanly replayed migrations, 1,781 pgTAP assertions; 411 focused commerce tests; complete CI with 6,012 web tests, 2,738 mobile tests and 18 browser tests, plus 2 credit concurrency tests and 4 real-handler/database tests. No real provider charges, refunds or customer balance changes were made. Live provider delivery and a fresh hosted purchase/download flow remain outside this evidence.

See the [section audit](backend-section-05-commerce-2026-09-28.md) for coverage and remaining work, including commerce event identity/concurrency and the mobile-store lifecycle. This completes the reproduced quote defect and its release, not the entire backend audit.
