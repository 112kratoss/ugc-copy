# Sections 12O/P — verified profile request and media controls

PR #427 merged as `4ca608a1cf7a6859fe988c2382acdf4846dbd491` at 12:54:13 UTC,
including #426's eight profile-media cases. Candidate Quality 37916144417 passed
all five jobs. Its main run was cancelled when #428 advanced main; that cancelled
run is not evidence of successful main verification.

The unchanged backend changes subsequently passed exact-main Quality 37933416612
and standard release 37935022801 on `791a5ce6`. A further mobile-only change,
#430, advanced production to `a4fb1d9ee6d803c74f6191984e3f7e390755f0b5`.
All five exact-main Quality jobs (37945161319) and standard release 37946668616
passed for that current build, including staged and protected production health.

Independent live readback at 16:14:05 UTC verifies the exact `a4fb1d9e` build,
the four tested profile runtime files, unchanged database schema/permissions and
all 112 security findings unchanged. Public smoke passes: app-version/feed 200,
admin payout login redirect 307, unsigned provider webhook 401. No migration or
production fixture/data repair was required.

The fix enforces 64 KiB streamed JSON limits on profile update, validation,
media signing and cleanup. Its 28 real Auth/SQL adapter controls cover header
bypasses, UTF-8 byte counting, exact-limit acceptance, unauthenticated rejection
before parsing and cancellation before the oversized tail is read. Thirty focused
tests, 136 mobile contract tests and application/test/mobile typing pass. The
eight actual profile-media controls verify ownership, finalization, resave and
cleanup retries. These are scoped controls, not complete profile certification.

SOCIAL-04 returns to untested for the remaining method/lifecycle matrix. The
five additional 12S rate/admission cases and 12R release-health verifier changes
are separate pending batches. Private proof is `profile-request-bounds-release/`
under `.audit-evidence/backend-social/`; its original baseline is preserved.
