# Documentation index

Live runbooks are at the root of this folder; everything dated or reference-only is in a subfolder. Code, tests, and CI reference the runbooks by path, so they stay where they are.

## Runbooks

- [production-deployment-runbook.md](production-deployment-runbook.md) — topology, environment contract, release gates, alert-response guide.
- [local-development.md](local-development.md) — local Supabase stack and the dev server.
- [supabase-local-prod-workflow.md](supabase-local-prod-workflow.md) — migrations and local/production parity.
- [generation-model-catalog-operations.md](generation-model-catalog-operations.md) — model catalog releases: validate, stage, publish, rollback.
- [model-onboarding.md](model-onboarding.md) — adding a generation model end to end: provider checks, code registration, the release, rollout.
- [moderation-operations.md](moderation-operations.md) — staffed moderation queue and the service-role CLI.
- [feed-algorithm-operations.md](feed-algorithm-operations.md) — For You ranking versions: the scorecard (including the viewer-grain, position and format sections and the SRM check), activating a version and rolling back, experiments, kill switches, and training a draft version from the delivery facts (`ops:feed-ranker`).
- [mobile-store-product-catalog.md](mobile-store-product-catalog.md) — IAP tier provisioning.
- [post-resource-bundle-v1.md](post-resource-bundle-v1.md) — paid resource bundles.
- [scaling-audit.md](scaling-audit.md) — scaling entry point; [scaling-certification-runbook.md](scaling-certification-runbook.md) and [supabase-performance-inspection.md](supabase-performance-inspection.md) sit beside it.

## Folders

- `design/` — the design-system index and the web and mobile guides, and the June 2026 UI-consistency research they cite.
- `audits/` — the dated audit reports the runbooks still cite: the scaling findings and feed-session diagnostics, the CDN audit, the newest Kie model scan, the model-onboarding and reference-input audits. Older dated reports, including the 2026-09/10 backend audit series, were removed on 2026-10-18 and remain in git history (`git show 0daef048:docs/audits/<file>`).
- `plans/` — open plans and scoping records only. When a plan's work ships, move it to `archive/` with a dated status line at the top, or delete it if the code, `AGENTS.md`, or an audit already holds the reasoning. For You ranking: [feed-algorithm-v3-x-adoption-2026-10-11.md](plans/feed-algorithm-v3-x-adoption-2026-10-11.md) — v3, what we take from X's For You algorithm (it continues [feed_algorithm_v2.md](plans/feed_algorithm_v2.md)); [feed-algorithm-v4-industry-parity-2026-10-12.md](plans/feed-algorithm-v4-industry-parity-2026-10-12.md) — v4, closing the gaps to the industry leaders (embeddings, taste retrieval, clusters, labels, Home telemetry, the trainer).
- `research/` — the prompt-enhancer playbooks, the media-architecture research, and the feed-ranking research. Feed ranking: [magicbooklet-feed-ranking-analysis-2026-10-11.md](research/magicbooklet-feed-ranking-analysis-2026-10-11.md) — how our For You ranking works today, with file and line references; [x-algorithm-analysis-2026-10-11.md](research/x-algorithm-analysis-2026-10-11.md) — X's open-sourced For You algorithm, read for what transfers to a small feed.
- `model-api-references/` — captured provider API references, the input to model onboarding (its README carries the capture rules).
- `scaling-certificates/` — exact-build capacity certificates.
- `archive/` — the 2026-08-08 scaling audit (kept because code and a workflow still reference it), the HIG alignment note the mobile guide cites, and the 2026-10-18 Claude Code setup review (its decisions are in `AGENTS.md`; the record keeps the gap analysis and sources); not current capacity claims. Shipped plans are deleted rather than archived once the code or a runbook holds the reasoning.
