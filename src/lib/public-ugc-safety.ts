export const PUBLIC_UGC_SAFETY_ERROR =
  'This content cannot be shared publicly because it may violate the community safety rules. Revise it or keep the post private.';

export type PublicUgcTextField = 'title' | 'description' | 'body' | 'prompt';

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
  fields: Partial<Record<PublicUgcTextField, string | null | undefined>>,
): PublicUgcSafetyViolation | null {
  // Prefer the fields a creator directly edited before derived metadata such
  // as a text post title, so the response points at the actionable input.
  for (const field of ['body', 'prompt', 'title', 'description'] as const) {
    const value = fields[field];
    if (!value?.trim()) continue;

    const normalized = normalizeSafetyText(value);
    for (const rule of PUBLIC_UGC_SAFETY_RULES) {
      if (rule.pattern.test(normalized)) {
        return { category: rule.category, field };
      }
    }
  }

  return null;
}

export function isPubliclyVisibleReviewStatus(value: unknown): value is 'visible' {
  return value === 'visible';
}
