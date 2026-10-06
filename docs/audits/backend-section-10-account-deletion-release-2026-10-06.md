# Sections 9O/10A — managed verification and account deletion evidence release

PR [#373](https://github.com/112kratoss/ugc-copy/pull/373) passed exact-head Quality
37496465208 on 31a979fd3d7dc2c69203e96ea4a1a94e6665a9b8. It merged October 6
at 16:45:05 UTC with mobile-store release idle as
b9729ee41f4fc4db1c500bc96283d667eae34847. Exact-main Quality 37498165169 and
standard production release 37499514443 passed.

Independent verification at 2026-10-06T17:00:44.356Z confirms the exact live build,
unchanged database schema and all 110 unchanged security advisor findings.
Feed returns 200, admin payouts redirects to login with 307, and an unsigned
generation webhook returns 401. Private evidence is in
.audit-evidence/backend-social/account-deletion-release/. No production
account deletion or provider request was made by the audit verification.

This PR changes tests and evidence only. It includes five managed model-job
controls (19 total) and twelve actual local deletion controls. The later 10B/C
controls remain separately scoped candidates; their local fixtures do not prove
every deployed deletion path or external provider behavior.

The model suite also passes all 19 actual cases on Node 24.21.0, after rebuilding
the local fs-ext binary for that runtime. The original local shell was Node 22;
the first Node 24 model import correctly rejected its incompatible native ABI.
No dependency version or application source was changed. The current 10C
candidate's 27 actual deletion controls pass under Node 24.21.0 as well.
