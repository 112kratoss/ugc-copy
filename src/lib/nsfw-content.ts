/** A warning label, independent of moderation takedowns and provider safety. */
export interface NsfwContentState {
  isNsfw?: boolean;
  nsfwRevealed?: boolean;
}

export const NSFW_TITLE = 'Mature content';
export const NSFW_DESCRIPTION = 'This post is marked NSFW. Reveal it only if you are 18 or older and comfortable viewing mature content.';

/** Remove every content-bearing field, including nested previews and recipes. */
export function coverNsfwContent<T extends object>(content: T): T & NsfwContentState {
  return {
    ...content,
    isNsfw: true,
    nsfwRevealed: false,
    title: NSFW_TITLE,
    description: NSFW_DESCRIPTION,
    prompt: '',
    body: NSFW_DESCRIPTION,
    category: 'text',
    postFormat: 'text',
    mediaKind: null,
    mediaUrl: null,
    mediaItems: [],
    generationId: null,
    asset: null,
    resourceBundle: null,
    canRemix: false,
    remixCapability: 'none',
    remixTarget: null,
  };
}

export function parseNsfwFlag(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error('isNsfw must be a boolean.');
}
