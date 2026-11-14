import { replacePromptHandles } from '@/lib/image-elements';

/**
 * The prompt Kling 4.0 is sent, and what in it Kie would refuse.
 *
 * Both Kling 4.0 endpoints read every `@` in the prompt as a mention of a material the request
 * declares, and refuse the request when one names nothing ("Every `@` mention must match an
 * asset included in this request, otherwise the request is rejected";
 * docs/model-api-references/kling-4-0.md). The materials have Kie's names, not the app's:
 * reference pictures are `@image_1` … in the order of `image_urls`. So each picture's @handle is
 * rewritten to the name of its place, and any `@` still naming nothing is reported, for the start
 * to refuse before it holds anything, rather than sent for Kie to reject.
 *
 * Keyframes are `@first_frame` and `@last_frame` to Kie, but no run here can name them: the start
 * refuses a lowercase @name that is no element of the run (`findUnknownPromptHandles`) before it
 * gets here. So a run without reference pictures, frames or text, declares nothing, and any `@`
 * in its prompt is refused.
 *
 * Kie matches a mention against the declared names longest first, and a name ending in a
 * letter, digit or underscore may not run on into another: `@image_10` is the tenth picture,
 * and `@image_1x` names nothing.
 */
export type Kling4Prompt = {
  /** The prompt with each picture's @handle as its `@image_N`. */
  prompt: string;
  /** Each `@…` the request would declare nothing for, as written, once each. */
  undeclaredMentions: string[];
};

/**
 * `pictureHandles`: the reference pictures the provider is sent, in order, each with the @handle
 * it was named by, if any; empty for a run of frames or text.
 */
export function kling4ProviderPrompt(
  prompt: string,
  pictureHandles: readonly (string | null | undefined)[],
): Kling4Prompt {
  const replacements = new Map<string, string>();
  pictureHandles.forEach((handle, index) => {
    if (handle) replacements.set(handle, `@image_${index + 1}`);
  });
  const rewritten = replacePromptHandles(prompt, replacements);

  // Longest first, so `image_10` is tried before `image_1`.
  const names = pictureHandles
    .map((_handle, index) => `image_${index + 1}`)
    .sort((a, b) => b.length - a.length);
  const undeclared = new Set<string>();
  for (let at = rewritten.indexOf('@'); at !== -1; at = rewritten.indexOf('@', at + 1)) {
    const rest = rewritten.slice(at + 1);
    // Exactly as Kie spells it: whether Kie would also take `@Image_1` is unknown, and a
    // refusal here costs nothing where one from Kie comes after the hold.
    const name = names.find((candidate) => rest.startsWith(candidate));
    const runsOn = name !== undefined && /^[A-Za-z0-9_]/.test(rest.slice(name.length));
    if (name === undefined || runsOn) {
      // As written up to the next space, without the punctuation that ends a sentence.
      undeclared.add(`@${(rest.match(/^[^\s@]*/)?.[0] ?? '').replace(/[.,;:!?)\]"'’]+$/, '')}`);
    }
  }
  return { prompt: rewritten, undeclaredMentions: [...undeclared] };
}

/**
 * The start's words for a prompt Kling 4.0 would refuse for its mentions: a run with reference
 * pictures can name them, and one without has nothing an `@` could name.
 */
export function kling4UndeclaredMentionRefusal(
  mentions: readonly string[],
  pictureCount: number,
  /** The model's name, Kling 4.0 or its Flash tier, whose endpoints read mentions alike. */
  modelName = 'Kling 4.0',
): string {
  const named = mentions.map((mention) => (mention === '@' ? '"@"' : mention)).join(', ');
  return pictureCount > 0
    ? `${modelName} reads every @ as a mention of an attached picture. Mention a reference by its @name, or take the @ out of ${named}.`
    : `${modelName} reads every @ as a mention of an attached reference picture, and this run has none. Take the @ out of ${named}.`;
}
