/**
 * The words of a post the web and the app must agree on, in one copy shared
 * by relative import: the placeholder rule and the public-post rule the server
 * applies before a post or a recipe listing goes public
 * (`src/lib/marketplace-trust.ts`, and the app composer's step 2 in
 * `lib/post-new-view-model.ts`), the title both composers suggest for a
 * creation, and the handle they suggest to a creator who has none yet.
 * contracts/public-post-quality-v1.json holds the rule's cases for both suites.
 *
 * Metro, Next.js and Vitest all compile this file, so it stays free of React
 * Native, Expo and Node imports (see this folder's tsconfig.json).
 */

/**
 * Stand-in words. A title made of nothing else is a placeholder; one that only
 * uses a word ("Product demo", "Free sample pack") is a real title.
 */
export const PLACEHOLDER_WORDS: readonly string[] = [
  'asdf',
  'demo',
  'draft',
  'example',
  'foo',
  'ipsum',
  'lorem',
  'placeholder',
  'sample',
  'test',
  'testing',
  'todo',
  'untitled',
];

/**
 * Stand-ins no real text uses, so they make any title, caption, preview or
 * prompt a placeholder wherever they appear: "Lorem ipsum dolor sit amet…".
 */
export const DECISIVE_PLACEHOLDER_WORDS: readonly string[] = ['asdf', 'ipsum', 'lorem'];

/**
 * Words that name nothing by themselves, so they cannot turn a stand-in into a
 * title or a text: "Demo video", "My test render", "Untitled recipe" and "This
 * is a test post" are still placeholders. Numbers count the same ("test 2").
 */
export const PLACEHOLDER_FILLER_WORDS: readonly string[] = [
  'a',
  'an',
  'the',
  'my',
  'this',
  'new',
  'i',
  'me',
  'we',
  'our',
  'your',
  'it',
  'is',
  'are',
  'was',
  'be',
  'of',
  'for',
  'and',
  'or',
  'to',
  'in',
  'on',
  'at',
  'with',
  'just',
  'only',
  'here',
  'some',
  'one',
  'again',
  'post',
  'image',
  'images',
  'photo',
  'photos',
  'pic',
  'picture',
  'video',
  'videos',
  'text',
  'note',
  'clip',
  'render',
  'creation',
  'title',
  'file',
  'upload',
  'recipe',
  'prompt',
  'workflow',
];

const PLACEHOLDER_WORD_SET: ReadonlySet<string> = new Set(PLACEHOLDER_WORDS);
const DECISIVE_PLACEHOLDER_WORD_SET: ReadonlySet<string> = new Set(DECISIVE_PLACEHOLDER_WORDS);
const PLACEHOLDER_FILLER_WORD_SET: ReadonlySet<string> = new Set(PLACEHOLDER_FILLER_WORDS);

/**
 * Lowercased words, with links and everything that is not a letter, a mark or
 * a digit taken out: punctuation and symbols of any script (curly quotes, "…",
 * "—"), emoji and invisible characters. Letters of every script are kept, so a
 * title in Hindi or Japanese is words. Hermes compiles these Unicode property
 * escapes (its compiler rejects an unknown property by name).
 */
function toComparableWords(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter(Boolean);
}

function isFillerWord(word: string): boolean {
  return PLACEHOLDER_FILLER_WORD_SET.has(word) || /^\d+$/.test(word);
}

/**
 * Text a public post or listing may not carry: no letters or digits at all,
 * a decisive stand-in anywhere, only stand-in and filler words, or keyboard
 * mash ("aaaaaa", "ababab", "abcabcabc"). The database applies the same rule
 * (`public.marketplace_text_is_placeholder`), held to the same word lists.
 */
export function isPlaceholderText(value: string): boolean {
  const words = toComparableWords(value);
  if (words.length === 0) {
    return true;
  }

  if (words.some((word) => DECISIVE_PLACEHOLDER_WORD_SET.has(word))) {
    return true;
  }

  if (
    words.some((word) => PLACEHOLDER_WORD_SET.has(word))
    && words.every((word) => PLACEHOLDER_WORD_SET.has(word) || isFillerWord(word))
  ) {
    return true;
  }

  // Mash is judged on Latin letters and digits only: a repeated vowel sign in
  // "दादा दादी" or a row of emoji after "Lol" is not keyboard mash. Any repeat
  // of one to three characters has at most three distinct ones.
  const compact = words.join('');
  return /^[a-z0-9]{6,}$/.test(compact) && new Set(compact).size <= 3;
}

export const PUBLIC_POST_PLACEHOLDER_TITLE_ERROR = 'Replace the placeholder title with something specific to this post.';
export const PUBLIC_POST_NEEDS_TEXT_ERROR = 'Add useful text so viewers can understand the post before publishing.';
const PUBLIC_POST_MIN_TEXT_LENGTH = 18;

/**
 * The public-post rule: a public post may not carry a placeholder title, and
 * one without media needs some useful text.
 */
export function getPublicPostQualityError(input: {
  title?: string | null;
  body?: string | null;
  hasMedia?: boolean | null;
}): string | null {
  const title = input.title?.trim() ?? '';
  const body = input.body?.trim() ?? '';

  if (title && isPlaceholderText(title)) {
    return PUBLIC_POST_PLACEHOLDER_TITLE_ERROR;
  }

  if (!input.hasMedia && (body.length < PUBLIC_POST_MIN_TEXT_LENGTH || isPlaceholderText(body))) {
    return PUBLIC_POST_NEEDS_TEXT_ERROR;
  }

  return null;
}

export type CreationTitleSuggestionInput = {
  /**
   * The creation's prompt. It is read only while the post has no recipe: a
   * recipe keeps the prompt off the public post (`sanitizePublicPostContent`),
   * so a title cut from it would publish the opening of what is being sold.
   */
  prompt?: string | null;
  model?: string | null;
  category?: string | null;
  /** `'motion'` for a motion transfer, whose stored category is 'video' and model 'kling-2.6'/'kling-3.0'. */
  creationMode?: string | null;
  hasRecipe: boolean;
};

export type CreationTitleSuggestion = {
  title: string;
  /** `prompt` when the title was cut from the prompt; `kind` when it only names what was made. */
  source: 'prompt' | 'kind';
};

type CreationKind = 'image' | 'video' | 'motion' | 'audio';

const TITLE_BY_KIND: Record<CreationKind, string> = {
  image: 'AI image',
  video: 'AI video',
  motion: 'Motion transfer',
  audio: 'AI audio',
};

const RECIPE_TITLE_BY_KIND: Record<CreationKind, string> = {
  image: 'Image recipe',
  video: 'Video recipe',
  motion: 'Motion transfer recipe',
  audio: 'Audio recipe',
};

/**
 * The titles a suggestion can name a creation by when its prompt gives none,
 * lowercased. Many posts can carry the same one, so the search gates
 * (`src/lib/sitemap-entries.ts`, `src/lib/showcase-seo.ts`) treat them as
 * placeholders and compose a page title of their own.
 */
export const GENERIC_SUGGESTED_TITLES: readonly string[] = [
  ...Object.values(TITLE_BY_KIND),
  ...Object.values(RECIPE_TITLE_BY_KIND),
].map((title) => title.toLowerCase());

const SUGGESTED_TITLE_MAX_WORDS = 8;
const SUGGESTED_TITLE_MAX_LENGTH = 60;

/** Words a cut title must not end on: "Cat surfing a giant wave at" reads as cut off. */
const TRAILING_JOINER_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'is', 'like', 'of', 'on', 'or',
  'over', 'than', 'that', 'the', 'to', 'under', 'while', 'with', 'without',
]);

function readCreationKind(
  model: string | null | undefined,
  category: string | null | undefined,
  creationMode: string | null | undefined,
): CreationKind {
  const normalizedCategory = category?.trim().toLowerCase();
  // A motion transfer says so in its creation mode; older rows only in a
  // category of 'motion' or a provider model id such as 'kling-2.6/motion-control'.
  if (creationMode === 'motion' || normalizedCategory === 'motion' || model?.toLowerCase().includes('motion')) {
    return 'motion';
  }
  if (normalizedCategory === 'video' || normalizedCategory === 'audio') {
    return normalizedCategory;
  }
  return 'image';
}

/** Quotes, brackets and markdown marks around a phrase, and the commas and dashes a cut leaves. */
function trimPhraseEdges(value: string): string {
  return value
    .replace(/^[\s"'`“”‘’()[\]{}<>*_#~,.;:!?|-]+/, '')
    .replace(/[\s"'`“”‘’()[\]{}<>*_#~,.;:|-]+$/, '');
}

/**
 * The prompt's opening phrase as a title: its first sentence, without links,
 * `@image1`-style references, a leading "Create a video of" and the like, cut
 * at a word to eight words and sixty characters.
 */
function titleFromPrompt(prompt: string | null | undefined): string {
  if (!prompt?.trim()) {
    return '';
  }

  const segments = prompt
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@[\w.-]+/g, ' ')
    .split(/[.!?](?=\s|$)|[\n\r;:|。！？；：]/)
    .map((segment) => trimPhraseEdges(segment.replace(/\s+/g, ' ').trim()))
    .filter(Boolean);
  // A label such as "Scene 1:" or "Style:" is not what the creation shows.
  const sentence = segments.find((segment) => segment.split(' ').length >= 3)
    ?? segments.find((segment) => segment.split(' ').length >= 2)
    ?? segments[0]
    ?? '';

  const phrase = trimPhraseEdges(
    sentence
      .replace(/^(?:please\s+)?(?:generate|create|produce|design|draw)\s+(?:me\s+)?/i, '')
      .replace(/^(?:a|an|the)\s+/i, '')
      .replace(/^(?:photo|photograph|image|picture|video|clip|shot|render|illustration|footage)\s+of\s+/i, '')
      .replace(/^(?:a|an|the)\s+/i, ''),
  );

  // Whole comma clauses while they fit: "Window display, soft morning light,
  // 85mm" keeps the first, rather than ending on "display, soft".
  const kept: string[] = [];
  let keptWordCount = 0;
  for (const clause of phrase.split(',').map((part) => part.trim()).filter(Boolean)) {
    const clauseWords = clause.split(' ').filter(Boolean);
    if (kept.length === 0) {
      kept.push(clauseWords.slice(0, SUGGESTED_TITLE_MAX_WORDS).join(' '));
      keptWordCount = Math.min(clauseWords.length, SUGGESTED_TITLE_MAX_WORDS);
      continue;
    }
    if (keptWordCount + clauseWords.length > SUGGESTED_TITLE_MAX_WORDS) {
      break;
    }
    kept.push(clause);
    keptWordCount += clauseWords.length;
  }

  const words = kept.join(', ').split(' ').filter(Boolean);
  while (words.length > 1 && words.join(' ').length > SUGGESTED_TITLE_MAX_LENGTH) {
    words.pop();
  }
  while (words.length > 1 && TRAILING_JOINER_WORDS.has(words[words.length - 1].toLowerCase().replace(/,$/, ''))) {
    words.pop();
  }

  const cut = trimPhraseEdges(words.join(' ').slice(0, SUGGESTED_TITLE_MAX_LENGTH));
  const title = cut.charAt(0).toUpperCase() + cut.slice(1);
  return title.length >= 3 && !isPlaceholderText(title) ? title : '';
}

/**
 * The title a post of a creation starts with when the creation has none of
 * its own: the opening of its prompt while the post has no recipe, else words
 * that name what was made ("AI video", "Image recipe"). Every suggestion
 * passes the placeholder rule, and the creator can edit it like any title.
 */
export function suggestCreationPostTitle(input: CreationTitleSuggestionInput): CreationTitleSuggestion {
  const kind = readCreationKind(input.model, input.category, input.creationMode);
  // A motion prompt tells the model how to move ("No distortion, the
  // character's movements are consistent with the video."), not what is shown.
  if (!input.hasRecipe && kind !== 'motion') {
    const fromPrompt = titleFromPrompt(input.prompt);
    if (fromPrompt) {
      return { title: fromPrompt, source: 'prompt' };
    }
  }

  return { title: input.hasRecipe ? RECIPE_TITLE_BY_KIND[kind] : TITLE_BY_KIND[kind], source: 'kind' };
}

/**
 * The title once a recipe is turned on or off. A title cut from the prompt is
 * swapped for the recipe's kind title while a recipe is on (a recipe keeps the
 * prompt private) and back when the recipe goes; any other title stays. It is
 * compared with the prompt itself, not with what a composer prefilled, so the
 * rule holds in an editor too, and for a title an earlier save copied onto the
 * creation as its own.
 */
export function followTitleForRecipe(
  title: string,
  creation: Omit<CreationTitleSuggestionInput, 'hasRecipe'>,
  hadRecipe: boolean,
  hasRecipe: boolean,
): string {
  if (hadRecipe === hasRecipe) {
    return title;
  }
  const fromPrompt = suggestCreationPostTitle({ ...creation, hasRecipe: false });
  const forRecipe = suggestCreationPostTitle({ ...creation, hasRecipe: true });
  if (hasRecipe) {
    return fromPrompt.source === 'prompt' && title === fromPrompt.title ? forRecipe.title : title;
  }
  return title === forRecipe.title ? fromPrompt.title : title;
}

/**
 * A title as it reads, for comparing two: no case, no extra spaces, and no
 * quotes or marks at its edges, which a cut never keeps ("…window display."
 * reads as the cut "…window display").
 */
function normalizeTitleForComparison(value: string): string {
  return trimPhraseEdges(value.replace(/\s+/g, ' ').trim()).toLowerCase();
}

/**
 * Whether a title is the opening of a prompt, as a suggestion cuts it
 * (`titleFromPrompt`), compared without case, extra spaces or the marks at
 * its edges. A title shorter or longer than the cut does not count, so one
 * the creator chose stays. A recipe keeps its prompt private, so a post with
 * one must not carry such a title; the server swaps it for the kind title,
 * as the composers do when a recipe goes on.
 */
export function isTitleFromPrompt(title: string | null | undefined, prompt: string | null | undefined): boolean {
  const fromPrompt = titleFromPrompt(prompt);
  if (!fromPrompt || !title?.trim()) {
    return false;
  }
  return normalizeTitleForComparison(title) === normalizeTitleForComparison(fromPrompt);
}

/** The line under a title that is still the composer's suggestion, in the same words on the web and in the app. */
export function describeTitleSuggestion(source: CreationTitleSuggestion['source'], hasRecipe: boolean): string {
  if (source === 'prompt') {
    return 'Suggested from your prompt. Edit it if you like.';
  }
  return hasRecipe ? 'Suggested. A recipe keeps your prompt off the post.' : 'Suggested. Edit it if you like.';
}

const SUGGESTED_HANDLE_PATTERN = /^[a-z0-9-]{3,24}$/;
const GENERATED_HANDLE_PATTERN = /^creator-[a-f0-9]{8}$/;

/**
 * A handle to offer a creator who still has the signup placeholder
 * (`creator-xxxxxxxx`), from their name, else their email's local part:
 * "Athul S" → "athul-s". Empty when neither gives three usable characters
 * (a name in another script). `isUsable` lets the caller pass over a handle it
 * knows is reserved, so "Support" with maya@… still gives "maya". The server
 * still decides whether it is free; this only saves typing.
 */
export function suggestProfileHandle(
  displayName?: string | null,
  email?: string | null,
  isUsable: (handle: string) => boolean = () => true,
): string {
  for (const source of [displayName, email?.split('@')[0]]) {
    const handle = (source ?? '')
      .normalize('NFKD')
      // Decomposed accents ("ë" is "e" and a mark) and other scripts leave no hyphen behind.
      .replace(/[^\x00-\x7f]+/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .slice(0, 24)
      .replace(/-+$/, '');
    if (SUGGESTED_HANDLE_PATTERN.test(handle) && !GENERATED_HANDLE_PATTERN.test(handle) && isUsable(handle)) {
      return handle;
    }
  }

  return '';
}
