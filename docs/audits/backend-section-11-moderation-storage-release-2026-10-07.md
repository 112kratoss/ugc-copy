# Section 11U — moderation Storage evidence release

PR [#396](https://github.com/112kratoss/ugc-copy/pull/396) merged October 7,
2026 at **06:04:12 UTC** as `0df4d065600994e84b8eec7437aa0fd56cd31c6f`.
All five exact-head jobs in [Quality 37577628732](https://github.com/112kratoss/ugc-copy/actions/runs/37577628732)
pass on `024ea1a16d8d98e3ac668bb1a44a891b92eaf7e2`.
All five exact-main jobs in [Quality 37579524146](https://github.com/112kratoss/ugc-copy/actions/runs/37579524146)
and the standard [production release 37580473841](https://github.com/112kratoss/ugc-copy/actions/runs/37580473841)
pass. Automatic duplicate 37580101875 skipped. Fresh independently verified
parent/schema/advisors/live/main and immediate mobile-store idle gates passed
before merge. No manual deployment or workflow dispatch was used.

Independent readback at **06:22:31 UTC** confirms the exact live build/project,
unchanged public schema and all **110** unchanged security findings. Build/feed
return 200, admin redirects with 307 and unsigned Kie delivery returns 401.
Private evidence is in `.audit-evidence/backend-social/moderation-storage-release/`.

[11U](backend-section-11-moderation-storage-2026-10-07.md) adds sixteen actual
local Auth/session/PostgREST/SQL/Storage controls, also passing exact-head/main
CI. They cover both moderation take-down paths, actual signed bytes, retained
retry inventory across controlled transport failures, foreign path and ownership
guards, external reference disclosure and provisional hide/restore escalation.
No application or migration change is included. Hosted caches/CDN, video
variants and the broader social/media matrix remain open.
