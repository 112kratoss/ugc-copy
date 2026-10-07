# Section 11W — worker-death evidence release

PR [#398](https://github.com/112kratoss/ugc-copy/pull/398) merged October 7,
2026 at **06:42:47 UTC** as `ff3a70beebea323b95da6bfc9969fcea12972ba1`.
All five exact-head jobs in [Quality 37580073922](https://github.com/112kratoss/ugc-copy/actions/runs/37580073922)
pass on `24801435f057125bb59c80b66d3b2503e25392f2`.
All five exact-main jobs in [Quality 37583034551](https://github.com/112kratoss/ugc-copy/actions/runs/37583034551)
and standard [production release 37583940527](https://github.com/112kratoss/ugc-copy/actions/runs/37583940527)
pass. Automatic duplicate releases skipped. Fresh verified parent, schema,
advisors, live/main and immediate mobile-store idle gates passed before merge.

Independent readback at **07:34:16 UTC** confirms the exact live build/project,
unchanged schema and all **110** unchanged security findings. Build/feed return
200, admin redirects with 307 and unsigned Kie delivery returns 401. Evidence:
`.audit-evidence/backend-social/revocation-worker-death-release/`.

[11W](backend-section-11-showcase-revocation-worker-death-2026-10-07.md) adds three
actual owned Node-process SIGKILL controls before Storage removal, after actual
removal and after gallery deletion commits. Fresh processes complete the durable
work and a further retry is empty. Exact fixture rows/objects are zero. These
cases pass locally and in exact-head/main CI. No runtime or migration change is
included. Managed lease/fencing, renewed-reference races, hosted cache behavior
and broader MEDIA-09 recovery remain open.
