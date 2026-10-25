import {
  describeTitleSuggestion,
  followTitleForRecipe,
  suggestCreationPostTitle,
  type CreationTitleSuggestion,
} from '../../ugc-mobile/lib/post-publish-policy/post-publish-policy';
import { TITLE_MAX_LENGTH } from '@/lib/post-limits';

/** What a suggested title is made from: fields of a creation as the generations API returns it. */
export type CreationTitleSource = {
  prompt?: string | null;
  model?: string | null;
  category?: string | null;
  creationMode?: string | null;
};

export type CreationPostTitleSuggestion = {
  title: string;
  /** `creation`: the creation's own title or its template's; else how the suggestion was made. */
  source: 'creation' | CreationTitleSuggestion['source'];
};

function readText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** The fields a suggestion needs, from a creation record of `/api/generations`. */
export function readCreationTitleSource(generation: unknown): CreationTitleSource | null {
  if (!generation || typeof generation !== 'object') {
    return null;
  }
  const record = generation as Record<string, unknown>;
  return {
    prompt: readText(record.prompt),
    model: readText(record.model),
    category: readText(record.category),
    creationMode: readText(record.creationMode),
  };
}

/**
 * The title a post of a creation starts with, as the app composer's
 * `getCreationPostTitleSuggestion`: the creation's own title or its template's,
 * else a suggestion from the shared policy (the prompt's opening while the post
 * has no recipe, which keeps the prompt private; else words naming what was
 * made). Most creations have no title, and typing one was where people stopped.
 */
export function getCreationPostTitleSuggestion(
  ownTitle: string | null | undefined,
  source: CreationTitleSource | null | undefined,
  hasRecipe: boolean,
): CreationPostTitleSuggestion | null {
  const own = (ownTitle ?? '').slice(0, TITLE_MAX_LENGTH);
  if (own.trim()) {
    return { title: own, source: 'creation' };
  }
  if (!source) {
    return null;
  }
  return suggestCreationPostTitle({ ...source, hasRecipe });
}

/** The line under the title while it is still the composer's suggestion; null once the creator has changed it. */
export function getCreationTitleSuggestionHint(
  title: string,
  suggestion: CreationPostTitleSuggestion | null,
  hasRecipe: boolean,
): string | null {
  if (!suggestion || suggestion.source === 'creation' || title !== suggestion.title) {
    return null;
  }
  return describeTitleSuggestion(suggestion.source, hasRecipe);
}

/**
 * The title once a recipe is turned on or off: a title cut from the prompt
 * becomes the recipe's kind title while a recipe keeps the prompt private, and
 * comes back when it goes (`followTitleForRecipe`); anything typed stays.
 */
export function followCreationTitleSuggestion({
  title,
  source,
  hadRecipe,
  hasRecipe,
}: {
  title: string;
  source: CreationTitleSource | null | undefined;
  hadRecipe: boolean;
  hasRecipe: boolean;
}): string {
  return source ? followTitleForRecipe(title, source, hadRecipe, hasRecipe) : title;
}
