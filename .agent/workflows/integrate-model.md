---
description: Integrate a new AI Model API into the platform
---

# Integrate Model Workflow

Use this workflow when the user provides a new model API reference (e.g., `model_api_references/new_model.md`) and wants it integrated into the platform. The platform uses a **multi-model architecture** — each generation type (Image, Video, Motion Control) can host multiple AI models, and the UI + backend dynamically adapt to each model's capabilities.

## Step 1: Analyze the API Documentation

Read the provided API reference file thoroughly and identify:

1. **Generation Type**: Is this an image, video, or motion control model?
2. **Model ID**: The explicit identifier for the model.
3. **Parse Input Parameters**: *Do not assume or hardcode values.* Read the API documentation exclusively to extract:
   - Maximum character limits for prompts.
   - Exact supported array of aspect ratios.
   - Exact supported array of resolutions and qualities.
   - Allowable media inputs (Image? Video? Both? How many max?).
   - Special feature flags (Search layout, audios).
4. **API Endpoints**: Extract exact routes for task creation and status polling.
5. **Response Structure**: Determine where the result URL will manifest.

## Step 2: Update the Model Registry

Open the corresponding `future_plans/` file based on the generation type:
- Image → `future_plans/image_generation.md`
- Video → `future_plans/video_generation.md`
- Motion Control → `future_plans/motion_control.md`

Add a new **Model Registry entry** using the template in that file. Fill in:
- Model ID, name, status (✅ Integrated)
- API reference path
- Full capabilities table (✅/❌ for each capability with details)
- Dynamic cost formula

## Step 3: Backend API Route Integration

Modify the existing API route for this generation type:
- Image → `/api/generate-image/route.ts`
- Video → `/api/generate-video/route.ts`
- Motion Control → `/api/generate/route.ts`

Changes needed:
1. **Accept `model` in the request body** (if not already).
2. **Add a model config map/switch** that defines per model:
   - API endpoint URL and model identifier
   - Cost calculation function
   - Payload construction logic
3. **Dynamic cost calculation**: Read `future_plans/cost_calculation.md` and enforce a strict **1:1 mapping** between Kie.ai API token costs and app credits. Determine the cost dynamically based on the model's API pricing for compute-intensive parameters (resolution, duration, quality).
4. **Payload construction**: Build the exact JSON payload the API expects.
5. **Result handling**: Download the output from the external API and upload to Supabase Storage.
6. **Generation logging**: Store with the correct `model` identifier in the `generations` table.

## Step 4: Frontend UI Updates

Modify the existing page for this generation type:
- Image → `/create-image/page.tsx`
- Video → `/create-video/page.tsx`
- Motion Control → `/create-motion/page.tsx`

### 4a: Add the model to the page's Model Registry

Each page has an `IMAGE_MODELS` / `VIDEO_MODELS` / `MOTION_MODELS` registry object at the top of the file. Add a new entry with this structure:

```typescript
'new-model-id': {
    id: 'new-model-id',
    displayName: 'Model Display Name',
    description: 'Short one-line description',
    badge: 'New',                             // Badge label (e.g. 'Pro', 'Recommended', 'New')
    badgeColor: 'from-emerald-500 to-teal-500', // Tailwind gradient classes
    accentColor: 'emerald',                    // Key for accentStyles map
    maxImages: 8,                              // From API doc — max reference images
    supportsGoogleSearch: false,               // From API doc
    aspectRatios: ['1:1', '16:9', ...],        // Exact list from API doc
    resolutions: ['1K', '2K', '4K'],           // Exact list from API doc
    outputFormats: ['jpg', 'png'],             // Exact list from API doc
},
```

Also add a matching entry to the `accentStyles` map so button highlights, progress bars, and generate buttons use the new model's accent color.

### 4b: Model Selector Dropdown (already implemented)

The model selector is a **custom dropdown** (not the card grid) — this pattern is already in place on `/create-image/page.tsx`. Key pieces:

- **State & refs**: `isModelDropdownOpen` (boolean), `dropdownRef` (useRef for click-outside)
- **Imports**: `ChevronDown`, `Check` from lucide-react; `useRef` from react
- **Click-outside handler**: A `useEffect` that listens for `mousedown` and closes the dropdown if the click is outside `dropdownRef`
- **Dropdown button**: Shows the selected model's `displayName`, `badge`, `description`, and a rotating `ChevronDown`
- **Dropdown panel**: Wrapped in `AnimatePresence` for smooth open/close; lists all models with capability chips and a `Check` icon on the active one; selecting a model calls `setSelectedModel()` and closes the dropdown

When adding a new model, **no dropdown code changes are needed** — just adding the entry to the registry object is sufficient. The dropdown iterates `Object.values(...)` automatically.

### 4c: Dynamic Form Rendering

Based on the selected model's capabilities:
- Only show UI elements that the selected model supports (use `AnimatePresence` to animate show/hide).
- Adjust limits (e.g., max images, max prompt length, available aspect ratios) — the `useEffect` on `selectedModel` already clamps these.
- Update validation rules per model.

### 4d: Other

- **Dynamic Cost Display**: Recalculate and display cost when the model or its parameters change.
- **Send `model` field** in the API request body.

## Step 5: Hub Card Updates

If this is a brand-new generation type, unlock its card on the `/create` Hub page. If it's an additional model for an existing type, no hub changes needed.

## Step 6: Verification

// turbo
Run `npm run build` to verify no TypeScript or structural errors.

## Step 7: Finalize

1. Update the `future_plans/` file to mark the model status as `✅ Integrated`.
2. Summarize the changes in `walkthrough.md`.
3. Use `notify_user` to present the completed integration.
