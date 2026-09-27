# Section 4 — payout production verification

PR [#229](https://github.com/112kratoss/ugc-copy/pull/229) merged as
`df6e70790bcdd95f7c2eee5c832dac195414a18a`.

- PR Quality [36338216651](https://github.com/112kratoss/ugc-copy/actions/runs/36338216651): all four jobs passed.
- Exact-main Quality [36338865999](https://github.com/112kratoss/ugc-copy/actions/runs/36338865999): all four jobs passed.
- Production release [36339543952](https://github.com/112kratoss/ugc-copy/actions/runs/36339543952): passed at 18:11:47 UTC, including staged health, promotion and protected live health. Independent `/api/app-version` returned the exact merged commit.

The migration changes only the null-action guard in the payout resolver.
The existing production function body matched the repository baseline digest
`9fbe2edc7b5e6093f8011fbdca5f37f4` before replacement.

Before the fix, six of 36 local state-machine assertions failed. A production
rollback probe confirmed that a null decision released the fixture hold; no
financial records were committed. Independent counts for fixture users,
wallets and requests returned zero. An aggregate check found zero existing
rejected payout requests with null resolution notes.

Local fixed validation: 36 focused state-machine assertions, 256 cleanly
replayed migrations, 1,646 database assertions across 80 files, and 34 focused
application tests. The local concurrent test admitted one of 20 requests and
resolved one of 20 mixed pay/reject decisions. Final available/held/paid amounts
matched the winning decision.

At 17:46:15 UTC, the pre-release HTTP verifier passed 17 checks with two
disposable zero-balance identities: client RPC denial, payout field validation,
below-minimum rejection, guest/signed-out/admin denial and session revocation.
It removed both identities and created no financial rows. This HTTP probe
checks the already-protected application boundary; the SQL matrix is what
reproduces and verifies the null-action database defect.

Post-release production verification passed **36 SQL assertions** in one rolled-back
transaction and **17 real-session HTTP checks** at 18:15:40 UTC. The SQL matrix
confirmed null-action rejection without mutation, valid holds/resolutions,
replay protection, preservation of new earnings/refund debt and settlement of
detached obligations. No external transfer occurred. The HTTP probe created
no financial records and removed both identities. Independent checks found zero
fixture users, wallets, payout records (including detached records) and rate counters.

Schema fingerprints: **15 of 16 categories unchanged**; only function definitions
changed, to `213d008371cdd6167783973de3496a81`. Function count remains 306.
Grants, policies, tables, columns, triggers and storage definitions are unchanged.
The current security advisor baseline remains 1 INFO / 37 WARN / 0 ERROR.

This closes the payout state-transition batch. It does not certify external
transfers, successful operator-cookie settlement, payment-provider webhooks,
purchase settlement or the broader refund and ledger workflows.
