/**
 * Display fallbacks the owner read APIs substitute for an empty post title.
 *
 * Both composers hydrate their edit forms from those APIs and PATCH the whole
 * draft back, so the exact fallback string can round-trip into a real title.
 * The marketplace placeholder gate rejects "untitled" titles on public posts
 * that share a recipe, which would leave such a post permanently unsavable.
 * Every consumer of the fallback must therefore be able to recognize it again.
 */
const OWNER_POST_TITLE_FALLBACKS = new Set(['Untitled post', 'Untitled note']);

export function getOwnerPostTitleFallback(postFormat: string | null | undefined): string {
  return postFormat === 'text' ? 'Untitled note' : 'Untitled post';
}

export function isOwnerPostTitleFallback(value: string | null | undefined): boolean {
  return typeof value === 'string' && OWNER_POST_TITLE_FALLBACKS.has(value.trim());
}
