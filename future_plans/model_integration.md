# Model Integration

This document replaces the old feature-specific planning notes for image, motion, and video generation. It describes how model integration works in the codebase today.

## Current implementation snapshot

### UI layer
- `src/app/create-image/page.tsx`
  - Defines a local `IMAGE_MODELS` registry.
  - Supports a model selector for `nano-banana-2` and `nano-banana-pro`.
  - Computes the displayed image cost in the page itself.
- `src/app/create-motion/page.tsx`
  - Defines a local `MOTION_MODELS` registry.
  - Supports a model selector for `kling-2.6` and `kling-3.0`.
  - Computes the displayed motion cost in the page itself from duration and resolution.
- `src/app/create-video/page.tsx`
  - Uses a shared video model registry from `src/lib/models.ts`.
  - Supports model-specific controls for Kling 3.0, Seedance 1.5 Pro, and Veo 3.1.
  - Computes displayed video cost from the selected model's pricing rules.

### Backend layer
- `src/app/api/generate-image/route.ts`
  - Validates the selected image model.
  - Builds the provider payload for Nano Banana image generation.
  - Deducts credits before calling Kie.ai.
- `src/app/api/generate/route.ts`
  - Handles motion control generation.
  - Maps UI model keys to provider model ids such as `kling-3.0/motion-control`.
  - Deducts credits before calling Kie.ai.
  - Sends a `callBackUrl` to Kie.ai.
- `src/app/api/generate-video/route.ts`
  - Handles provider-specific video generation workflows.
  - Sends the correct create endpoint and payload for Kling, Seedance, and Veo.
  - Deducts credits before calling Kie.ai.

### Shared model config
- `src/lib/models.ts` contains a centralized model and pricing registry plus helper functions.
- `src/__tests__/models.test.ts` validates those helper functions.
- Video pages and routes now import `src/lib/models.ts`.
- Image and motion still do not consistently import `src/lib/models.ts` yet.
- Treat `src/lib/models.ts` as the live source of truth for video, but still only a partial source of truth across the whole app.

## Supported models right now

| Feature | UI model id | Provider model id sent to Kie.ai | UI selector | Notes |
| --- | --- | --- | --- | --- |
| Image | `nano-banana-2` | `nano-banana-2` | Yes | Supports Google Search toggle and up to 14 reference images |
| Image | `nano-banana-pro` | `nano-banana-pro` | Yes | No Google Search toggle and up to 8 reference images |
| Motion | `kling-2.6` | `kling-2.6/motion-control` | Yes | Resolution and character orientation are configurable |
| Motion | `kling-3.0` | `kling-3.0/motion-control` | Yes | Same flow as Kling 2.6 with different pricing |
| Video | `kling-3.0-video` | `kling-3.0/video` | Yes | Supports single-shot, multi-shot, sound, and start/end frames |
| Video | `seedance-1.5-pro` | `bytedance/seedance-1.5-pro` | Yes | Supports resolution, duration, fixed lens, audio, and up to two images |
| Video | `veo-3.1` | `veo3_fast` or `veo3` | Yes | Supports fast/quality variants plus text-to-video and frame-to-video |

## End-to-end integration flow

### 1. User picks settings in the page
- Image and motion use local page-level registries to drive the visible fields.
- Video uses the shared registry to switch between Kling, Seedance, and Veo workflows.
- Prompt enhancement uses `src/lib/prompt-enhancer.ts` and supports:
  - `nano-banana-2`
  - `nano-banana-pro`
  - `kling-3.0/video`
  - `kling-2.6`
  - `kling-3.0`

### 2. Input media is uploaded to Supabase Storage
- Source inputs are uploaded into the `uploads` bucket from the client pages.
- The pages generate signed URLs and send those URLs to the API routes.

### 3. The API route calculates cost and deducts credits
- Each generation route calculates the cost server-side before calling Kie.ai.
- Credits are deducted with `deduct_credits`.
- If the provider request fails before a task is accepted, the route refunds with `refund_credits`.

### 4. The API route creates the Kie.ai task
- Image, motion, and Kling/Seedance video use `POST https://api.kie.ai/api/v1/jobs/createTask`.
- Veo uses `POST https://api.kie.ai/api/v1/veo/generate`.
- The route inserts a `generations` row with:
  - `user_id`
  - `model`
  - `cost`
  - `prediction_id`
  - `status`
  - `category`
  - `workflow_settings`

### 5. The client polls the app status route
- Image polls `GET /api/generate-image?id=...`
- Motion polls `GET /api/generate?id=...`
- Video polls `GET /api/generate-video?id=...`
- All current UIs still depend on polling to update progress and return the output URL.

### 6. The status route persists the finished asset
- The status route first checks the local `generations` row.
- If the generation is still in progress, it calls the provider-specific status endpoint:
  - `GET https://api.kie.ai/api/v1/jobs/recordInfo?taskId=...` for Kling and Seedance
  - `GET https://api.kie.ai/api/v1/veo/record-info?taskId=...` for Veo
- On success, the route downloads the provider output and stores it in:
  - `generated_images` for images
  - `generated_videos` for motion and video
- The route then updates `generations.status` and `generations.output_url`.

### 7. Failed async jobs are refunded
- If the provider later reports failure, the status route marks the row as `failed`.
- It then calls `refund_generation`, which refunds the stored `cost` once and marks the row as refunded.

## Callback behavior today

### Image
- No callback URL is sent.
- Completion handling is polling-only in the checked-in code.

### Video
- No callback URL is sent from the checked-in app for Kling, Seedance, or Veo.
- Completion handling is polling-only in the checked-in code.

### Motion
- The motion route sends:
  - `callBackUrl = https://ildfmhozpibwiopeavfg.supabase.co/functions/v1/kie-webhook?secret=...`
- The checked-in UI still polls `GET /api/generate?id=...` even though a callback URL is passed to Kie.ai.
- There is no `kie-webhook` Edge Function in this repository, so the callback implementation is either:
  - deployed outside this workspace, or
  - missing from the repo.
- Because of that, the reliable completion path visible in this codebase is still polling.

## Model-specific notes

### Image generation
- The image page and route each maintain their own model config.
- `googleSearch` is only added to the provider payload when the selected model supports it.
- Reference images are clamped server-side to the configured model limit.

### Motion control
- The motion UI stores the selected UI model key in `workflow_settings.model`.
- The route stores the provider model id in `generations.model`.
- That means a motion row may contain:
  - `workflow_settings.model = 'kling-3.0'`
  - `model = 'kling-3.0/motion-control'`

### Video generation
- Kling supports single-shot and multi-shot flows.
- Seedance supports single-shot generation with duration, resolution, fixed lens, and audio options.
- Veo supports fast and quality variants with text-to-video or frame-to-video input.
- Video cost is model-specific:
  - Kling is duration-based
  - Seedance uses resolution + duration + audio tables
  - Veo uses flat per-video pricing

## What must be updated when adding a new model today

1. Add or update the provider API reference in `model_api_references/`.
2. Update the page-level UI config for the relevant feature.
3. Update the corresponding API route to validate the new model and build the correct payload.
4. Update cost logic in both the page and the route.
5. Update `src/lib/models.ts` so the shared config mirror stays aligned.
6. Update `src/__tests__/models.test.ts` if pricing helpers change.
7. Update `src/lib/prompt-enhancer.ts` if the model should support prompt enhancement.
8. Check `src/app/api/showcase/publish/route.ts` if model naming changes would break category detection.
9. Make sure `workflow_settings` stores enough data for remix and audit.

## Current cleanup targets

- Move runtime model definitions and pricing into one real shared source of truth.
- Remove duplicated cost formulas from pages and API routes.
- Decide whether callbacks are required or whether polling should remain the only supported completion flow.
- Check in the `kie-webhook` implementation if motion callbacks are part of the supported architecture.
- Normalize what gets stored in `generations.model` so image, motion, and video follow the same convention.
