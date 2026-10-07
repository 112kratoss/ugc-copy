# Section 11S — template publication evidence release

PR [#394](https://github.com/112kratoss/ugc-copy/pull/394) merged October 7,
2026 at **05:25:22 UTC** as `aaedf1eb8ff8692501ea836cf3076b5d43968ca3`.
All five exact-head jobs in [Quality 37575031613](https://github.com/112kratoss/ugc-copy/actions/runs/37575031613)
pass on `c68443bc9a864d5a3f1db8bd2d5c3fcdf71f0826`.
Exact-main [Quality 37576225908](https://github.com/112kratoss/ugc-copy/actions/runs/37576225908)
and standard [production release 37577267512](https://github.com/112kratoss/ugc-copy/actions/runs/37577267512)
pass. Fresh verified parent, schema/advisors, live/main and immediate mobile-store
idle gates passed before merge.

Independent readback at **05:42:23 UTC** confirms the exact live build/project,
unchanged public schema and all **110** unchanged security findings. Build/feed
return 200, admin redirects with 307 and unsigned Kie delivery returns 401.
The private comparison and smoke evidence are in
`.audit-evidence/backend-social/template-publication-release/`.

[11S](backend-section-11-template-publication-2026-10-07.md) adds sixteen actual
local Auth/PostgREST/Storage cases, which also pass in exact-head/main CI. These
exercise immutable publication, signed demo bytes, ownership, lost replies,
constraint rejection, copy cleanup and concurrent activation. No application or
migration change is included. Production generation provenance, actual video/
fixed assets and the wider hosted matrix remain open. OPS-03 runbook wording
retains DB-05 installed-client review before any compatibility grant retirement;
this release removes no grant and claims no capacity certificate.
