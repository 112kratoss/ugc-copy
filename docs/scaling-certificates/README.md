# Scaling Certificates

Capacity certificates are immutable reports tied to exact builds and workloads.
They are evidence about those builds, not rolling promises about `main`.

## Current status

There is **no active capacity certificate** for the current build.

## Historical certificates

| Date | Build | Scope | Result | Current applicability |
|---|---|---|---|---|
| 2026-08-10 | `c1d494e` | Authenticated web mix, 100k fixture, Mumbai Micro/Vercel preview | 7 target ops/s; 6.96 achieved | Historical only; invalidated by later build/schema/route changes |

Full report: [`2026-08-10-c1d494e.md`](2026-08-10-c1d494e.md).

A new report must include commit, schema fingerprint, catalog revision, fixture,
workload/SLO hash, external telemetry, raw artifact location, exclusions,
headroom model and explicit invalidation conditions.
