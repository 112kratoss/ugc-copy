import {
  describeTitleSuggestion,
  followTitleForPromptPrivacy,
  isTitleFromPrompt,
  recipeKeepsPromptPrivate,
  suggestCreationPostTitle,
  suggestRemixPostTitle,
  type CreationTitleSuggestion,
} from '../../ugc-mobile/lib/post-publish-policy/post-publish-policy';
import { TITLE_MAX_LENGTH } from '@/lib/post-limits';

export { recipeKeepsPromptPrivate };

/** What a suggested title is made from: fields of a creation as the generations API returns it. */
export type CreationTitleSource = {
  prompt?: string | null;
  model?: string | null;
  category?: string | null;
  creationMode?: string | null;
};

export type CreationPostTitleSuggestion = {
  title: string;
  /**
   * `creation`: the creation's own title or its template's; `remix`: its original's, marked as a
   * remix; else how the suggestion was made.
   */
  source: 'creation' | 'remix' | CreationTitleSuggestion['source'];
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
 * a remix's original's title marked as a remix, else a suggestion from the
 * shared policy (the prompt's opening unless a paid recipe keeps the prompt
 * private; else words naming what was made). Most creations have no title, and
 * typing one was where people stopped.
 */
export function getCreationPostTitleSuggestion(
  ownTitle: string | null | undefined,
  source: CreationTitleSource | null | undefined,
  /** A paid recipe keeps the prompt private (`recipeKeepsPromptPrivate`). */
  promptPrivate: boolean,
  /** The title of the post a remix was made from: an untitled remix starts from it ("intense (remix)"). */
  remixOfTitle?: string | null,
): CreationPostTitleSuggestion | null {
  const own = (ownTitle ?? '').slice(0, TITLE_MAX_LENGTH);
  if (own.trim()) {
    return { title: own, source: 'creation' };
  }
  const remixTitle = suggestRemixPostTitle(remixOfTitle);
  if (remixTitle) {
    return { title: remixTitle, source: 'remix' };
  }
  if (!source) {
    return null;
  }
  return suggestCreationPostTitle({ ...source, promptPrivate });
}

/** The line under the title while it is still the composer's suggestion; null once the creator has changed it. */
export function getCreationTitleSuggestionHint(
  title: string,
  suggestion: CreationPostTitleSuggestion | null,
  promptPrivate: boolean,
): string | null {
  if (!suggestion || suggestion.source === 'creation' || title !== suggestion.title) {
    return null;
  }
  return describeTitleSuggestion(suggestion.source, promptPrivate);
}

/**
 * The title once the recipe changes whether the prompt is private (a paid recipe
 * put on or taken off): a title cut from the prompt becomes the recipe's kind
 * title while a paid recipe keeps the prompt private, and comes back when it goes
 * (`followTitleForPromptPrivacy`); anything typed stays.
 */
export function followCreationTitleSuggestion({
  title,
  source,
  wasPrivate,
  isPrivate,
}: {
  title: string;
  source: CreationTitleSource | null | undefined;
  wasPrivate: boolean;
  isPrivate: boolean;
}): string {
  return source ? followTitleForPromptPrivacy(title, source, wasPrivate, isPrivate) : title;
}

/**
 * The title a post is stored with, as the server holds the composers' rule. A
 * paid recipe keeps the creation's prompt private, so a title cut from that
 * prompt is stored as the recipe's kind title ("Image recipe"), the swap both
 * composers make when a paid recipe goes on. Such a title comes from an older
 * app, from a composer opened with a recipe already chosen, or from a title an
 * earlier public save copied onto the creation. Any other title, and every
 * title of a post with a free recipe, none, or no creation, is kept as it is
 * (owner, 2026-10-29: a free recipe hands its prompt to anyone with one tap).
 */
export function titleForRecipePost({
  title,
  promptPrivate,
  source,
}: {
  title: string | null;
  /** The post's recipe, as it stands after the save, keeps the prompt private (`recipeKeepsPromptPrivate`). */
  promptPrivate: boolean;
  source: CreationTitleSource | null | undefined;
}): string | null {
  if (!promptPrivate || !title || !source || !isTitleFromPrompt(title, source.prompt)) {
    return title;
  }
  return suggestCreationPostTitle({ ...source, promptPrivate: true }).title;
}
