# Supporting evidence: model, post, and remix audit

This document supports the [main audit](model-post-remix-audit-2026-09-15.md). It records the reviewed source snapshot, test coverage, and the diagnostic behaviors reproduced during the review.

## Reviewed snapshot

- Commit: `5233d61fdd6f3a3402041053334a6efd125739ba`
- Date: 15 September 2026 (IST)
- Checkout: isolated worktree at `/private/tmp/magicbooklet-iphone-remix`
- No production writes, paid provider jobs, or OTA publishes were performed during this audit.

## Test evidence

The existing targeted suites passed:

- 502 server tests in 51 suites covering model catalog, quoting, generation start, input media, posts, resource bundles, and remix services.
- 353 mobile tests in 23 suites covering model catalog, creation drafts, media creation, post flows, viewer actions, and OTA behavior.
- 184 additional server tests in 18 suites covering callbacks, completion jobs, provider-task attachment, settlement, and webhook paths.

Seven tests appeared in both server batches, so the distinct total is **1,032 tests across 91 suites**.

## Diagnostic counterexamples

Six focused probes confirmed the current behaviors described in the main audit:

1. A remix capability can be `unlock_required` while the remix prefill service still returns the original prompt.
2. The same reference URL produces different reference-adjustment costs when the caller changes `durationSeconds` from zero to ten.
3. A mobile retry after a simulated lost start response sends the same request body with a new idempotency key.
4. A private-post update can return success when linked-generation visibility synchronization is injected to fail.
5. Ordinary drafts saved under different account IDs resolve to the same unscoped storage key.
6. A nonempty persisted reference list containing an expired signed URL does not trigger source recovery.

These probes are diagnostic counterexamples, not desired-behavior regression tests. They demonstrate gaps and should be replaced by failing tests for the current behavior once each fix is implemented.

## Key source evidence

- Remix access and prefill: `src/lib/showcase-remix-service.ts`, `src/lib/remix-source-server.ts`, `src/lib/post-resource-bundles.ts`
- Quote construction and pricing: `src/lib/unified-generation-start-service.ts`, `src/lib/generation-model-runtime.ts`
- Generation reservation and idempotency: `src/lib/generation-services.ts`, `src/lib/generation-start-idempotency.ts`, `ugc-mobile/components/media-creation-screen.tsx`
- Post privacy synchronization: `src/lib/post-update-service.ts`, `src/lib/post-resource-bundles-server.ts`, Supabase post-resource migrations
- Mobile persistence and URL handling: `ugc-mobile/lib/creation-draft-resume.ts`, `ugc-mobile/lib/remix-draft-recovery.ts`, `ugc-mobile/components/media-preview.tsx`
- OTA runtime and application policy: `ugc-mobile/app.json`, `ugc-mobile/lib/app-update-policy.ts`, `ugc-mobile/lib/use-ota-update-gate.ts`, `ugc-mobile/scripts/publish-ota.mjs`

## Limitations

The audit did not run paid provider jobs, inspect private production rows, deploy migrations, perform a penetration test, certify provider billing semantics, or wait one hour on a physical device for signed-URL expiry. The original iPhone draft was not extracted, so the exact event that emptied it remains inferred. The evidence supports the reported recovery and the code-level risks; it does not prove that every device was running old code.
