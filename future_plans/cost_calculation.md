# Cost Calculation

This document describes the cost and refund behavior used by the current checked-in code.

## Scope

- This file is about credits spent by AI features in the app.
- It does not describe subscription packaging or margin strategy.
- The authoritative runtime formulas are still implemented inside the generation routes and some client pages.

## Current cost formulas

### Image generation

Route: `src/app/api/generate-image/route.ts`

| Model | 1K | 2K | 4K |
| --- | --- | --- | --- |
| `nano-banana-2` | 8 | 12 | 18 |
| `nano-banana-pro` | 18 | 18 | 24 |

Rules:
- Image cost is fixed by selected model and resolution.
- The image page shows the same estimate with duplicated client-side logic.

### Motion control

Route: `src/app/api/generate/route.ts`

Formula:

```ts
cost = Math.ceil(durationSeconds * creditsPerSecond)
```

Current `creditsPerSecond` values:

| Model | 720p | 1080p |
| --- | --- | --- |
| `kling-2.6` | 6 | 9 |
| `kling-3.0` | 12 | 20 |

Rules:
- The motion page reads the uploaded reference video's duration.
- The page sends `Math.ceil(duration)` to the API route.
- The route validates the final duration against the selected model's max duration.

### Video generation

Route: `src/app/api/generate-video/route.ts`

Current video pricing rules:

| Model | Pricing |
| --- | --- |
| `kling-3.0-video` | `std`: 20/sec no sound, 30/sec with sound. `pro`: 27/sec no sound, 40/sec with sound |
| `seedance-1.5-pro` | Table-driven by resolution + duration + audio |
| `veo-3.1` | `veo3_fast`: 60 credits per video. `veo3`: 250 credits per video |

Seedance pricing:

| Resolution | Duration | No Audio | With Audio |
| --- | --- | --- | --- |
| `480p` | `4s` | 7 | 14 |
| `480p` | `8s` | 14 | 28 |
| `480p` | `12s` | 19 | 38 |
| `720p` | `4s` | 14 | 28 |
| `720p` | `8s` | 28 | 56 |
| `720p` | `12s` | 42 | 84 |
| `1080p` | `4s` | 30 | 60 |
| `1080p` | `8s` | 60 | 120 |
| `1080p` | `12s` | 90 | 180 |

Rules:
- Kling single-shot and multi-shot cost is based on total generated duration.
- Seedance cost is looked up from the selected resolution, selected duration, and audio flag.
- Veo cost is flat per generated video and does not vary by duration in the current route.

### Prompt enhancement

Files:
- `src/lib/prompt-enhancer.ts`
- `src/app/api/enhance-prompt/route.ts`

Current rule:

| Feature | Cost |
| --- | --- |
| Prompt enhancement | 2 credits |

### Credit top-up pricing

Route: `src/app/api/razorpay/order/route.ts`

Current server-side plan definitions:

| Plan | INR | USD reference | Credits |
| --- | --- | --- | --- |
| `starter` | 415 | 5 | 500 |
| `creator` | 1660 | 20 | 2000 |
| `pro` | 8300 | 100 | 10000 |

Rules:
- Razorpay orders are created in INR subunits from the server-defined plan table.
- Credit assignment currently has two success paths:
  - client verification via `src/app/api/razorpay/verify/route.ts`
  - server webhook via `src/app/api/razorpay/webhook/route.ts`
- Both paths rely on the `add_credits` RPC for idempotent crediting.

## Credit deduction flow

### Before a generation starts

1. The API route calculates the cost server-side.
2. It calls `deduct_credits(p_user_id, p_cost)`.
3. If the RPC returns `-1`, the request is rejected as insufficient credits.
4. If the provider request fails before a task is accepted, the route refunds with `refund_credits`.

### After a task is accepted

1. The route logs a row in `public.generations` with `cost`, `prediction_id`, `status`, `category`, and `workflow_settings`.
2. The client polls the status route.
3. If the provider later returns failure, the status route calls `refund_generation(p_prediction_id)`.
4. `refund_generation` refunds exactly once because it checks the `refunded` flag on the generation row.

### Prompt enhancement refund flow

1. The app deducts 2 credits before calling the enhancer model.
2. It inserts an `ai_usage_events` row with `status = 'pending'`.
3. On failure it calls `refund_ai_usage_event`, or falls back to `refund_credits` if the usage row was never created.

## Database pieces involved

- `profiles.credits`
- `generations.cost`
- `generations.refunded`
- `ai_usage_events.cost`
- `ai_usage_events.refunded`

RPCs currently used:
- `deduct_credits`
- `refund_credits`
- `refund_generation`
- `refund_ai_usage_event`

## Important implementation notes

- `src/lib/models.ts` is now the live source of truth for video pricing, but image and motion still keep duplicated runtime pricing outside that file.
- The video page now imports shared helpers, while image and motion still duplicate their own estimate formulas.
- If pricing changes, update all of these places together:
  - the relevant create page
  - the matching API route
  - `src/lib/models.ts`
  - `src/__tests__/models.test.ts`

## Recommended rule for future model work

When adding a new model, document and update the cost in one pass:

1. Add the backend formula first.
2. Mirror the same formula in the page estimate.
3. Update `src/lib/models.ts`.
4. Update tests.
5. Update `future_plans/model_integration.md` and this file.
