# Video Generation Feature

## Overview
Allow users to generate videos from text prompts and optional reference media using AI models. The platform supports **multiple video generation models**, and the UI and backend dynamically adapt to each model's unique capabilities.

## Architecture

### Multi-Model Support
The `/create-video` page includes a **Model Selector** at the top. When a model is selected, the UI dynamically shows/hides form fields based on that model's capabilities. The backend API route reads the selected `model` from the request and constructs the correct payload.

### How to Add a New Video Model
1. Add the model's API documentation to `model_api_references/<model_name>.md`.
2. Add a new entry to the **Model Registry** below with all its capabilities.
3. The AI assistant (or developer) will use this registry + the API doc to update the frontend form and backend route.

---

## Model Registry

### Model: `kling-3.0` (Kling 3.0)
- **Status**: ✅ Integrated
- **API Reference**: `model_api_references/kling_3.0.md`
- **Capabilities**: (Parsed from API reference)
  | Capability | Supported | Details |
  |---|---|---|
  | Text Prompt | ✅ | Required |
  | Shot Modes | ✅ | Native UI switch |
  | Start Frame (Image) | ✅ | Parse max size from API |
  | End Frame (Image) | ✅ | Parse max size from API |
  | Duration | ✅ | Parse supported duration ranges from `model_api_references/kling_3.0.md` |
  | Quality Mode | ✅ | Parse supported quality modes from API doc |
  | Aspect Ratios | ✅ | Parse supported ratios from API doc |
  | AI Sound Effects | ✅ | Boolean |
  | Reference Video | ❌ | — |
  | Camera Controls | ❌ | — |
- **Dynamic Cost**: Calculate dynamically multiplied by the total duration and quality mode markup parsed from the API doc.

### Model: `[future-video-model]` (Example Placeholder)
- **Status**: 🔲 Not Yet Integrated
- **API Reference**: `model_api_references/[future_model].md`
- **Capabilities**:
  | Capability | Supported | Details |
  |---|---|---|
  | Text Prompt | ✅/❌ | — |
  | Shot Modes | ✅/❌ | Single, Multi, etc. |
  | Start/End Frame | ✅/❌ | Image uploads |
  | Duration | ✅/❌ | Range or fixed options |
  | Quality Mode | ✅/❌ | List of quality tiers |
  | Aspect Ratios | ✅/❌ | Supported list |
  | AI Sound Effects | ✅/❌ | — |
  | Reference Video | ✅/❌ | Upload a reference video as input |
  | Camera Controls | ✅/❌ | Pan, zoom, tilt, etc. |
- **Dynamic Cost**: Define cost formula.

---

## Technical Implementation

### Frontend (`/create-video/page.tsx`)
- **Model Selector**: Dropdown or card selector at the top.
- **Dynamic Form**: Based on selected model's capabilities:
  - If model supports `Shot Modes` → show mode toggle (Single/Multi) with dynamic shot array.
  - If model supports `Start/End Frame` → show image uploaders.
  - If model supports `Reference Video` → show video uploader.
  - If model supports `Quality Mode` → show quality selector.
  - If model supports `AI Sound Effects` → show toggle.
  - If model supports `Camera Controls` → show camera control panel.
  - Always show: Prompt, Duration controls (adapted to model's range), Aspect Ratio.
- **Dynamic Cost Display**: Updates live based on model + duration + quality.

### Backend (`/api/generate-video/route.ts`)
- Reads `model` from the request body.
- Uses a switch/map to determine the correct API endpoint, payload, and cost formula.
- Deducts credits, polls for completion, downloads video to Supabase Storage.

### Database
- `generations` table with `model` column (e.g., `kling-3.0`).
- `type = 'video'` for all video generations.

## Current Status
- [x] Kling 3.0 fully integrated with multi-shot, quality, sound, aspect ratio
- [ ] Add model selector UI to `/create-video`
- [ ] Refactor backend to support model switching
- [ ] Integrate next video model (TBD)
