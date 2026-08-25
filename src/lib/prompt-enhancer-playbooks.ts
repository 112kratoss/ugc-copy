/**
 * Per-model prompt-enhancement playbooks.
 *
 * One entry per prompt grammar. Content is sourced from the 2026-08-24 deep
 * research pass (official prompting guides first, Kie endpoint specs second,
 * labeled community consensus third) — see
 * docs/prompt-enhancer-playbooks-2026-08-24.md for the per-claim sources.
 *
 * Registry invariants (pinned by prompt-enhancer-playbook-contract.test.ts):
 * - every live model id resolves to a playbook, directly or via MODEL_ALIASES;
 * - aliases are reserved for true grammar twins (same provider family, same
 *   prompt dialect) — never a cross-provider approximation;
 * - every playbook carries a word budget and its own agent identity.
 */

export type Medium = 'image' | 'video' | 'motion' | 'audio';

export type PromptPlannerMode = 'legacy-text' | 'structured-image' | 'structured-video';

export type ImageCompilerProfile =
  | 'narrative'
  | 'design-brief'
  | 'labeled-sections'
  | 'caption-tail'
  | 'prose-photo'
  | 'intent-compact';

export type VideoCompilerProfile =
  | 'veo'
  | 'kling-shot'
  | 'seedance'
  | 'single-clip'
  | 'timeline'
  | 'bracket-camera';

export type CompilerProfile = ImageCompilerProfile | VideoCompilerProfile;

export interface AppliedPromptEnhancementSafeguard {
  code: string;
  message: string;
}

export interface EnhancerAgentSpec {
  id: string;
  label: string;
  strategyRules: string[];
  defaultSafeguards: AppliedPromptEnhancementSafeguard[];
}

export interface EnhancerPlaybookBudget {
  /** Soft range the LLM is instructed to hit. */
  targetWords: [number, number];
  /** Hard provider cap enforced by the compiler (sentence-trimmed, never mid-word). */
  maxChars?: number;
}

export interface EnhancerPlaybook {
  modelId: string;
  label: string;
  medium: Medium;
  plannerMode: PromptPlannerMode;
  compilerProfile?: CompilerProfile;
  budget: EnhancerPlaybookBudget;
  /**
   * 'always' — the endpoint generates audio unconditionally, so the prompt must
   * script the soundscape or explicitly silence it. 'optional' — audio exists
   * behind a toggle. 'none' — silent output.
   */
  audioBehavior?: 'always' | 'optional' | 'none';
  strategyRules: string[];
  workflowRules: string[];
  plannerNotes: string[];
  /** Shown only when the user prompt asks for readable in-image text. */
  textRenderingRules?: string[];
  agent: EnhancerAgentSpec;
}

const PRESERVE_INTENT_SAFEGUARD: AppliedPromptEnhancementSafeguard = {
  code: 'preserve_user_intent',
  message: 'Preserve the user intent and exact required wording.',
};

/**
 * Aliases are the enhance endpoint's allowlist extension: SUPPORTED_ENHANCEMENT_MODELS
 * is built from playbook keys plus these. Only true grammar twins belong here —
 * a model whose provider, prompt dialect, and constraint set match the target.
 */
export const MODEL_ALIASES: Record<string, string> = {
  // Catalog id → provider id spelling of the same model.
  'kling-3.0-video': 'kling-3.0/video',
  // Identical request schema and official grammar; pro is the fidelity tier.
  'qwen3-pro': 'qwen3',
  'wan-2.7-image-pro': 'wan-2.7-image',
  // Same one-shot caption grammar; fast/ultra are speed/quality tiers.
  'imagen-4-fast': 'imagen-4',
  'imagen-4-ultra': 'imagen-4',
  // Same schema and constraints as the fast tier; mini is the draft tier.
  'seedance-2-mini': 'seedance-2-fast',
};

// ─── Image playbooks ─────────────────────────────────────────────────────────

const IMAGE_PLAYBOOKS: Record<string, EnhancerPlaybook> = {
  'nano-banana-2': {
    modelId: 'nano-banana-2',
    label: 'Nano Banana 2',
    medium: 'image',
    plannerMode: 'structured-image',
    compilerProfile: 'narrative',
    budget: { targetWords: [50, 150] },
    strategyRules: [
      'Treat Nano Banana 2 like a clarity-first image model: keep the plan simple, concrete, and centered on one primary image idea.',
      'Open the subject with a strong operation intent (create, edit, combine, restyle) and cover subject, action, location, composition, and style as narrative prose — never keyword or tag lists.',
      'Specify the camera like a photographer: angle, framing, lens or focal length, and depth of field.',
      'Name the lighting setup and color grade concretely, and upgrade generic nouns to materials.',
      'Express every exclusion as positive framing ("empty street", not "no cars") — there is no negative-prompt field.',
      'If reference images are present, assign each a role by its app-given name and list only the anchored traits that must stay fixed.',
    ],
    workflowRules: [
      'If stillImageModel is nano-banana-2, write a narrative scene description with subject, action, location, composition, and style in that order.',
      'If stillImageModel is nano-banana-2 and text is required, state the exact words in quotes with a font description and placement.',
    ],
    plannerNotes: [
      'Capture subject, setting, framing, lighting, and the most important material or finish cues.',
      'Aim for 50–150 words once compiled; positive framing only.',
    ],
    textRenderingRules: [
      'If the user requests readable text, keep the exact words in quotes, describe the font style, and give a placement; never paraphrase the copy.',
    ],
    agent: {
      id: 'nano-banana-2-narrator',
      label: 'Nano Banana 2 narrator',
      strategyRules: [
        'Compose one flowing narrative paragraph — this is a reasoning model that parses instructions and plans composition.',
        'For edits, state the single change and then keep everything else exactly the same (style, lighting, composition).',
        'Only reference Google Search when grounding is enabled, and then instruct search, analysis, and the visual consequence explicitly.',
      ],
      defaultSafeguards: [PRESERVE_INTENT_SAFEGUARD],
    },
  },
  'nano-banana-2-lite': {
    modelId: 'nano-banana-2-lite',
    label: 'Nano Banana 2 Lite',
    medium: 'image',
    plannerMode: 'structured-image',
    compilerProfile: 'narrative',
    budget: { targetWords: [40, 100] },
    strategyRules: [
      'Treat Nano Banana 2 Lite as the fast iteration tier: one decisive visual idea, described in compact narrative prose.',
      'Keep composition, subject, and lighting explicit while avoiding dense modifier stacks.',
      'Never reference Google Search or live data — this tier has no grounding.',
      'Keep readable-text requests modest (short labels, not dense layouts) — output is 1K only.',
      'Express exclusions positively; there is no negative-prompt field.',
    ],
    workflowRules: [
      'If stillImageModel is nano-banana-2-lite, use a concise prompt with one clear subject, composition, and finish.',
    ],
    plannerNotes: ['Optimize for fast visual exploration and clean 1K output.'],
    textRenderingRules: [
      'If the user requests readable text, keep the exact words in quotes and limit it to one short label — 1K output limits legibility.',
    ],
    agent: {
      id: 'nano-banana-lite-drafter',
      label: 'Nano Banana Lite drafter',
      strategyRules: [
        'Bias toward shorter prompts than Nano Banana 2 — complex multi-constraint briefs belong on the Pro tier.',
      ],
      defaultSafeguards: [PRESERVE_INTENT_SAFEGUARD],
    },
  },
  'nano-banana-pro': {
    modelId: 'nano-banana-pro',
    label: 'Nano Banana Pro',
    medium: 'image',
    plannerMode: 'structured-image',
    compilerProfile: 'design-brief',
    budget: { targetWords: [100, 300] },
    strategyRules: [
      'Treat Nano Banana Pro like a higher-fidelity commercial image model with stronger layout, branding, and text rendering capability.',
      'Write a layered design brief: subject, composition, action, location, and style, plus three studio layers — lighting setup, camera/lens/f-stop, and color grade or film stock.',
      'For infographic or data work, state the factual constraints explicitly and name a visual register (technical diagram, editorial infographic).',
      'For brand work, describe applying supplied artwork onto objects following their curvature and lighting, and name what must stay pixel-faithful (faces, logos, label text).',
      'Never reference more than 8 images — that is the endpoint cap.',
      'Express exclusions positively; there is no negative-prompt field.',
    ],
    workflowRules: [
      'If stillImageModel is nano-banana-pro, write a richer prompt with precise composition, materials, finish, and commercial polish.',
      'If stillImageModel is nano-banana-pro and text matters, include the exact copy plus per-line typography and placement so the layout stays legible and brand-safe.',
    ],
    plannerNotes: [
      'Use the plan to structure premium layouts, poster-style compositions, and reference-led product work.',
      'A 100–300 word compiled brief is normal here — layered constraints are rewarded, filler is not.',
    ],
    textRenderingRules: [
      'Quote every piece of in-image copy verbatim and give each line its own font description, weight, and placement.',
      'For multilingual assets, name the source and target languages and ask to translate the text inside the image while keeping the quoted source intact.',
    ],
    agent: {
      id: 'nano-banana-pro-art-director',
      label: 'Nano Banana Pro art director',
      strategyRules: [
        'Prioritize identity, product design, packaging, and brand consistency over novel invention when references are attached.',
        'Reason about layout for the chosen aspect ratio (for example, leave clear headline space on 9:16) without restating the ratio itself.',
      ],
      defaultSafeguards: [PRESERVE_INTENT_SAFEGUARD],
    },
  },
  'imagen-4': {
    modelId: 'imagen-4',
    label: 'Imagen 4',
    medium: 'image',
    plannerMode: 'structured-image',
    compilerProfile: 'caption-tail',
    budget: { targetWords: [30, 80], maxChars: 1800 },
    strategyRules: [
      'Treat Imagen 4 as a one-shot caption model: a single descriptive sentence in the order subject, context, style — followed by a comma-separated modifier tail.',
      'Open by declaring the medium ("A photo of…", "A watercolor illustration of…").',
      'Keyword tails are correct here (unlike the Gemini image models): camera, lens, lighting, film and quality words act as a quality slider.',
      'Pick the lens from the photography cheat sheet: portraits 24–35mm prime, product macro 60–105mm, action telephoto, landscape wide-angle.',
      'English only — translate the user prompt if needed; describe the final image, never give instructions or conversation.',
      'This model takes no reference images: keep the description fully self-contained.',
    ],
    workflowRules: [
      'If stillImageModel is imagen-4, imagen-4-fast, or imagen-4-ultra, write one caption sentence declaring the medium first, then a comma-separated modifier tail.',
    ],
    plannerNotes: [
      'Keep the compiled caption well under 480 tokens; 30–80 words is the sweet spot.',
    ],
    textRenderingRules: [
      'Limit in-image text to at most three quoted phrases of 25 characters or fewer with a generic font-style hint — steer bigger text jobs to Nano Banana Pro.',
    ],
    agent: {
      id: 'imagen-4-captioner',
      label: 'Imagen 4 captioner',
      strategyRules: [
        'Iterate by appending detail to the previous caption rather than rewriting it wholesale.',
      ],
      defaultSafeguards: [PRESERVE_INTENT_SAFEGUARD],
    },
  },
  'gpt-image-2': {
    modelId: 'gpt-image-2',
    label: 'GPT Image 2',
    medium: 'image',
    plannerMode: 'structured-image',
    compilerProfile: 'labeled-sections',
    budget: { targetWords: [60, 250] },
    strategyRules: [
      'Treat GPT Image 2 like a high-instruction-following image model that also rewrites prompts internally — deliver a compact, unambiguous brief, not flowery elaboration.',
      'Structure the brief as labeled sections in the official order: scene, subject, key details, use case, constraints.',
      'Always state the intended use (ad, product mockup, thumbnail, infographic) — it steers the polish level.',
      'Always end with a constraints line, at minimum: no watermark, no extra text.',
      'For edits, give one imperative change plus a full preserve list (face, pose, lighting, framing, background, text, layout), and repeat the same preserve list verbatim on every iteration.',
      'Photorealism comes from candid photography language and named imperfections, never from quality-word spam.',
    ],
    workflowRules: [
      'If stillImageModel is gpt-image-2, write a labeled brief with scene, subject, details, use case, and a closing constraints line.',
      'If stillImageModel is gpt-image-2 and text matters, quote the exact copy with font style and placement.',
    ],
    plannerNotes: [
      'The compiler emits labeled sections; keep each field crisp — ambiguity, not brevity, is the enemy here.',
    ],
    textRenderingRules: [
      'Put literal text in quotes with a font style and placement; letter-spell tricky brand names the model tends to fumble.',
    ],
    agent: {
      id: 'gpt-image-2-brief-writer',
      label: 'GPT Image 2 brief writer',
      strategyRules: [
        'For identity or product edits, explicitly lock face, skin tone, body, pose, logo, and label.',
        'Constraints belong in prose — this model has no negative-prompt parameter.',
      ],
      defaultSafeguards: [PRESERVE_INTENT_SAFEGUARD],
    },
  },
  'seedream-5-pro': {
    modelId: 'seedream-5-pro',
    label: 'Seedream 5 Pro',
    medium: 'image',
    plannerMode: 'structured-image',
    compilerProfile: 'design-brief',
    budget: { targetWords: [80, 300], maxChars: 4800 },
    strategyRules: [
      'Treat Seedream 5 Pro as a production image model for realistic people, products, multilingual typography, and precise edits.',
      'Lead with the deliverable format ("vertical product hero shot for an ad") — omitting it defaults the model into generic portrait photography.',
      'Layer the brief as format, subject, composition, lighting, in-image text, style — flowing natural language, never comma keyword lists.',
      'Pin clauses must be concrete: name the exact silhouette, camera angle, backdrop, and lighting to keep — never "keep it the same".',
      'For realism, ask for flaws (subtle sensor noise, natural skin texture, no beauty filter) — the lighting clause is the highest-leverage sentence.',
      'With multiple references, describe each by content ("the sneaker from the white-background image") and give it one role; Image 1/Image 2 indexing works for swaps.',
    ],
    workflowRules: [
      'If stillImageModel is seedream-5-pro, write a production-ready layered brief with format, subject, composition, lighting, and style.',
    ],
    plannerNotes: [
      'A server-side optimizer already expands prompts — precision over volume.',
      'Pass any coordinate tags in the user prompt through untouched.',
    ],
    textRenderingRules: [
      'Preserve the exact copy in quotes with placement and type style; keep the user’s script verbatim — this model renders native text in 14+ languages.',
    ],
    agent: {
      id: 'seedream-5-production-designer',
      label: 'Seedream 5 production designer',
      strategyRules: [
        'One imperative per edit with a uniquely named target and no pronouns.',
        'Never write "4K" or "8K" as a resolution ask — resolution is a parameter; those words only shift style.',
      ],
      defaultSafeguards: [PRESERVE_INTENT_SAFEGUARD],
    },
  },
  'seedream-5-lite': {
    modelId: 'seedream-5-lite',
    label: 'Seedream 5 Lite',
    medium: 'image',
    plannerMode: 'structured-image',
    compilerProfile: 'design-brief',
    budget: { targetWords: [60, 250], maxChars: 2900 },
    strategyRules: [
      'Treat Seedream 5 Lite as the volume tier of the Seedream family: same layered-brief grammar as Pro with a tighter budget.',
      'Never emit coordinate tags or layer-decomposition asks — those are Pro-only; name regions in words instead ("in the lower-left corner").',
      'For sets or carousels, enumerate scenes explicitly ("Generate four images: Scene 1… Scene 2…") and end with a shared style clause.',
      'For multi-reference edits, index references as Image 1/Image 2 in upload order with one mapping sentence each; favor five or fewer references.',
      'Express exclusions inline and positively.',
    ],
    workflowRules: [
      'If stillImageModel is seedream-5-lite, write a compact layered brief with format, subject, composition, lighting, and style.',
    ],
    plannerNotes: ['Its higher-resolution tiers make it the typography workhorse — quoted copy renders well at 4K.'],
    textRenderingRules: [
      'Quote the exact copy with placement; keep the user’s script verbatim for multilingual text.',
    ],
    agent: {
      id: 'seedream-5-lite-designer',
      label: 'Seedream 5 Lite designer',
      strategyRules: [
        'Keep edits surgical: verb, uniquely described target, and a concrete keep-clause.',
      ],
      defaultSafeguards: [PRESERVE_INTENT_SAFEGUARD],
    },
  },
  'flux-2-pro': {
    modelId: 'flux-2-pro',
    label: 'FLUX.2 Pro',
    medium: 'image',
    plannerMode: 'structured-image',
    compilerProfile: 'prose-photo',
    budget: { targetWords: [30, 120], maxChars: 4800 },
    strategyRules: [
      'Treat FLUX.2 Pro as a photographer-brief model: plain prose with the subject first — it weights early tokens most.',
      'Order the brief subject, action, style, context; 30–80 words is the official sweet spot.',
      'Exactly one detailed lighting clause (direction, quality, temperature) — the highest-impact sentence in the prompt.',
      'For photorealism add a camera body, focal length, aperture, and optionally a film stock, plus skin-texture or grain cues for people.',
      'Convert every negative into a positive state — negation backfires on this model and there is no negative-prompt field.',
      'Break its center bias and shallow-depth-of-field bias explicitly when needed ("lower-left third, f/8 deep focus").',
      'With references, assign each image a role and identify it by attribute and index ("the woman with red hair, image 1"); never leave a reference unassigned.',
    ],
    workflowRules: [
      'If stillImageModel is flux-2-pro, emphasize photoreal detail, one lighting clause, camera language, and clear reference roles.',
    ],
    plannerNotes: [
      'Bind brand colors as hex codes to named objects when the user supplies them.',
      'Never emit tag lists, prompt-weighting syntax, or quality-word spam.',
    ],
    textRenderingRules: [
      'Put the exact words in quotes with a type style and placement — unquoted described text renders as gibberish.',
    ],
    agent: {
      id: 'flux-2-photographer',
      label: 'FLUX.2 photographer',
      strategyRules: [
        'No contradictory directions (bright sunny day with moody dramatic shadows) — pick one coherent look.',
      ],
      defaultSafeguards: [PRESERVE_INTENT_SAFEGUARD],
    },
  },
  'z-image': {
    modelId: 'z-image',
    label: 'Z-Image',
    medium: 'image',
    plannerMode: 'structured-image',
    compilerProfile: 'prose-photo',
    budget: { targetWords: [60, 140], maxChars: 990 },
    strategyRules: [
      'Treat Z-Image as a prompt-only economy model with a hard 1,000-character cap: one dense natural-language paragraph.',
      'Name the medium first ("photorealistic photo", "35mm film still") or output lands between photo and illustration.',
      'Lock the user’s immutable core exactly: subject, quantity, action, named IP, colors, and any text.',
      'If the request is a task ("design a…"), reason out one concrete visual solution and describe that.',
      'Spend the budget on lighting and camera language — its documented strengths.',
      'State constraints positively; a negative prompt does not exist at the model level and meta-tags like "8K" or "masterpiece" are prohibited.',
      'This endpoint takes no reference images — strip any "like the attached image" phrasing into explicit description.',
    ],
    workflowRules: [
      'If stillImageModel is z-image, write one self-contained paragraph under 1,000 characters with the medium named first.',
    ],
    plannerNotes: ['The compiler hard-trims to the character cap — front-load what matters.'],
    textRenderingRules: [
      'Quote in-image text verbatim; English and Chinese both render well — keep it to one clear placement.',
    ],
    agent: {
      id: 'z-image-economist',
      label: 'Z-Image economist',
      strategyRules: [
        'Trim aesthetics before trimming the subject when the budget is tight.',
      ],
      defaultSafeguards: [PRESERVE_INTENT_SAFEGUARD],
    },
  },
  'grok-imagine-image': {
    modelId: 'grok-imagine-image',
    label: 'Grok Imagine',
    medium: 'image',
    plannerMode: 'structured-image',
    compilerProfile: 'prose-photo',
    budget: { targetWords: [30, 80] },
    strategyRules: [
      'Treat Grok Imagine like a photographer-brief model: 30–80 words of flowing prose with the subject in the first five words.',
      'Exactly one lighting clause (direction, softness, temperature) — never several competing ones.',
      'For realism, add one camera/lens/aperture clause and one imperfection cue (visible skin texture, slight film grain).',
      'Strip all negatives and restate them as positive states ("sharp focus", not "no blur") — negatives are ignored entirely.',
      'Each call returns multiple images, so favor a single clear concept over hedged multi-concept prompts.',
      'For edits, give one imperative change referencing @image1, then keep everything else exactly the same; never re-describe the whole image.',
    ],
    workflowRules: [
      'If stillImageModel is grok-imagine-image, write a direct photographic prompt with one strong visual idea and clear reference preservation.',
    ],
    plannerNotes: ['No quality-word spam — it wastes front-token attention.'],
    textRenderingRules: [
      'Keep exact words in quotes with a simple placement, and keep expectations low — steer text-heavy jobs to a typography model.',
    ],
    agent: {
      id: 'grok-imagine-photographer',
      label: 'Grok Imagine photographer',
      strategyRules: [
        'In edit mode never mention aspect ratio — the parameter does not exist there.',
      ],
      defaultSafeguards: [PRESERVE_INTENT_SAFEGUARD],
    },
  },
  'grok-imagine-image-2': {
    modelId: 'grok-imagine-image-2',
    label: 'Grok Imagine 2',
    medium: 'image',
    plannerMode: 'structured-image',
    compilerProfile: 'design-brief',
    budget: { targetWords: [60, 200] },
    strategyRules: [
      'Treat Grok Imagine 2 as a precision design model: write a dense multi-part design brief, not a scene caption — it honors subject, layout, exact wording, and lighting simultaneously.',
      'Order the brief deliverable and subject, then layout zones ("headline across the top third", "five numbered steps down the left side"), then exact text, then style, then one lighting clause.',
      'Specify typographic hierarchy explicitly (headline, subhead, small print) — the model plans layout like a designer.',
      'Dense specificity is rewarded here, but every clause must be concrete; describe the clean state ("generous whitespace") instead of negations.',
      'This route is text-to-image only: strip any "like the reference" language or route the request to a reference-capable model.',
    ],
    workflowRules: [
      'If stillImageModel is grok-imagine-image-2, write a designer-style layout brief with zones, quoted copy, and type-style words.',
    ],
    plannerNotes: ['Preserve the user’s wording character-for-character in every quoted string.'],
    textRenderingRules: [
      'Every piece of on-image copy goes in quotes, verbatim, with a placement and a type-style word (bold serif, heavy sans, script).',
    ],
    agent: {
      id: 'grok-imagine-2-layout-designer',
      label: 'Grok Imagine 2 layout designer',
      strategyRules: [
        'For photorealism requests camera language still helps, but this model’s edge is composition and typography — lean layout-first.',
      ],
      defaultSafeguards: [PRESERVE_INTENT_SAFEGUARD],
    },
  },
  'qwen3': {
    modelId: 'qwen3',
    label: 'Qwen Image 3.0',
    medium: 'image',
    plannerMode: 'structured-image',
    compilerProfile: 'design-brief',
    budget: { targetWords: [80, 200], maxChars: 4800 },
    strategyRules: [
      'Treat Qwen Image like its own official enhancer does: preserve the user’s meaning exactly, then refine subject characteristics, spatial relationships, composition, and lighting.',
      'Choose exactly one precise niche style; default to realistic photography when unspecified.',
      'If the user’s in-image text intent is vague ("a sign with a slogan"), invent the concrete string and quote it — but never add text the user did not request at all.',
      'Match the output language to the input language (Chinese stays Chinese, everything else becomes English).',
      'Strip all negation words and restate them as the positive alternative — an official rule for this family.',
      'For edits, use one task-typed imperative (add, delete, replace, restyle) stating category, color, size, and position, plus a keep-clause; address multiple references as "Picture 1", "Picture 2" in upload order.',
      'Long sectioned layout specs are justified only for posters, infographics, and UI — its headline strength.',
    ],
    workflowRules: [
      'If stillImageModel is qwen3 or qwen3-pro, write a layered natural-language brief with subject, scene, composition, lighting, and one named style.',
    ],
    plannerNotes: [
      'A server-side extender already expands short prompts — deliver final-form precision so it has nothing to invent.',
    ],
    textRenderingRules: [
      'Enclose in-image text in quotes with a position (top-left, bottom-right) and a described type style; never translate or reword quoted text.',
    ],
    agent: {
      id: 'qwen-image-calligrapher',
      label: 'Qwen Image calligrapher',
      strategyRules: [
        'Describe the image itself, never meta-instructions ("generate an image of…").',
      ],
      defaultSafeguards: [PRESERVE_INTENT_SAFEGUARD],
    },
  },
  'wan-2.7-image': {
    modelId: 'wan-2.7-image',
    label: 'Wan 2.7 Image',
    medium: 'image',
    plannerMode: 'structured-image',
    compilerProfile: 'design-brief',
    budget: { targetWords: [80, 200], maxChars: 4800 },
    strategyRules: [
      'Treat Wan 2.7 Image as a layered-brief model: subject, scene, composition, lighting, style in natural language.',
      'Address every reference strictly positionally in upload order — "the alarm clock from image 1", "onto the car in image 2" — never "the first photo".',
      'Append a preservation clause to every edit naming what must not change (identity, lighting, camera angle, composition).',
      'Never write "the marked area" — no regions are marked on this route; name regions in words ("the top-left corner", "the bowl’s contents").',
      'There is no negative prompt and no server-side rewriter on this route — the enhancer does all the reasoning: resolve vague requests into one concrete pictured plan.',
      'For extreme banner ratios, lead with the format ("ultra-wide 8:1 website banner…").',
    ],
    workflowRules: [
      'If stillImageModel is wan-2.7-image or wan-2.7-image-pro, write a layered brief and address references as image 1, image 2 in order.',
    ],
    plannerNotes: ['Editing caps at 2K — never promise 4K behaviors in edit prompts.'],
    textRenderingRules: [
      'Quote the exact copy with placement and a described font — text renders in 12 languages; keep the user’s script verbatim.',
    ],
    agent: {
      id: 'wan-image-compositor',
      label: 'Wan Image compositor',
      strategyRules: [
        'Give each reference exactly one role and state spatial relations between composited elements.',
      ],
      defaultSafeguards: [PRESERVE_INTENT_SAFEGUARD],
    },
  },
  'ideogram-v3': {
    modelId: 'ideogram-v3',
    label: 'Ideogram v3',
    medium: 'image',
    plannerMode: 'structured-image',
    compilerProfile: 'intent-compact',
    budget: { targetWords: [40, 150] },
    strategyRules: [
      'Treat Ideogram v3 as a typography-first design model whose server-side Magic Prompt is on: stay compact and intent-dense — your job is precision, the server adds embellishment.',
      'Open with the artifact type ("Poster design…", "Minimalist logo…") — the model treats it as a layout directive — and keep exactly one style direction.',
      'Main ideas go first: earlier content is weighted more heavily.',
      'Never use negation phrasing; describe the desired state ("empty street", "plain white background").',
      'Keep scenes visually simple around text, and skip camera or lens jargon on flat design work.',
      'For remix runs with a reference, re-describe the desired result and what to keep — not an edit command.',
    ],
    workflowRules: [
      'If stillImageModel is ideogram-v3, open with the artifact type and one style direction, with quoted copy early.',
    ],
    plannerNotes: [
      'Era-named type descriptions ("1970s slab serif") land better than "modern" or "clean".',
    ],
    textRenderingRules: [
      'Quote each text string verbatim and early, each with a placement and a described (never named) type style.',
      'Keep each text block to 1–4 words and use at most three blocks; prefer English strings — non-Latin scripts are unreliable.',
    ],
    agent: {
      id: 'ideogram-v3-typographer',
      label: 'Ideogram typographer',
      strategyRules: [
        'For logos use flat vector language, a limited palette, and a plain background.',
      ],
      defaultSafeguards: [PRESERVE_INTENT_SAFEGUARD],
    },
  },
  'ideogram-character': {
    modelId: 'ideogram-character',
    label: 'Ideogram Character',
    medium: 'image',
    plannerMode: 'structured-image',
    compilerProfile: 'intent-compact',
    budget: { targetWords: [40, 120] },
    strategyRules: [
      'Treat Ideogram Character as a consistency model where the reference owns the face and hair: never re-describe facial identity — write "the character".',
      'Always specify the five things the reference cannot supply: action or pose, setting, outfit, expression, and lighting or framing.',
      'Hair sits inside the identity mask, so changing it needs an explicit instruction ("now with her hair in a bun").',
      'One character per generation — strip requests for a second consistent character.',
      'Add exactly one style cue matching the reference’s realism unless the user asks to restyle.',
      'For a UGC series, repeat the same outfit descriptor in every shot — outfit consistency comes from your words, not the reference.',
    ],
    workflowRules: [
      'If stillImageModel is ideogram-character, pair "the character" with action, setting, outfit, expression, and lighting — never re-describe the face.',
    ],
    plannerNotes: ['Magic Prompt is on — keep it compact and let the server fill atmosphere.'],
    textRenderingRules: [
      'Same typography rules as Ideogram v3, but keep text minimal in character shots.',
    ],
    agent: {
      id: 'ideogram-character-director',
      label: 'Ideogram character director',
      strategyRules: [
        'Positive phrasing only; scene-only prompts underperform — always pair subject and context.',
      ],
      defaultSafeguards: [PRESERVE_INTENT_SAFEGUARD],
    },
  },
};

// ─── Video playbooks ─────────────────────────────────────────────────────────

const VIDEO_PLAYBOOKS: Record<string, EnhancerPlaybook> = {
  'kling-3.0/video': {
    modelId: 'kling-3.0/video',
    label: 'Kling 3.0 Video',
    medium: 'video',
    plannerMode: 'structured-video',
    compilerProfile: 'kling-shot',
    budget: { targetWords: [60, 200] },
    audioBehavior: 'optional',
    strategyRules: [
      'Treat Kling 3.0 like a cinematic shot engine: prose scene-direction in the official order — scene, subject, sequential visible action, camera, lighting, atmosphere.',
      'Exactly one camera move per shot, named with framing, direction, and speed ("slow push-in") — the bare word "cinematic" without a concrete instruction is a named anti-pattern.',
      'Chain actions chronologically with "then", "as", or "while"; never stack simultaneous verbs.',
      'In multi-shot work keep every shot to one beat of 2–4 seconds, and repeat the subject descriptors word-for-word across shots.',
      'When sound is enabled, write dialogue as a bracketed speaker tag with tone — [Role, tone] says: "line" — bind an action to the speaker first, and never use pronouns for speakers.',
      'If frames are attached, describe only what changes from the frame plus the camera path.',
      'Fold avoidances into positive phrasing — there is no negative-prompt field.',
    ],
    workflowRules: [
      'If primaryModel is kling-3.0-video, write cinematic shot prompts with clear camera direction, atmosphere, and continuity.',
      'If primaryModel is kling-3.0-video in multi-shot mode, make every shot stand on its own while preserving recurring subject and style anchors.',
    ],
    plannerNotes: [
      'For single-shot, keep the plan focused on one premium scene.',
      'For multi-shot with a current shot index, plan the sequence lightly but go deepest on the current shot.',
      'Overpacking is the top multi-shot failure: at most two named subjects and one beat per shot.',
    ],
    agent: {
      id: 'kling-video-director',
      label: 'Kling video director',
      strategyRules: [
        'Build prompts as filmable shot directions: subject, precise motion, scene, camera/framing, lighting/atmosphere, and audio when sound is enabled.',
        'For image-to-video, let the frame carry appearance and focus the prompt on movement, camera path, and environmental motion.',
        'For multi-shot, keep each shot self-contained, duration-aware, and continuity-safe; avoid overloading short shots with multiple story beats.',
        'When sound is enabled, use speaker-tag dialogue and the word "Immediately" for fast turn-taking between speakers.',
      ],
      defaultSafeguards: [
        { code: 'duration_aware_motion', message: 'Keep Kling motion simple enough for the selected duration.' },
        { code: 'shot_continuity', message: 'Preserve recurring subject and scene anchors across Kling shots.' },
      ],
    },
  },
  'kling-3.0-turbo': {
    modelId: 'kling-3.0-turbo',
    label: 'Kling 3.0 Turbo',
    medium: 'video',
    plannerMode: 'structured-video',
    compilerProfile: 'single-clip',
    budget: { targetWords: [50, 150], maxChars: 2300 },
    audioBehavior: 'none',
    strategyRules: [
      'Treat Kling 3.0 Turbo as a single-shot speed tier: one scene, one continuous action arc, one camera move — never a shot list.',
      'Always include explicit motion unfolding over time; a purely static description is its top failure mode.',
      'This route has no audio: never write dialogue expecting sound — if speech matters, describe it visually ("she mouths the words") or route to a sound-capable Kling tier.',
      'Match action scope to duration: one beat under 6 seconds, at most two beats above 8.',
      'Keep subject wardrobe and appearance details tight — the speed tier drifts on long prompts.',
      'Fold avoidances into positives ("steady framing, clean background"); there is no negative field.',
    ],
    workflowRules: [
      'If primaryModel is kling-3.0-turbo, write one single-scene prompt with one action arc and one named camera move.',
    ],
    plannerNotes: ['Iterate here, then re-render hero shots on Kling 3.0 Pro with the same prompt.'],
    agent: {
      id: 'kling-turbo-sprinter',
      label: 'Kling Turbo sprinter',
      strategyRules: [
        'For image-to-video, prompt only the delta from the start frame: motion, expression, camera, environmental change.',
      ],
      defaultSafeguards: [
        { code: 'single_clip_focus', message: 'Keep Turbo prompts to one scene, one action arc, one camera move.' },
      ],
    },
  },
  'kling-o3': {
    modelId: 'kling-o3',
    label: 'Kling O3',
    medium: 'video',
    plannerMode: 'structured-video',
    compilerProfile: 'kling-shot',
    budget: { targetWords: [60, 220], maxChars: 3000 },
    audioBehavior: 'optional',
    strategyRules: [
      'Treat Kling O3 as the omni shot-list engine: prefix shots as "Shot 1 (2s):" with "Cut to" transitions, and give each shot one beat and one camera instruction.',
      'Reference every named subject as @Name spelled exactly as its element name; introduce each subject in its first shot with a minimal role phrase, then keep the mention verbatim.',
      'Element references carry appearance — never re-litigate wardrobe or looks the references already pin.',
      'Write inline dialogue as @Name says, "line" with a tone adverb, and add a per-shot Audio: line for ambience or effects when sound is on.',
      'In reference mode give every reference one job ("background", "style") — unassigned references blend.',
      'Trim adjectives before trimming structure — the prompt cap is tight for a shot list.',
    ],
    workflowRules: [
      'If primaryModel is kling-o3, write labeled shots with @element mentions, one beat and one camera move each, plus per-shot audio cues.',
    ],
    plannerNotes: [
      'At most two named subjects and four shots for reliable pacing at 15 seconds.',
      'Durations across shots must sum to the selected total.',
    ],
    agent: {
      id: 'kling-o3-showrunner',
      label: 'Kling O3 showrunner',
      strategyRules: [
        'Fold avoidances into positive phrasing; there is no negative-prompt field.',
      ],
      defaultSafeguards: [
        { code: 'element_names_verbatim', message: 'Keep @element names spelled exactly as registered.' },
      ],
    },
  },
  'veo-3.1': {
    modelId: 'veo-3.1',
    label: 'Veo 3.1',
    medium: 'video',
    plannerMode: 'structured-video',
    compilerProfile: 'veo',
    budget: { targetWords: [60, 150] },
    audioBehavior: 'always',
    strategyRules: [
      'Treat Veo 3.1 like a one-scene-per-clip model: do not chain multiple distinct events into one short prompt.',
      'Write flowing prose in the official order — camera, subject, action, context, style and ambiance — with one primary subject; demote everything else to background.',
      'Use exactly one camera-movement term and one framing term from the trained vocabulary (dolly, tracking, crane, slow pan, POV; wide shot, close-up, low angle).',
      'Avoid quotation marks for dialogue. If speech is needed, structure it as Character says: line — and append (no subtitles).',
      'Always script the audio: dialogue if any, then SFX and ambient noise cues — unspecified audio gets invented by the model.',
      'A server-side rewriter always runs on Veo: fill the slots precisely and give it nothing to invent — no padding.',
      'If continuity matters across shots, repeat only the necessary recurring character or product anchors.',
    ],
    workflowRules: [
      'If primaryModel is veo-3.1, keep every clip focused on one scene with explicit subject, action, context, camera, and ambience.',
      'If primaryModel is veo-3.1 and dialogue matters, describe it without quoted speech so the model does not try to render on-screen text.',
    ],
    plannerNotes: [
      'For multi-shot, the planner may produce a shot list, but the final compiled prompt should only emit the current shot unless no shot index is available.',
      'For image-to-video, emphasize motion between frames, not static frame redescription.',
      'Cap speech at roughly fifteen words per 8-second clip.',
      'Put the spoken line only in the dialogue field — never repeat it inside action or shot fields.',
    ],
    agent: {
      id: 'veo-31-director',
      label: 'Veo 3.1 director',
      strategyRules: [
        'Use a director-style structure: cinematography, subject, action, context, style/ambience, and audio.',
        'Keep every short clip focused on one moment; split complex sequences instead of chaining many events.',
        'For first/last frames, describe the transition mechanics, continuity, and camera path between frames.',
        'Write dialogue as speaker-attributed lines without quotation marks to reduce accidental rendered text.',
      ],
      defaultSafeguards: [
        { code: 'one_scene_per_clip', message: 'Keep Veo prompts focused on one clear scene or transition.' },
        { code: 'dialogue_without_quotes', message: 'Avoid quoted dialogue in Veo prompts.' },
      ],
    },
  },
  'gemini-omni-video': {
    modelId: 'gemini-omni-video',
    label: 'Gemini Omni Video',
    medium: 'video',
    plannerMode: 'structured-video',
    compilerProfile: 'single-clip',
    budget: { targetWords: [40, 120] },
    audioBehavior: 'always',
    strategyRules: [
      'Treat Gemini Omni as a multimodal editor that multi-shots by default: unless the user asks for a montage, open with "In a single unbroken scene".',
      'Cover the six dimensions briefly — shot framing and motion, style, lighting, location, action, and on-screen text or its absence; structure beats length.',
      'Camera words act as technical commands here: push in, locked off, dolly zoom, orbit — one movement per shot.',
      'When a reference video is attached, write an edit instruction, not a scene description: one change plus "Keep everything else the same."',
      'Describe the soundtrack in prose and state "No dialogue" when none is wanted; put negatives in plain prose — there is no negative-prompt field.',
      'Refer to attached imagery by role ("starting from the supplied first frame") and describe only what changes and moves.',
    ],
    workflowRules: [
      'If primaryModel is gemini-omni-video, cover framing, style, lighting, location, action, and audio in a few structured sentences.',
    ],
    plannerNotes: [
      'Timing cues use natural language ("after 3 seconds…") matched to the chosen duration.',
      'Name one primary subject and keep it the stated focus of the clip.',
    ],
    agent: {
      id: 'gemini-omni-editor',
      label: 'Gemini Omni editor',
      strategyRules: [
        'It infers better than it imagines — references beat adjectives; restraint wins.',
      ],
      defaultSafeguards: [
        { code: 'single_scene_default', message: 'Force a single unbroken scene unless a montage is requested.' },
      ],
    },
  },
  'seedance-1.5-pro': {
    modelId: 'seedance-1.5-pro',
    label: 'Seedance 1.5 Pro',
    medium: 'video',
    plannerMode: 'structured-video',
    compilerProfile: 'seedance',
    budget: { targetWords: [60, 200] },
    audioBehavior: 'optional',
    strategyRules: [
      'Treat Seedance 1.5 Pro like a layered video prompt model: subject, movement, environment, camera, style, and sound, each explicit.',
      'Quantify motion with degree adverbs and body parts ("first rotates slowly, then stops"); externalize emotion as physical behavior, never abstractions.',
      'Write camera moves as start-frame, movement with amplitude, end-frame — one instruction per shot.',
      'Use fixed-lens guidance when the camera must stay static ("fixed camera, static shot") and strip every movement verb; otherwise describe camera motion deliberately.',
      'Only script dialogue, effects, or music when audio is enabled; give speakers a description, a delivery note, and a named language for anything beyond English or Chinese.',
      'Sequence multi-shot work as "Shot N:" with "Cut to" — never timestamps on this generation.',
      'If images are attached, describe how the scene evolves from them instead of restating them.',
    ],
    workflowRules: [
      'If primaryModel is seedance-1.5-pro, layer action, environment, camera intent, pacing, and optional audio explicitly.',
      'If primaryModel is seedance-1.5-pro and the camera should stay static, say so clearly instead of leaving camera behavior ambiguous.',
    ],
    plannerNotes: [
      'The compiled prompt can be slightly more descriptive because Seedance responds well to layered scene instructions.',
      'Audio cues should only appear when sound is enabled — and then BGM generates by default, so say "no music" when silence matters.',
    ],
    agent: {
      id: 'seedance-15-layered-director',
      label: 'Seedance 1.5 layered director',
      strategyRules: [
        'Layer action, environment, camera intent, pacing, and optional audio explicitly.',
        'If fixed lens is enabled, compile camera language as static or locked rather than drifting or handheld.',
        'Close with positive constraints: no subtitles, no watermark, stable picture.',
      ],
      defaultSafeguards: [
        { code: 'fixed_lens_respected', message: 'Respect fixed-lens mode when it is enabled.' },
      ],
    },
  },
  'seedance-2': {
    modelId: 'seedance-2',
    label: 'Seedance 2',
    medium: 'video',
    plannerMode: 'structured-video',
    compilerProfile: 'seedance',
    budget: { targetWords: [60, 250] },
    audioBehavior: 'always',
    strategyRules: [
      'Treat Seedance 2 like a reference-driven video model: open with a one-to-three sentence global style block, then "Shot N:" beats — engineering-style instructions, not copywriting.',
      'Never use timestamps on this generation — they can break the output; "Shot N:" and "Cut to" are the shot grammar.',
      'Bind every attached asset by upload order with a purpose sentence ("@Image1 anchors the creator’s identity") plus carve-outs ("do not use the background from Image 1").',
      'Audio generates by default: always script the soundscape — dialogue in quotes with a speaker and tone, named effects and music mood — or write "no BGM" explicitly.',
      'Keep one fixed label per character and append an anti-duplicate constraint after casts ("Do not generate duplicate characters").',
      'Use edit verbs ("strictly edit", "change A to B") only for edit intents and "reference" only for style or motion transfer — the verb steers task routing.',
      'Fewer, cleaner references beat maxed limits: around four or five assets total.',
    ],
    workflowRules: [
      'If primaryModel is seedance-2, describe the reference-aware scene with explicit action, environment, camera intent, pacing, and audio.',
      'If primaryModel is seedance-2 and the scene should stay visually anchored, call out the locked camera or reference continuity directly.',
    ],
    plannerNotes: [
      'Seedance 2 works best when the plan stays tied to the connected reference assets and the final action beat remains easy to follow.',
      'Close with positive constraints: no subtitles, no watermark, no duplicate characters, stable motion.',
    ],
    agent: {
      id: 'seedance-2-reference-director',
      label: 'Seedance 2 reference director',
      strategyRules: [
        'Treat attached image, video, and audio references as first-class generation controls.',
        'State how references should guide identity, product details, camera continuity, motion timing, or audio style.',
        'Avoid inventing unrelated visual details when references already establish the scene.',
        'Keep the final action beat easy to follow across 4 to 15 seconds.',
      ],
      defaultSafeguards: [
        { code: 'reference_grounding', message: 'Ground Seedance 2 prompts in the attached reference assets.' },
      ],
    },
  },
  'seedance-2-fast': {
    modelId: 'seedance-2-fast',
    label: 'Seedance 2 Fast',
    medium: 'video',
    plannerMode: 'structured-video',
    compilerProfile: 'seedance',
    budget: { targetWords: [40, 150] },
    audioBehavior: 'always',
    strategyRules: [
      'Treat Seedance 2 Fast like a speed-oriented reference-driven model: the full Seedance 2 grammar with a tighter scope — at most three shots, one or two characters, one camera move.',
      'Never use timestamps; "Shot N:" and "Cut to" only.',
      'Skip heavy VFX, particles, and crowd scenes — the speed tier degrades on complex choreography first.',
      'Do not promise fine texture ("pore-level detail") at this tier’s resolution; anchor style instead.',
      'Audio generates by default — script it briefly or write "no BGM".',
      'Keep the prompt text portable so the user can re-render on Seedance 2 verbatim.',
    ],
    workflowRules: [
      'If primaryModel is seedance-2-fast, keep the prompt short, reference-aware, and focused on one clear action beat.',
    ],
    plannerNotes: [
      'Seedance 2 Fast prefers compact instructions with just enough detail to preserve the reference assets and the intended motion.',
    ],
    agent: {
      id: 'seedance-2-fast-reference-director',
      label: 'Seedance 2 Fast reference director',
      strategyRules: [
        'Favor one clean action beat over dense camera language or layered story events.',
        'Preserve reference motion and timing when a reference video is attached.',
      ],
      defaultSafeguards: [
        { code: 'compact_reference_prompt', message: 'Keep Seedance 2 Fast prompts compact and reference-aware.' },
      ],
    },
  },
  'seedance-2-5': {
    modelId: 'seedance-2-5',
    label: 'Seedance 2.5',
    medium: 'video',
    plannerMode: 'structured-video',
    compilerProfile: 'timeline',
    budget: { targetWords: [100, 700] },
    audioBehavior: 'always',
    strategyRules: [
      'Treat Seedance 2.5 as the long-form timeline model: open with a one-sentence summary (subject, location, event, style, camera approach), then asset bindings, then overall style, then a gap-free integer-second timeline.',
      'Timestamps are required here (unlike Seedance 2): "0-4s: …" ranges, one beat per 2–5 seconds, roughly seven to ten beats for a 30-second clip.',
      'Write dialogue per beat as Dialogue (speaker): "line", and pair any voice reference with a verbal timbre description.',
      'Bind every reference with one purpose sentence in upload order, and map casts explicitly ("Images 1-2 are Character 1"), repeating each character’s fixed traits at major beats.',
      'Negative constraints are officially supported only for subtitles and audio ("no subtitles", "no BGM") plus an optional style exclusion block — everything else stays positive.',
      'Use edit or extension trigger verbs ("replace…", "extend backward…") only when the user wants editing or extension.',
      'Give every beat a camera instruction (shot size plus one movement) and an audio cue.',
    ],
    workflowRules: [
      'If primaryModel is seedance-2-5, write a summary line, asset bindings, and a gap-free timestamped timeline with per-beat camera and audio.',
    ],
    plannerNotes: [
      'Scale words to duration: roughly 100–250 for clips up to 10 seconds, 300–700 for 30-second timelines.',
      'Never use timestamps for high-frequency actions — use point cues ("at the 5-second mark…").',
    ],
    agent: {
      id: 'seedance-25-timeline-director',
      label: 'Seedance 2.5 timeline director',
      strategyRules: [
        'Do not restate what a strictly-referenced asset already carries; fully describe any subject without a reference.',
      ],
      defaultSafeguards: [
        { code: 'gap_free_timeline', message: 'Keep Seedance 2.5 timelines continuous and matched to the duration.' },
      ],
    },
  },
  'wan-2.7': {
    modelId: 'wan-2.7',
    label: 'Wan 2.7',
    medium: 'video',
    plannerMode: 'structured-video',
    compilerProfile: 'single-clip',
    budget: { targetWords: [60, 200] },
    audioBehavior: 'always',
    strategyRules: [
      'Treat Wan 2.7 by its own official rewriter’s rules: entity, scene, motion, camera, then at most four aesthetic settings (time of day, light source, shot size, camera angle, composition).',
      'Describe motion as an unfolding process with speed and direction; if the user gave no motion, add a subtle one plus background motion (drifting clouds, wind in leaves).',
      'One camera instruction per clip; if the user specified a camera move, do not also add a camera-angle keyword.',
      'Never add new subjects and never write literary mood prose ("a scene full of energy").',
      'Audio generates by default: script the voice line with emotion, tone, and speed, plus effects and music style — or the model invents a soundtrack.',
      'Append "Generate a single-shot video." for single-scene clips — natural language is the official shot control.',
      'Rewrite impossible asks (legible in-video text, named real people, more than one scene change, word-accurate lip-sync) into achievable equivalents.',
    ],
    workflowRules: [
      'If primaryModel is wan-2.7, write entity, scene, motion, camera, and up to four aesthetic settings, then script the audio.',
    ],
    plannerNotes: [
      'For image-to-video output dynamics only, under 100 words, deleting every clause that restates the input image.',
      'For reference runs address assets positionally ("image 1", "video 1") with one role each.',
    ],
    agent: {
      id: 'wan-27-film-director',
      label: 'Wan 2.7 film director',
      strategyRules: [
        'A server-side extender already runs — deliver final-form precision, never padding.',
        'One beat per five seconds of runtime.',
      ],
      defaultSafeguards: [
        { code: 'single_shot_control', message: 'State the shot structure in natural language for Wan.' },
      ],
    },
  },
  'hailuo-2.3': {
    modelId: 'hailuo-2.3',
    label: 'Hailuo 2.3',
    medium: 'video',
    plannerMode: 'structured-video',
    compilerProfile: 'bracket-camera',
    budget: { targetWords: [40, 180], maxChars: 1900 },
    audioBehavior: 'none',
    strategyRules: [
      'Treat Hailuo 2.3 as an image-to-video storyteller: write only the motion delta — an eight-word subject anchor matching the image, then the action sequenced with "then", "as", and "while".',
      'Camera direction uses MiniMax bracket commands — [Push in], [Truck left], [Pan right], [Static shot] — at most three commands combined per bracket and at most two camera phases per clip.',
      'Never re-describe what the start image already shows, and never request framing that contradicts it.',
      'One subject transformation maximum — conflicting mid-prompt subject changes cause morphing.',
      'No quality-word spam ("8k", "masterpiece") — it oversaturates the output.',
      'This route has no audio: never write speech lines; express emotion visually.',
      'For anime inputs, name the style once ("hand-drawn anime style preserved") to hold line quality.',
    ],
    workflowRules: [
      'If primaryModel is hailuo-2.3, write the motion delta with bracketed camera commands like [Push in] and no frame re-description.',
    ],
    plannerNotes: [
      'An upstream prompt optimizer likely runs — clean prose, no token tricks.',
    ],
    agent: {
      id: 'hailuo-motion-animator',
      label: 'Hailuo motion animator',
      strategyRules: [
        'Fold avoidances into positive phrasing; there is no negative-prompt field.',
      ],
      defaultSafeguards: [
        { code: 'bracket_camera_grammar', message: 'Use MiniMax bracket camera commands for Hailuo.' },
      ],
    },
  },
  'minimax-h3': {
    modelId: 'minimax-h3',
    label: 'MiniMax H3',
    medium: 'video',
    plannerMode: 'structured-video',
    compilerProfile: 'timeline',
    budget: { targetWords: [60, 300] },
    audioBehavior: 'always',
    strategyRules: [
      'Treat MiniMax H3 as a timestamped-beat model: structure the clip as "0-5s: …" beats matched to the duration, never more story than the seconds can hold.',
      'One dominant camera move per clip; when the user wants stillness append "static locked camera, no camera movement, no shot change".',
      'H3 renders native stereo audio whether or not you direct it — always include an Audio: line with ambience, timed effects, or dialogue.',
      'Dialogue names the speaker, quotes the line, and carries a timestamp; one speaker at a time, with "accurate lip sync for [speaker] only" in two-person scenes.',
      'In reference mode write one "controls" sentence per asset in array order — "Image 1 controls Character A’s identity. Video 1 controls body movement and timing only." — and forbid cross-transfer explicitly.',
      'For commercial runs add a preserve clause (faces, wardrobe, product geometry, logo) and close with explicit exclusions ("No extra text, no additional products") — this model honors closing exclusion sentences.',
      'One visual style per generation; never mix photoreal and anime.',
    ],
    workflowRules: [
      'If primaryModel is minimax-h3, write timestamped beats with one dominant camera move, an Audio: line, and per-reference control sentences.',
    ],
    plannerNotes: [
      'Change one variable per iteration (pose or outfit or camera), not several.',
    ],
    agent: {
      id: 'minimax-h3-conductor',
      label: 'MiniMax H3 conductor',
      strategyRules: [
        'Avoid the words "cinematic" and "dynamic" as camera direction — name real moves.',
      ],
      defaultSafeguards: [
        { code: 'audio_always_scripted', message: 'Always script the H3 soundscape — audio renders unconditionally.' },
      ],
    },
  },
  'happyhorse-1.1': {
    modelId: 'happyhorse-1.1',
    label: 'HappyHorse 1.1',
    medium: 'video',
    plannerMode: 'structured-video',
    compilerProfile: 'single-clip',
    budget: { targetWords: [40, 160], maxChars: 1900 },
    audioBehavior: 'always',
    strategyRules: [
      'Treat HappyHorse 1.1 as a one-shot dialogue model: one shot, one action arc, one camera move per generation, written as Kling-style prose (setting, subject, action, camera, light).',
      'Audio is always generated: script the speech — speaker, quoted line, and the language named ("says in Japanese: …") — or write "No dialogue, ambient sound only."',
      'Use front-facing, uncluttered framing for dialogue shots — lip-sync drifts on crowded compositions.',
      'Cite references as "the [described object] in [Image 1]" numbered in upload order, one role per image.',
      'Avoid on-screen text entirely — it garbles on this model.',
      'Prefer clips of ten seconds or less for physics-heavy scenes; artifacts grow past that.',
      'Chinese prompts are first-class — never translate a user’s Chinese prompt.',
    ],
    workflowRules: [
      'If primaryModel is happyhorse-1.1, write one prose shot with named-language dialogue or an explicit no-dialogue line.',
    ],
    plannerNotes: [
      'The compiler enforces a conservative character cap — overflow is silently truncated by the provider.',
    ],
    agent: {
      id: 'happyhorse-dialogue-director',
      label: 'HappyHorse dialogue director',
      strategyRules: [
        'Fold exclusions inline ("no extra products, no text"); there is no negative-prompt field.',
      ],
      defaultSafeguards: [
        { code: 'named_language_dialogue', message: 'Name the spoken language for HappyHorse dialogue.' },
      ],
    },
  },
  'grok-imagine-video': {
    modelId: 'grok-imagine-video',
    label: 'Grok Imagine Video',
    medium: 'video',
    plannerMode: 'structured-video',
    compilerProfile: 'single-clip',
    budget: { targetWords: [30, 120] },
    audioBehavior: 'always',
    strategyRules: [
      'Treat Grok Imagine Video like a concise single-clip model: open with subject plus one kinetic action and exactly one camera move in 20–30 words.',
      'Every clip ships with generated audio: close with an Audio line — quoted dialogue for lip-sync, explicit effects and ambience, and "no music" unless music is wanted — or the model invents a soundtrack.',
      'One action beat per roughly six seconds of duration; for long clips describe a simple progression, not ten events.',
      'For image-to-video, describe only what changes; dialogue-led clips do better as text-to-video than from a locked first frame.',
      'One or two subjects maximum — multi-subject choreography drifts.',
      'Always write in English (endpoint constraint), and never write mode words like "spicy" into the prompt — mode is a parameter.',
    ],
    workflowRules: [
      'If primaryModel is grok-imagine-video, write one concise clip direction with subject, action, camera, mood, and a closing Audio line.',
    ],
    plannerNotes: [
      'Keep dialogue under about ten words per six seconds.',
    ],
    agent: {
      id: 'grok-imagine-video-director',
      label: 'Grok Imagine video director',
      strategyRules: [
        'Keep the action achievable within the selected duration and avoid multi-shot sequencing.',
        'No negative prompts; phrase avoidances positively ("steady tripod framing").',
      ],
      defaultSafeguards: [
        { code: 'single_clip_focus', message: 'Keep Grok video prompts focused on one filmable clip.' },
        { code: 'audio_always_scripted', message: 'Always script the Grok video audio track.' },
      ],
    },
  },
};

// ─── Motion-transfer playbooks ───────────────────────────────────────────────

const MOTION_PLAYBOOKS: Record<string, EnhancerPlaybook> = {
  'kling-2.6': {
    modelId: 'kling-2.6',
    label: 'Kling 2.6 Motion Control',
    medium: 'motion',
    plannerMode: 'legacy-text',
    budget: { targetWords: [15, 60], maxChars: 2400 },
    strategyRules: [
      'Kling 2.6 motion control divides labor strictly: the video owns choreography, the image owns identity, the prompt owns context — never describe the motion, dance, gesture timing, or tempo.',
      'Write who the character is (wardrobe, age, role — consistent with the image, reinforcing not contradicting), where they are, the lighting, and the style.',
      'Environment swaps are the feature: the prompt may place the performance anywhere ("on a spotlit theater stage with dramatic shadows").',
      'Secondary elements may be added ("a corgi runs in, circling her feet") but never a second performing character.',
      'Add a stability clause: "stable background, consistent lighting, no distortion."',
      'Never write motion negations ("don’t move the arms") — redirecting reference motion causes fighting and jitter.',
      'If the user’s raw prompt is choreography, strip it and keep only identity, setting, and style words.',
    ],
    workflowRules: [
      'If motionModel is kling-2.6, keep the prompt focused on identity, environment fit, and deformation avoidance rather than new choreography.',
    ],
    plannerNotes: ['One to three sentences is the right size.'],
    agent: {
      id: 'kling-motion-context-writer',
      label: 'Kling motion context writer',
      strategyRules: [
        'Camera language only helps when character orientation follows the image; otherwise the camera follows the reference video.',
      ],
      defaultSafeguards: [
        { code: 'no_choreography', message: 'Never direct motion in motion-control prompts — the reference video owns it.' },
      ],
    },
  },
  'kling-3.0': {
    modelId: 'kling-3.0',
    label: 'Kling 3.0 Motion Control',
    medium: 'motion',
    plannerMode: 'legacy-text',
    budget: { targetWords: [15, 60], maxChars: 2400 },
    strategyRules: [
      'Kling 3.0 motion control handles nuanced identity and scene polish well when the prompt stays focused on realism, environment, and subject integrity.',
      'All Kling 2.6 motion rules apply: never describe the motion; write identity, environment, lighting, and style only.',
      'When the prompt is short, append the official stabilizer sentence: "No distortion, the character’s movements are consistent with the video."',
      'Avoid extreme-expression directives ("screaming wildly") — a known face-warp trigger on this tier.',
      'If the character image contains multiple people, name which one ("the woman on the left") — otherwise the largest is auto-selected.',
    ],
    workflowRules: [
      'If motionModel is kling-3.0, keep the prompt focused on realism, subject integrity, and polished scene integration rather than new motion instructions.',
    ],
    plannerNotes: ['Route close-up faces and long takes here; keep 2.6 for cost.'],
    agent: {
      id: 'kling-motion-context-writer-v3',
      label: 'Kling 3.0 motion context writer',
      strategyRules: [
        'Prefer describing only lighting and mood when the background should come from one of the inputs.',
      ],
      defaultSafeguards: [
        { code: 'no_choreography', message: 'Never direct motion in motion-control prompts — the reference video owns it.' },
      ],
    },
  },
};

// ─── Audio playbooks ─────────────────────────────────────────────────────────

const AUDIO_PLAYBOOKS: Record<string, EnhancerPlaybook> = {
  'text-to-speech-turbo-2-5': {
    modelId: 'text-to-speech-turbo-2-5',
    label: 'ElevenLabs TTS Turbo 2.5',
    medium: 'audio',
    plannerMode: 'legacy-text',
    budget: { targetWords: [1, 700], maxChars: 4900 },
    strategyRules: [
      'This is script normalization, not creative rewriting: expand numerals, currencies, dates, abbreviations, and URLs into spoken words ("$4.99" becomes "four dollars ninety-nine cents", "Dr." becomes "Doctor").',
      'Never inject emotional stage directions — narrative cues like "she said angrily" get read aloud on this model; emotion comes from wording and punctuation only.',
      'Shape pacing with punctuation, and use sparse break tags like <break time="1.0s" /> only where a real pause belongs — too many destabilize the voice.',
      'Respell hard names and brand words phonetically in plain letters.',
      'Preserve the user’s meaning and sentence order exactly — this is their script, not a draft to rewrite.',
    ],
    workflowRules: [],
    plannerNotes: [],
    agent: {
      id: 'tts-script-normalizer',
      label: 'TTS script normalizer',
      strategyRules: ['Output only the normalized script text with no commentary.'],
      defaultSafeguards: [
        { code: 'no_stage_directions', message: 'Never add spoken-aloud stage directions to TTS scripts.' },
      ],
    },
  },
  'text-to-speech-multilingual-v2': {
    modelId: 'text-to-speech-multilingual-v2',
    label: 'ElevenLabs TTS Multilingual V2',
    medium: 'audio',
    plannerMode: 'legacy-text',
    budget: { targetWords: [1, 700], maxChars: 4900 },
    strategyRules: [
      'Apply the same script normalization as Turbo 2.5 — numbers, dates, symbols, and abbreviations expanded into words in the script’s own language.',
      'Never add stage directions; emotion comes from wording and punctuation.',
      'Keep the script’s language — never translate.',
      'Use sparse break tags for real pauses and phonetic respelling for hard names.',
    ],
    workflowRules: [],
    plannerNotes: [],
    agent: {
      id: 'tts-script-normalizer-multilingual',
      label: 'Multilingual TTS normalizer',
      strategyRules: ['Output only the normalized script text with no commentary.'],
      defaultSafeguards: [
        { code: 'no_stage_directions', message: 'Never add spoken-aloud stage directions to TTS scripts.' },
      ],
    },
  },
  'text-to-dialogue-v3': {
    modelId: 'text-to-dialogue-v3',
    label: 'ElevenLabs Text-to-Dialogue V3',
    medium: 'audio',
    plannerMode: 'legacy-text',
    budget: { targetWords: [40, 700], maxChars: 4900 },
    strategyRules: [
      'Enhance dialogue for the v3 tag grammar: sparse lowercase bracket tags matched to each voice’s character — [whispers], [sighs], [laughs], [sarcastic], [excited] — never stacked.',
      'Punctuation is the pacing control: ellipses add weight and pauses, capitals add emphasis.',
      'Do not use SSML break tags — v3 rejects them; use punctuation instead.',
      'Keep each speaker turn substantial — very short turns produce inconsistent delivery.',
      'Preserve the user’s words and speaker structure; add tags and punctuation, never new lines of dialogue.',
    ],
    workflowRules: [],
    plannerNotes: [],
    agent: {
      id: 'dialogue-v3-tagger',
      label: 'Dialogue v3 tagger',
      strategyRules: ['Output only the tagged dialogue text with no commentary.'],
      defaultSafeguards: [
        { code: 'tags_not_lines', message: 'Add delivery tags, never new dialogue lines.' },
      ],
    },
  },
  'sound-effect-v2': {
    modelId: 'sound-effect-v2',
    label: 'ElevenLabs Sound Effect V2',
    medium: 'audio',
    plannerMode: 'legacy-text',
    budget: { targetWords: [5, 60], maxChars: 440 },
    strategyRules: [
      'Translate lay descriptions into audio-production vocabulary: foley, whoosh, braam, impact, ambience.',
      'Add material, environment, and dynamics ("metal door slam with a reverb tail in a concrete stairwell").',
      'One effect per generation — split multi-sound requests into separate prompts and enhance only the first.',
      'A production frame upgrades simple prompts: "high-quality, professionally recorded [effect], sound effects foley".',
      'Stay under 440 characters.',
    ],
    workflowRules: [],
    plannerNotes: [],
    agent: {
      id: 'sfx-foley-artist',
      label: 'SFX foley artist',
      strategyRules: ['Output only the sound-effect prompt with no commentary.'],
      defaultSafeguards: [
        { code: 'single_effect', message: 'Describe one sound effect per generation.' },
      ],
    },
  },
};

export const ENHANCER_PLAYBOOKS: Record<string, EnhancerPlaybook> = {
  ...IMAGE_PLAYBOOKS,
  ...VIDEO_PLAYBOOKS,
  ...MOTION_PLAYBOOKS,
  ...AUDIO_PLAYBOOKS,
};

export function normalizeEnhancerModelId(selectedModel: string): string {
  return MODEL_ALIASES[selectedModel] ?? selectedModel;
}

export function getEnhancerPlaybookById(selectedModel: string): EnhancerPlaybook | null {
  return ENHANCER_PLAYBOOKS[normalizeEnhancerModelId(selectedModel)] ?? null;
}
