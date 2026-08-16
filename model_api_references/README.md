# model_api_references

Verbatim provider evidence for every model we integrate. Each file records, with a
capture date and source URLs, the exact `model` enum values, input field names and
enums, and the market-page pricing a model shipped against. Tests cite these files
(`VERIFIED_PROVIDER_IDS` comments), so they are evidence, not documentation prose.

## Gathering evidence

Use the committed tool — it sends a browser user agent (Kie's Cloudflare blocks
non-browser UAs) and reads the spec bodies:

```bash
node scripts/kie-evidence.mjs slugs             # every market slug from the sitemap
node scripts/kie-evidence.mjs price kling-o3    # credit lines from kie.ai/kling-o3
node scripts/kie-evidence.mjs spec bytedance/seedance-2-5   # model enum + input fields
```

## Rules learned the hard way

1. **The docs path is not the model id.** `market/qwen3-pro/*` documents
   `qwen3/pro-*`; `market/kling/v3-omni-*` documents `kling-3.0-omni/*`. Always
   quote the `model` parameter's enum from the spec body.
2. **Pricing lives only on the market pages.** No OpenAPI spec or API endpoint
   carries it; the aggregated kie.ai/pricing table lags launches (Kling O3) and
   can contradict the market page (flux-2-flex) or omit models entirely
   (PixVerse). The per-model market page is authoritative; if it is ambiguous or
   silent, do not ship the model.
3. **Search the pricing table by vendor, not product name** — "Kling AI Avtar"
   (their spelling) and "Kling O3" (their branding for 3.0 Omni) both return
   nothing for the obvious queries.
4. **Credits are Kie credits 1:1** (1 credit = $0.005); copy the credit figure
   into `models.ts` unchanged. High-tier top-ups carry a +10% bonus, so real cost
   runs ~10% under list.
5. Stale files happen (`veo-3-1.md` was wrong on resolutions and reference
   modes). When behavior disagrees with a reference file, re-verify against
   docs.kie.ai and update the file with a new capture date.
