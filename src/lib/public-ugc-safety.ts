import {
  normalizePostResourceAttachments,
  normalizePostResourceItems,
  normalizePostResourceSections,
  type PostResourceBundleInput,
} from '@/lib/post-resource-bundles';

export const PUBLIC_UGC_SAFETY_ERROR =
  'This content cannot be shared publicly because it may violate the community safety rules. Revise it or keep the post private.';

export type PublicUgcTextField =
  | 'title'
  | 'description'
  | 'body'
  | 'prompt'
  | 'resourcePrompt'
  | 'resourceNotes'
  | 'resourceCards'
  | 'resourcePreview'
  | 'resourceSummary';

/** One text, or several that are checked one at a time and never joined. */
export type PublicUgcTextValue = string | null | undefined | ReadonlyArray<string | null | undefined>;

type PublicUgcRecipeTextField = Extract<PublicUgcTextField, `resource${string}`>;

export type PublicUgcSafetyCategory =
  | 'child_sexual_exploitation'
  | 'dangerous_instructions'
  | 'hateful_violence'
  | 'self_harm_encouragement'
  | 'sexual_violence';

export type PublicUgcSafetyViolation = {
  category: PublicUgcSafetyCategory;
  field: PublicUgcTextField;
};

type PublicUgcSafetyRule = {
  category: PublicUgcSafetyCategory;
  pattern: RegExp;
};

const PUBLIC_UGC_SAFETY_RULES: PublicUgcSafetyRule[] = [
  {
    category: 'child_sexual_exploitation',
    pattern: /\b(?:create|depict|draw|generate|make|produce|render|share|show|upload)\b.{0,80}\b(?:child|kid|minor|underage|young teen)\b.{0,50}\b(?:naked|nude|porn(?:ographic)?|sexual(?:ized)?)\b/i,
  },
  {
    category: 'child_sexual_exploitation',
    pattern: /\b(?:create|depict|draw|generate|make|produce|render|share|show|upload)\b.{0,80}\b(?:naked|nude|porn(?:ographic)?|sexual(?:ized)?)\b.{0,50}\b(?:child|kid|minor|underage|young teen)\b/i,
  },
  {
    category: 'child_sexual_exploitation',
    pattern: /\b(?:buy|sell|traffic)\b.{0,40}\b(?:child|kid|minor|underage)\b.{0,30}\b(?:for sex|sexually)\b/i,
  },
  {
    category: 'self_harm_encouragement',
    pattern: /\b(?:go )?(?:kill|hang|cut)\s+yourself\b/i,
  },
  {
    category: 'self_harm_encouragement',
    pattern: /\b(?:you should|just|please)\s+(?:commit suicide|end your life)\b/i,
  },
  {
    category: 'dangerous_instructions',
    pattern: /\b(?:how to|instructions? (?:for|to)|step by step(?: guide)? (?:for|to))\b.{0,80}\b(?:build|create|make|manufacture)\b.{0,30}\b(?:bomb|explosive|molotov cocktail)\b/i,
  },
  {
    category: 'dangerous_instructions',
    pattern: /\b(?:build|create|make|manufacture)\b.{0,30}\b(?:bomb|explosive|molotov cocktail)\b.{0,80}\b(?:at home|instructions?|step by step)\b/i,
  },
  {
    category: 'hateful_violence',
    pattern: /\b(?:exterminate|gas|kill|lynch|shoot)\s+(?:all|every)\s+(?:black people|christians?|disabled people|gay people|hindus?|jews?|lesbians?|men|muslims?|trans(?:gender)? people|women)\b/i,
  },
  {
    category: 'sexual_violence',
    pattern: /\b(?:create|depict|draw|generate|make|produce|render|show)\b.{0,80}\b(?:bestiality|necrophilia|rape porn|sexual assault porn)\b/i,
  },
];

function normalizeSafetyText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .toLowerCase()
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function getPublicUgcSafetyViolation(
  fields: Partial<Record<PublicUgcTextField, PublicUgcTextValue>>,
): PublicUgcSafetyViolation | null {
  // Prefer the fields a creator directly edited before derived metadata such
  // as a text post title, so the response points at the actionable input.
  // Bundle text is included because a paid unlock's prompt and notes are
  // distributed to buyers just like the public caption is -- being behind a
  // paywall is not a reason to skip the check. Cards come before the preview
  // and the summary because a composer derives those from the card titles
  // when they are left blank, and the preview before the summary because a
  // blank summary is sent as the preview.
  for (const field of [
    'body',
    'prompt',
    'resourcePrompt',
    'resourceNotes',
    'resourceCards',
    'resourcePreview',
    'resourceSummary',
    'title',
    'description',
  ] as const) {
    const value = fields[field];
    // Each text is matched alone: the rules allow words between their terms,
    // so two harmless cards read as one string could match together.
    const texts = typeof value === 'string' ? [value] : value ?? [];
    for (const text of texts) {
      if (!text?.trim()) continue;

      const normalized = normalizeSafetyText(text);
      for (const rule of PUBLIC_UGC_SAFETY_RULES) {
        if (rule.pattern.test(normalized)) {
          return { category: rule.category, field };
        }
      }
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readEach(list: unknown, key: string): unknown[] {
  return Array.isArray(list) ? list.map((entry) => (isRecord(entry) ? entry[key] : null)) : [];
}

/**
 * The creator's words in a recipe's workflow graph (`SerializedWorkflowCanvasGraph`
 * in `workflow-canvas.ts`), which a buyer receives whole and the canvas shows:
 * node titles and subtitles, prompt and note text, multi-shot prompts, dialogue
 * lines, the music mood, an approval step's label, an upload's label and
 * guidance, and reference element names. The graph is stored exactly as the
 * client sent it, with no normalizer, so it is read as raw JSON, and each key
 * on every node whatever its type: a stored type is no promise about the keys
 * beside it. Ids, handles, model ids, voices, language codes, control values,
 * run state and media locations are left out, as they are not prose a creator
 * writes for a reader. A new free-text field on a workflow node belongs here.
 */
function getWorkflowGraphTexts(graph: unknown): string[] {
  if (!isRecord(graph) || !Array.isArray(graph.nodes)) {
    return [];
  }

  return graph.nodes.flatMap((node) => {
    const data = isRecord(node) ? node.data : null;
    if (!isRecord(data)) {
      return [];
    }

    const templateInput: Record<string, unknown> = isRecord(data.templateInput) ? data.templateInput : {};
    return [
      data.title,
      data.subtitle,
      data.text,
      data.label,
      data.mood,
      templateInput.label,
      templateInput.guidance,
      ...readEach(data.multiPrompts, 'prompt'),
      ...readEach(data.dialogueTurns, 'text'),
      ...readEach(data.elements, 'displayName'),
    ].filter((text): text is string => typeof text === 'string');
  });
}

/**
 * Every text a recipe stores, as the safety check's fields. Both composers
 * write each card into `resources.sections` and `resources.items` and leave
 * the legacy prompt and notes fields empty, so those two alone let any card
 * through. Card titles, the summary and the preview are also listing copy
 * that anyone sees before unlocking. Links count as text: the check reads a
 * URL's path as words, so a slug can carry what a caption would be refused for.
 */
export function getPublicUgcRecipeTextFields(
  bundle: PostResourceBundleInput | null | undefined,
): Partial<Record<PublicUgcRecipeTextField, PublicUgcTextValue>> {
  // Only a free or paid recipe is stored; access 'none' deletes the recipe.
  if (bundle?.accessMode !== 'free' && bundle?.accessMode !== 'paid') {
    return {};
  }

  const resources = bundle.resources ?? {};
  return {
    resourcePrompt: resources.promptText,
    resourceNotes: resources.notesMarkdown,
    // Read through the same normalizers the stored payload is built with, so
    // the check sees exactly the text that is saved. The recipe's own link and
    // graph are stored in columns beside the cards, and buyers receive both.
    resourceCards: [
      ...normalizePostResourceSections(resources.sections)
        .flatMap((section) => [section.title, section.publicTitle, section.description]),
      ...normalizePostResourceItems(resources.items, resources)
        .flatMap((item) => [
          item.title,
          item.description,
          item.textContent,
          item.externalUrl,
          ...getWorkflowGraphTexts(item.workflowSnapshot),
        ]),
      ...normalizePostResourceAttachments(resources.attachments)
        .flatMap((attachment) => [attachment.label, attachment.url]),
      // The stored column keeps only a string, as `normalizeText` does on save.
      typeof resources.workflowShareUrl === 'string' ? resources.workflowShareUrl : null,
      ...getWorkflowGraphTexts(resources.workflowSnapshot),
    ],
    resourcePreview: bundle.previewText,
    resourceSummary: bundle.summary,
  };
}

export function isPubliclyVisibleReviewStatus(value: unknown): value is 'visible' {
  return value === 'visible';
}
