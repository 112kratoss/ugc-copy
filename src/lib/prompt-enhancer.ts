// ─── Prompt Enhancement Engine ──────────────────────────────────────────────
// Uses Kie Gemini 3 Flash for model-specific prompt enhancement.
// System prompt is built in layers: base → medium → model → context.

export type Medium = 'image' | 'video' | 'motion';

// ─── Cost ───────────────────────────────────────────────────────────────────
export function getPromptEnhancementCost(): number {
    return 2;
}

// ─── System Prompt Layers ───────────────────────────────────────────────────

const BASE_SYSTEM_PROMPT = `You are a prompt enhancement specialist for AI media generation.

Your job is to take the user's raw prompt and rewrite it into an optimised, production-quality prompt for the specific AI model they are using.

Rules:
1. Preserve the user's original intent and subject matter exactly.
2. Do NOT add elements, subjects, or themes the user did not mention.
3. Add specificity: lighting, composition, mood, style, texture, and technical details that improve generation quality.
4. Output ONLY a single polished prompt string — no commentary, no bullet points, no explanations.
5. Keep the enhanced prompt concise but rich — aim for 1-3 sentences.
6. Write in natural descriptive English, not keyword lists.`;

const MEDIUM_PROMPTS: Record<Medium, string> = {
    image: `You are enhancing a prompt for AI IMAGE generation.
Focus on:
- Visual description: subject appearance, pose, expression
- Setting and environment details
- Composition and framing (close-up, wide shot, rule of thirds)
- Lighting and color palette (golden hour, dramatic shadows, soft diffused light)
- Art style or photographic style (cinematic, editorial, hyperrealistic, painterly)
- Texture and material quality`,

    video: `You are enhancing a prompt for AI VIDEO generation.
Focus on:
- Temporal flow: describe the action and movement over time
- Camera movement (tracking shot, slow zoom, dolly in, static)
- Scene continuity and transitions
- Motion dynamics (speed, fluidity, impact)
- Sound atmosphere if relevant (ambient, music, effects)
- Cinematic quality (film grain, depth of field, anamorphic)`,

    motion: `You are enhancing a prompt for AI MOTION TRANSFER / character animation.
Focus on:
- Motion quality: describe the movement the character should perform
- Identity preservation: ensure the character's appearance is maintained
- Reference-driven behaviour: align with the reference video's motion
- Temporal consistency: smooth transitions, no jitter or distortion
- Character body mechanics: natural joint movement, weight, balance
- Avoid over-specifying appearance — the character image provides that`,
};

const MODEL_ENHANCER_RULES: Record<string, string> = {
    'nano-banana-2': `Target model: Nano Banana 2 (fast image generation).
- This model responds well to concise, vivid scene descriptions.
- Emphasise subject, action, context (time/place), and style.
- Frame the shot explicitly if relevant (e.g., "close-up shot", "low-angle").
- Use positive framing (describe what should be there instead of "no X").
- If text rendering is requested, put the text exactly in quotes (e.g., "The text reads 'HELLO'").
- Keep prompts under 200 words for best results.`,

    'nano-banana-pro': `Target model: Nano Banana Pro (premium image generation).
- This model excels at photorealistic and highly detailed outputs.
- Be extremely specific: define the subject, action, intricate environment details, and visual style.
- Control composition and framing using photographic terms (e.g., "wide-angle view", "eye-level shot").
- Design lighting, color grading, and texture (e.g., "dramatic chiaroscuro lighting", "rough concrete texture").
- Use positive framing. For text rendering, use exact quotes (e.g., "The text reads 'SALE'").
- Google Search grounding is available — if the user mentions real locations/objects, be precise.`,

    'kling-3.0/video': `Target model: Kling 3.0 for video generation.
- Describe the scene as a continuous shot — start, middle, end.
- Specify camera behaviour explicitly (static, pan left, tracking).
- Keep prompts focused on a single coherent scene.
- Duration can be 5 or 10 seconds — pace the described action accordingly.
- Mention mood and atmosphere (tense, serene, energetic).`,

    'kling-2.6': `Target model: Kling 2.6 for motion transfer.
- This model transfers motion from a reference video onto a character image.
- CRUCIAL: Do NOT describe the motion itself (that comes from the reference video).
- Focus solely on describing the Character Attributes, Background/Environment, and Visual Style.
- Provide contextual guidance to help blend the character into the environment.
- Example: "A cyberpunk warrior standing in a neon-lit futuristic alleyway, rain pouring down, cinematic lighting."`,

    'kling-3.0': `Target model: Kling 3.0 for motion transfer (latest).
- Enhanced fidelity — produces highly accurate and cinematic motion replication.
- CRUCIAL: Do NOT over-describe motion. The reference video governs the action.
- Describe character identity, precise setting details, and cinematic color grades.
- The model handles nuance well: you can prompt for subtle facial clarity and emotional tones.
- Example: "A hyperrealistic astronaut on the dusty red surface of Mars, dramatic shadows, highly detailed portrait."`,
};

// ─── Prompt Builder ─────────────────────────────────────────────────────────

export interface EnhancerContext {
    // Image context
    modelId?: string;
    aspectRatio?: string;
    resolution?: string;
    googleSearch?: boolean;
    // Video context
    mode?: string;
    duration?: number;
    sound?: boolean;
    shotIndex?: number;
    // Motion context
    characterOrientation?: string;
}

export function buildEnhancerSystemPrompt(
    medium: Medium,
    selectedModel: string,
    context?: EnhancerContext
): string {
    const layers: string[] = [BASE_SYSTEM_PROMPT, MEDIUM_PROMPTS[medium]];

    const modelRules = MODEL_ENHANCER_RULES[selectedModel];
    if (modelRules) {
        layers.push(modelRules);
    }

    // Add context as constraints
    if (context) {
        const contextLines: string[] = ['Current generation settings:'];
        if (context.aspectRatio) contextLines.push(`- Aspect ratio: ${context.aspectRatio}`);
        if (context.resolution) contextLines.push(`- Resolution: ${context.resolution}`);
        if (context.mode) contextLines.push(`- Mode: ${context.mode}`);
        if (context.duration) contextLines.push(`- Duration: ${context.duration}s`);
        if (context.sound !== undefined) contextLines.push(`- Sound: ${context.sound ? 'enabled' : 'disabled'}`);
        if (context.shotIndex !== undefined) contextLines.push(`- This is shot #${context.shotIndex + 1} in a multi-shot sequence`);
        if (context.characterOrientation) contextLines.push(`- Character orientation: ${context.characterOrientation}`);
        if (context.googleSearch) contextLines.push(`- Google Search grounding is enabled`);

        if (contextLines.length > 1) {
            layers.push(contextLines.join('\n'));
        }
    }

    return layers.join('\n\n');
}

// ─── Supported Models ───────────────────────────────────────────────────────

export const SUPPORTED_ENHANCEMENT_MODELS = new Set([
    'nano-banana-2',
    'nano-banana-pro',
    'kling-3.0/video',
    'kling-2.6',
    'kling-3.0',
]);

// ─── Kie API Call ───────────────────────────────────────────────────────────

interface KieEnhancementResponse {
    enhancedPrompt: string;
}

export async function callPromptEnhancer(
    systemPrompt: string,
    userPrompt: string
): Promise<KieEnhancementResponse> {
    const apiKey = process.env.KIE_AI_API_KEY;
    if (!apiKey) {
        throw new Error('KIE_AI_API_KEY is not configured');
    }

    const response = await fetch('https://api.kie.ai/gemini-3-flash/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            messages: [
                {
                    role: 'system',
                    content: [{ type: 'text', text: systemPrompt }],
                },
                {
                    role: 'user',
                    content: [{ type: 'text', text: userPrompt }],
                },
            ],
            stream: false,
            include_thoughts: false,
            reasoning_effort: 'low',
        }),
    });

    if (!response.ok) {
        const errorBody = await response.text();
        console.error('[PromptEnhancer] Kie API error:', response.status, errorBody);
        throw new Error(`Kie API returned ${response.status}: ${errorBody}`);
    }

    const data = await response.json();

    const content = data?.choices?.[0]?.message?.content;
    if (!content || typeof content !== 'string') {
        console.error('[PromptEnhancer] Unexpected response shape:', JSON.stringify(data));
        throw new Error('Invalid response from Kie API: no content in choices');
    }

    return { enhancedPrompt: content.trim() };
}
