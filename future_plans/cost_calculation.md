# Cost & Credit Calculation

## Core Principle: 1:1 Parity with Kie.ai
The core rule for calculating generation costs across all models in this application is maintaining a strict **1:1 parity with Kie.ai tokens**. 

**1 Kie.ai Token = 1 In-App Credit**

We do not apply any arbitrary multipliers or markups on top of the base API cost. If Kie.ai charges 15 tokens for a 2K image generation, our application will deduct exactly 15 credits from the user's account.

## How to Determine Costs for a New Model

When integrating a new model (Image, Video, or Motion Control), you must determine its cost by reviewing the Kie.ai API documentation or pricing sheet for that specific model.

### 1. Static Cost Models (Images)
For models that charge a flat rate based on a specific parameter like resolution or quality:
- Read the API documentation to find the token cost per parameter.
- Map these directly in the backend route.
- Example (Nano Banana 2): 
  - 1K Resolution = 8 Tokens (Kie.ai) -> 8 In-App Credits ($0.04)
  - 2K Resolution = 12 Tokens (Kie.ai) -> 12 In-App Credits ($0.06)
  - 4K Resolution = 18 Tokens (Kie.ai) -> 18 In-App Credits ($0.09)
- Example (Nano Banana Pro): 
  - 1K/2K Resolution = 18 Tokens (Kie.ai) -> 18 In-App Credits ($0.09)
  - 4K Resolution = 24 Tokens (Kie.ai) -> 24 In-App Credits ($0.12)

### 2. Time-Based Cost Models (Video / Motion Control)
For models that charge based on the duration of the generated media:
- Find the "Tokens per Second" (or Tokens per frame) rate in the Kie.ai documentation.
- Calculate the total cost dynamically in the backend using the requested duration, model 'mode', and 'audio' flags.
- Example formula: `Total Cost = Requested Duration (seconds) * Tokens_Per_Second`
- Example (Kling 3.0 Video):
  - Standard (No Audio) = 20 Tokens/sec
  - Standard (With Audio) = 30 Tokens/sec
  - Pro (No Audio) = 27 Tokens/sec
  - Pro (With Audio) = 40 Tokens/sec

## Implementing Cost in the Backend
When building the Next.js API route (`/api/generate-...`), always apply the cost calculation *before* deducting credits from the Supabase database.

```typescript
// Example: Dynamic Time-Based Calculation (1:1 with Kie.ai Tokens)
const tokensPerSecond = mode === '1080p' ? 8 : 5;
const COST = Math.ceil(duration * tokensPerSecond);

// Deduct exactly the calculated tokens
const { data: remainingCredits, error } = await supabase.rpc('deduct_credits', {
    p_user_id: user.id,
    p_cost: COST
});
```

## Updating Documentation
Whenever a new model is integrated, its specific cost breakdown must be rigorously documented in the corresponding registry file (`future_plans/image_generation.md` or `future_plans/video_generation.md`) using this 1:1 token-to-credit mapping rule.
