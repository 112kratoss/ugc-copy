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
5. **A published price can be promotional, and promotions get extended.** Seedance
   2.5's 1080p tier lists 114 / 68.5 credits/s under "Limited-Time 1080P Offer: 28%
   OFF" (until Sep 17, 2026 when first captured; Oct 17 as of 2026-09-04); Seedance 2
   Fast and Mini list ≈25 % and 60 % off "until October 7, 06:00 (UTC)"; minimax-h3
   carries a standing "Pricing is 50% of the official price". A catalog release does
   not reprice itself on a date, so pinning a discounted figure under-bills the
   moment the offer lapses. `kie-evidence.mjs price` prints these qualifiers after
   the credit lines — read them. Pin the undiscounted rate unless someone decides
   otherwise on purpose, and re-read the page after the quoted date.
6. **Read the schema, not the marketing page.** kie.ai/seedance-2-5 advertises
   "up to 50 multimodal references" and "native 4K output"; the OpenAPI schema
   says `maxItems: 30` and stops at 1080p.
7. **`required` is not the whole story.** minimax-h3/reference-to-video lists only
   `prompt` and `duration` as required, then constrains the rest with
   `allOf: [anyOf: [required reference_image_urls, required
   reference_video_urls]]`. `kie-evidence.mjs spec` prints the `required` list but
   not the `anyOf` — check the spec body for combination rules by hand.
8. Stale files happen (`veo-3-1.md` was wrong on resolutions and reference
   modes; `kling_3.0.md` documented an element field Kie later renamed, and every
   named-video-element run failed at the provider until the 2026-09-04 audit).
   When behavior disagrees with a reference file, re-verify against docs.kie.ai and
   update the file with a new capture date.
9. **Attribute market-page prices to the right variant.** On a multi-model page each
   `"pricingDesc"` block sits *before* the `"model"` key it belongs to, so the id
   just after a block names it, not the id before. The page also carries a
   `"pricingDescCn"` with different, Chinese-market numbers; `kie-evidence.mjs
   price` prints both sets unlabelled, and only `pricingDesc` applies.
10. **Prices move without notice.** Grok Imagine Video went from 1.6 / 3 to 2.4 / 4.5
    credits/s and Seedance 1.5 Pro to per-second rates between captures. Diff every
    shipped rate against the live page on each pass; evidence files carry a capture
    date, not a guarantee.
