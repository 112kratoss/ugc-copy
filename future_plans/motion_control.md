# Motion Control Feature

## Overview
Transfer motion from a reference video onto a static image to create an animated video using AI models. The platform supports **multiple motion control models**, and the UI and backend dynamically adapt to each model's unique capabilities.

## Architecture

### Multi-Model Support
The `/create-motion` page includes a **Model Selector** at the top. When a model is selected, the UI dynamically shows/hides form fields based on that model's capabilities. The backend API route reads the selected `model` from the request and constructs the correct payload.

### How to Add a New Motion Control Model
1. Add the model's API documentation to `model_api_references/<model_name>.md`.
2. Add a new entry to the **Model Registry** below with all its capabilities.
3. The AI assistant (or developer) will use this registry + the API doc to update the frontend form and backend route.

---

## Model Registry

### Model: `kling-2.6` (Kling 2.6 Motion Control)
- **Status**: ✅ Integrated
- **API Reference**: `model_api_references/kling2.6_motion_control.md`
- **API Endpoint**: `POST https://api.kie.ai/api/v1/jobs/createTask` (model: `kling-2.6/motion-control`)
- **Capabilities**:
  | Capability | Supported | Details |
  |---|---|---|
  | Reference Image | ✅ | Required — the subject/character image |
  | Reference Video | ✅ | Required — the motion source video |
  | Text Prompt | ✅ | Optional text description |
  | Character Orientation | ✅ | `image` or `video` — which source defines the character pose |
  | Resolution | ✅ | `720p, 1080p` |
  | Aspect Ratios | ❌ | Determined by input media |
  | Duration Control | ❌ | Determined by reference video length |
  | Quality Mode | ❌ | — |
  | AI Sound Effects | ❌ | — |
- **Cost**: Flat rate per generation.
  | Resolution | Credits |
  |---|---|
  | 720p | 20 |
  | 1080p | 30 |

### Model: `kling-3.0` (Kling 3.0 Motion Control)
- **Status**: ✅ Integrated
- **API Reference**: `model_api_references/kling-3.0/kling-3.0/kling-3.0-motion-control.md`
- **API Endpoint**: `POST https://api.kie.ai/api/v1/jobs/createTask` (model: `kling-3.0/motion-control`)
- **Capabilities**:
  | Capability | Supported | Details |
  |---|---|---|
  | Reference Image | ✅ | Required — the subject/character image (JPG/PNG, max 10MB, min 300px, aspect ratio 2:5–5:2) |
  | Reference Video | ✅ | Required — the motion source video (MP4/MOV, max 100MB, 3–30s) |
  | Text Prompt | ✅ | Optional, max 2500 characters |
  | Character Orientation | ✅ | `image` (max 10s output) or `video` (max 30s output) |
  | Resolution | ✅ | `720p`, `1080p` |
  | Aspect Ratios | ❌ | Determined by input media |
  | Duration Control | ❌ | Determined by reference video length |
  | AI Sound Effects | ❌ | — |
- **Cost**: 
  | Resolution | Credits / Sec (Base) | USD Approx |
  |---|---|---|
  | 720p | 12 | ~$0.06/s |
  | 1080p | 20 | ~$0.10/s |

### Model: `[future-motion-model]` (Example Placeholder)
- **Status**: 🔲 Not Yet Integrated
- **API Reference**: `model_api_references/[future_model].md`
- **Capabilities**:
  | Capability | Supported | Details |
  |---|---|---|
  | Reference Image | ✅/❌ | Required or optional |
  | Reference Video | ✅/❌ | Required or optional |
  | Text Prompt | ✅/❌ | — |
  | Character Orientation | ✅/❌ | Options list |
  | Resolution | ✅/❌ | Options list |
  | Duration Control | ✅/❌ | Fixed or slider |
  | Quality Mode | ✅/❌ | Quality tiers |
- **Dynamic Cost**: Define cost formula.

---

## Technical Implementation

### Frontend (`/create-motion/page.tsx`)
- **Model Selector**: Dropdown at the top (scalable — iterates `MOTION_MODELS` registry automatically).
- **Dynamic Form**: Based on selected model's capabilities:
  - If model requires `Reference Image` → show image uploader (required).
  - If model requires `Reference Video` → show video uploader with duration/size limits.
  - If model supports `Text Prompt` → show prompt text area.
  - If model supports `Character Orientation` → show orientation selector.
  - If model supports `Resolution` → show resolution selector.
- **Dynamic Cost Display**: Updates based on model + resolution.

### Backend (`/api/generate/route.ts`)
- Reads `model` from the request body (defaults to `kling-2.6`).
- Uses a `MOTION_MODEL_CONFIG` registry map to determine the correct API model identifier and constraints.
- Deducts credits, polls for completion, downloads video to Supabase Storage.

### Database
- `generations` table with `model` column (e.g., `kling-3.0/motion-control`).
- `type = 'motion_control'` for all motion control generations.

### Key Files
- `src/app/create-motion/page.tsx` — creation UI
- `src/app/api/generate/route.ts` — backend API route

## Current Status
- [x] Kling 2.6 motion control fully integrated
- [x] Model selector dropdown added to `/create-motion` (defaults to Kling 3.0)
- [x] Backend refactored to support model switching via `MOTION_MODEL_CONFIG`
- [x] Kling 3.0 integrated
