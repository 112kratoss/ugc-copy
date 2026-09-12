# Documentation index

Live runbooks are at the root of this folder; everything dated or reference-only is in a subfolder. Code, tests, and CI reference the runbooks by path, so they stay where they are.

## Runbooks

- [production-deployment-runbook.md](production-deployment-runbook.md) — topology, environment contract, release gates, alert-response guide.
- [local-development.md](local-development.md) — local Supabase stack and the dev server.
- [supabase-local-prod-workflow.md](supabase-local-prod-workflow.md) — migrations and local/production parity.
- [generation-model-catalog-operations.md](generation-model-catalog-operations.md) — model catalog releases: validate, stage, publish, rollback.
- [moderation-operations.md](moderation-operations.md) — staffed moderation queue and the service-role CLI.
- [mobile-store-product-catalog.md](mobile-store-product-catalog.md) — IAP tier provisioning.
- [post-resource-bundle-v1.md](post-resource-bundle-v1.md) — paid resource bundles.
- [scaling-audit.md](scaling-audit.md) — scaling entry point; [scaling-certification-runbook.md](scaling-certification-runbook.md) and [supabase-performance-inspection.md](supabase-performance-inspection.md) sit beside it.

## Folders

- `design/` — the design-system index and the web and mobile guides, the June 2026 UI-consistency research, and the mobile design-QA log.
- `audits/` — dated audit reports and findings: Kie model scans, media delivery, performance, scaling findings, production audits.
- `plans/` — plans and scoping records, current and historical.
- `research/` — prompt-enhancer and model-prompting research.
- `model-api-references/` — captured provider API references, the input to model onboarding (its README carries the capture rules).
- `scaling-certificates/` — exact-build capacity certificates.
- `superpowers/` — agent-written plans and specs.
- `archive/` — dated audit journals; not current capacity claims.
