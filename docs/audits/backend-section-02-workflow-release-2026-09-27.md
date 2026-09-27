# Section 2 workflow ownership — production verification

PR: https://github.com/112kratoss/ugc-copy/pull/216
Released main: `7113b5906cb21febc9141862b07c16086a855ca6`.
Exact-main Quality: https://github.com/112kratoss/ugc-copy/actions/runs/36268035410 (success).
Production release: https://github.com/112kratoss/ugc-copy/actions/runs/36268404975 (success, 2026-09-26 20:11:19 UTC).

- 251 migrations replayed cleanly; 74 pgTAP files / 1,396 assertions passed.
- PR CI: 813 web files / 5,980 tests; 262 mobile files / 2,578 tests passed, plus browser smoke, lint, type checks, build and runtime packaging.
- Production verifier passed 24 assertions at 20:09:39 UTC, after the migration and before application promotion. Valid owner writes succeeded; foreign parent/proposal/generation links and revoked-session reads were denied.
- Both disposable identities, canvases and inert generations were removed. Independent database counts confirmed zero fixtures remain.
- Production policy fingerprint matches clean replay: 133 policies, digest `b4273b614834070b23a18b2982422caa`. Table grants unchanged: 848 entries, digest `e89de6206100faf3998cbaa1a8608cc6`.
- Production app-version independently confirmed the released main SHA after promotion. Protected staged/live health checks passed in the release workflow.
- Post-migration security/performance advisors returned no ERROR findings. Existing guest/definer warnings and informational entries remain in the broader audit.
- Production dependency audit: zero known vulnerabilities.

This completes the workflow ownership fix batch only. The Section 2 coverage ledger remains open for the other direct tables, RPCs, Storage and Realtime.
