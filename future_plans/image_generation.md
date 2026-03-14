# Image Generation Feature

## Overview
Allow users to generate images from text prompts using AI models. The platform supports **multiple image generation models**, and the UI and backend dynamically adapt to each model's unique capabilities.

## Architecture

### Multi-Model Support
The `/create-image` page includes a **Model Selector** at the top. When a model is selected, the UI dynamically shows/hides form fields based on that model's capabilities. The backend API route reads the selected `model` from the request and constructs the correct payload for that model's API.

### How to Add a New Image Model
1. Add the model's API documentation to `model_api_references/<model_name>.md`.
2. Add a new entry to the **Model Registry** below with all its capabilities.
3. The AI assistant (or developer) will use this registry + the API doc to update the frontend form and backend route.

---

## Model Registry

Each model entry defines its capabilities. The frontend reads these to show/hide UI elements. The backend reads these to construct the correct API payload and calculate cost.

### Model: `nano-banana-2` (Nano Banana 2.0)
- **Status**: ✅ Integrated
- **API Reference**: `model_api_references/nano_banana2.0.md`
- **Capabilities**: (Parsed from API reference)
  | Capability | Supported | Details |
  |---|---|---|
  | Text Prompt | ✅ | Follow API max character limit |
  | Reference Images | ✅ | Follow API max image count and size |
  | Aspect Ratios | ✅ | Parse allowed list directly from `model_api_references/nano_banana2.0.md` |
  | Resolution | ✅ | Parse allowed list directly from `model_api_references/nano_banana2.0.md` |
  | Output Format | ✅ | Parse allowed formats from API doc |
  | Google Search Grounding | ✅ | Boolean |
  | Negative Prompt | ❌ | — |
  | Style Presets | ❌ | — |
- **Dynamic Cost**:
  Calculate cost mapped linearly to compute-intensive parameters (e.g. resolution tiers) defined in the API doc.

### Model: `nano-banana-pro` (Nano Banana Pro)
- **Status**: ✅ Integrated
- **API Reference**: `model_api_references/nano-banana-pro.md`
- **Capabilities**: (Parsed from API reference)
  | Capability | Supported | Details |
  |---|---|---|
  | Text Prompt | ✅ | 20,000 character max |
  | Reference Images | ✅ | Up to 8 images, max 30MB each |
  | Aspect Ratios | ✅ | 11 options (no `1:4`, `1:8`, `4:1`, `8:1`) |
  | Resolution | ✅ | 1K / 2K / 4K |
  | Output Format | ✅ | PNG / JPG |
  | Google Search Grounding | ❌ | Not supported by this model |
  | Negative Prompt | ❌ | — |
  | Style Presets | ❌ | — |
- **Dynamic Cost**: Same as Nano Banana 2.0 — resolution-tiered (10 / 15 / 25 credits for 1K / 2K / 4K).

### Model: `[future-model-id]` (Example Placeholder)
- **Status**: 🔲 Not Yet Integrated
- **API Reference**: `model_api_references/[future_model].md`
- **Capabilities**:
  | Capability | Supported | Details |
  |---|---|---|
  | Text Prompt | ✅/❌ | Character limit |
  | Reference Images | ✅/❌ | Max count, max size |
  | Aspect Ratios | ✅/❌ | List of supported ratios |
  | Resolution | ✅/❌ | List of supported resolutions |
  | Output Format | ✅/❌ | Supported formats |
  | Google Search Grounding | ✅/❌ | — |
  | Negative Prompt | ✅/❌ | — |
  | Style Presets | ✅/❌ | List of presets |
- **Dynamic Cost**: Define cost formula based on the model's compute-intensive parameters.

---

## Technical Implementation

### Frontend (`/create-image/page.tsx`)
- **Model Selector**: Dropdown or card selector at the top of the page.
- **Dynamic Form**: Based on the selected model's capabilities:
  - If model supports `Reference Images` → show multi-image uploader with the model's max count.
  - If model supports `Google Search Grounding` → show toggle.
  - If model supports `Negative Prompt` → show a second text area.
  - If model supports `Style Presets` → show style picker.
  - Always show: Prompt, Aspect Ratio (filtered to model's list), Resolution (filtered to model's list).
- **Dynamic Cost Display**: Updates based on the selected model + resolution/quality.

### Backend (`/api/generate-image/route.ts`)
- Reads `model` from the request body.
- Uses a switch/map to determine:
  - The correct API endpoint and payload structure.
  - The dynamic cost calculation formula.
- Deducts credits via Supabase RPC.
- Polls for completion and persists output to Supabase Storage.

### Database
- `generations` table with `model` column storing the model ID (e.g., `nano-banana-2`).
- `type = 'image'` for all image generations.

## Current Status
- [x] Nano Banana 2.0 fully integrated with advanced features
- [x] Add model selector UI to `/create-image`
- [x] Refactor backend to support model switching
- [x] Nano Banana Pro integrated (no Google Search, 8-image limit)
