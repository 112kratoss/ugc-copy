# Section 11T — admin moderation input release

PR [#395](https://github.com/112kratoss/ugc-copy/pull/395) merged October 7,
2026 at **05:45:59 UTC** as `ebd551b6fe8c84c05e9811b52f6c211a4ac99d52`.
All five exact-head [Quality 37576758590](https://github.com/112kratoss/ugc-copy/actions/runs/37576758590)
jobs pass on `aad77b006aa57dc6017719ab37fe9b2b172f6724`.
Exact-main [Quality 37577951136](https://github.com/112kratoss/ugc-copy/actions/runs/37577951136)
and standard [production release 37578624582](https://github.com/112kratoss/ugc-copy/actions/runs/37578624582)
pass. Automatic duplicate 37578732709 skips; it is not a second deployment.
Fresh verified parent, schema/advisors, live/main and immediate mobile-store
idle gates passed before merge.

Independent readback at **06:02:45 UTC** confirms exact live build/project,
unchanged public schema and all **110** unchanged security findings. All three
tested runtime file digests match the released commit. Six unsigned mutation
requests return private/no-store 401. Build/feed return 200, admin redirects
with 307 and unsigned Kie delivery returns 401. The first source readback ran
before the merge commit had been fetched locally and stopped at the missing Git
object; fetching it and repeating the full verification passes. No application
or production change was made for that verification issue.

[11T](backend-section-11-admin-moderation-inputs-2026-10-07.md) records six real
session/API regressions and the three-module input validation fix. All 60 actual
GoTrue/session/PostgREST/SQL cases and 33 focused cases pass; types/lint and
independent fixture cleanup pass. No migration, provider request or customer
balance change. Read-only routine comparison preserves five exact definitions
and one reviewed four-cast difference; all six signatures/grants match.

The reproduced SOCIAL-03 input defects are resolved. That row returns to
**untested** for broader hosted moderation, cache, sanctions and reporting
behavior. Private release evidence is in
`.audit-evidence/backend-social/admin-moderation-release/`.
