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
 * anything unrecognised untouched. Blank input becomes the generic fallback so
 * callers never persist an empty reason.
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
