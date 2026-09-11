/**
 * Rewriting provider failure text for the people who see it.
 *
 * Provider failure strings are written for the provider's own operators. The
 * same Seedance input-moderation rejection arrives as an English sentence on
 * `bytedance/seedance-2`:
 *
 *   "The request failed because the input image 'content[0]' may contain real
 *    person."
 *
 * and as a bare dotted code on `bytedance/seedance-2-5`:
 *
 *   "InputImageSensitiveContentDetected.PolicyViolation"
 *
 * Neither is something to put in front of a creator, and because the two shapes
 * share no common substring a rule matches on several patterns rather than one.
 * Expect further shapes as models are added: anything unrecognised passes
 * through verbatim so a new provider message is surfaced rather than swallowed.
 */

export const UNKNOWN_PROVIDER_FAILURE = 'Unknown error';

type ProviderFailureRule = {
  readonly patterns: readonly RegExp[];
  readonly message: string;
};

const PROVIDER_FAILURE_RULES: readonly ProviderFailureRule[] = [
  {
    // Seedance 2 and 2.5 both refuse a reference image their classifier reads
    // as a real person. This is a provider likeness policy, so no retry and no
    // change of resolution, duration or aspect ratio gets past it -- only a
    // different reference image or a different model.
    patterns: [
      /may contain (?:a )?real person/i,
      /inputimagesensitivecontentdetected/i,
    ],
    message:
      'This model would not accept the reference image because it looks like a photo of a real person. Try a reference image without a recognisable face, or generate this with a different video model.',
  },
];

/**
 * Maps a provider failure string to something worth showing a creator, leaving
 * anything unrecognised untouched. Blank input becomes the generic fallback, a
 * display message only: to decide what to persist, use
 * `readProviderFailureReason`, which returns null instead.
 */
export function describeProviderFailure(raw: string | null | undefined): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) {
    return UNKNOWN_PROVIDER_FAILURE;
  }

  const rule = PROVIDER_FAILURE_RULES.find(
    (candidate) => candidate.patterns.some((pattern) => pattern.test(trimmed)),
  );

  return rule ? rule.message : trimmed;
}

/**
 * The failure reason to store for a provider task, rewritten for the person who
 * will read it, or null when the task carries none.
 *
 * Pass the task object (`data.data` on a Kie response), never the whole body. A
 * code-200 body's top-level `msg` is "success", so falling back to it records
 * "success" as the reason a generation failed. The two shapes polled here
 * disagree on the field name: the market endpoint reports `failMsg`, the Veo
 * endpoint `errorMessage`. Both are accepted, and the first non-blank one wins.
 *
 * No placeholder is invented for a task with no reason. `settle_generation_failed`
 * keeps a stored reason only against a blank one, so a stored "Unknown error"
 * could erase a real reason from an earlier settlement. It would also replace
 * the client's own wording on every later poll.
 */
export function readProviderFailureReason(task: unknown): string | null {
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    return null;
  }

  const record = task as Record<string, unknown>;
  for (const key of ['failMsg', 'errorMessage'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return describeProviderFailure(value);
    }
  }

  return null;
}
