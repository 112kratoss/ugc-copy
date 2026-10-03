# Section 7A — template lifecycle fixes release

PR [#289](https://github.com/112kratoss/ugc-copy/pull/289) merged as
`475fe2b73ce2d1e4d8b37124aaa305b6658d9769` on October 3 at 01:39:35 IST.

Run responses now report current settlement costs across all attempts, including
late refunds after cancellation. Checkpoint retry reserves the gate and both next
attempts in one transaction, so competing approval/cancellation cannot leave
unwanted replacement work and duplicate retry cannot observe a partial pair.

- Initial PR CI `37056295355` found a real concurrent retry failure. It was also
  reproduced locally and fixed, rather than dismissed as flaky. Before/after
  approval/cancel races and injected second-insert rollback remain recorded.
- Updated PR Quality `37057488661` passed: 6,650 web tests, 2,911 mobile, 21 browser,
  1,941 SQL assertions, 142 database cases (one harness skip), real media probes
  and 163 native route traces.
- No mobile store release was active before merge.
- Exact-main Quality `37058779424` passed all four jobs. With intervening #283,
  it ran 6,653 web and 24 browser tests; other counts remained as above.
- Standard production release `37059587121` succeeded first attempt at October 2
  20:21:18 UTC / October 3 01:51:18 IST, including staged and protected live health.
- On resumption, production had advanced through notification PR #290 to
  `c7a8419b8f8e417e2c97fea219ae4861e9e80974`. Its release `37062922373` succeeded.
  Independent live SHA, feed 200, admin login redirect 307 and unsigned webhook
  401 checks passed on that descendant containing the 7A fixes.

The superseded #283 release `37058745760` rejected stale main before changing
production. Its failure is retained separately from the successful 7A release.

[Scope and reproductions](backend-section-07-template-lifecycle-2026-10-03.md).
No production payment, generation or customer balance was changed by the probes.
WORKFLOW-02/03/04 remain open; ledger stays 22 passed, 27 untested, one failed,
three external. Raw evidence is in `.audit-evidence/backend-section-07/`.
