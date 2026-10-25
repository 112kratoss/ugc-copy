/**
 * The words of a post the web and the app must agree on, in one copy shared
 * by relative import: the placeholder rule the server applies before a post or
 * a recipe listing goes public (`src/lib/marketplace-trust.ts`, mirrored by the
 * app composer's step 2 in `lib/post-new-view-model.ts`), the title both
 * composers suggest for a creation, and the handle they suggest to a creator
 * who has none yet. contracts/public-post-quality-v1.json holds the rule's
 * cases for both suites.
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
 * Words that name nothing by themselves, so they cannot turn a stand-in into a
 * title: "Demo video", "My test render" and "Untitled creation" are still
 * placeholders. Numbers count the same ("test 2").
 */
export const PLACEHOLDER_FILLER_WORDS: readonly string[] = [
  'a',
  'an',
  'the',
  'my',
  'this',
  'new',
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
];

const PLACEHOLDER_WORD_SET: ReadonlySet<string> = new Set(PLACEHOLDER_WORDS);
const PLACEHOLDER_FILLER_WORD_SET: ReadonlySet<string> = new Set(PLACEHOLDER_FILLER_WORDS);

/**
 * Lowercased words with links and ASCII punctuation taken out. Only ASCII is
 * taken out: a title in Hindi or Japanese is words too, and the earlier
 * `[^a-z0-9]` cut refused every such title as empty.
 */
function toComparableWords(value: string): string[] {
  const comparable = value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\x00-\x2f\x3a-\x40\x5b-\x60\x7b-\x7f]+/g, ' ')
    .trim();
  return comparable ? comparable.split(/\s+/) : [];
}

function isFillerWord(word: string): boolean {
  return PLACEHOLDER_FILLER_WORD_SET.has(word) || /^\d+$/.test(word);
}

/**
 * Text a public post or listing may not carry: nothing but punctuation and
 * links, only stand-in words (with filler around them), or keyboard mash
 * ("aaaaaa", "ababab", "abcabcabc").
 */
export function isPlaceholderText(value: string): boolean {
  const words = toComparableWords(value);
  if (words.length === 0) {
    return true;
  }

  if (
    words.some((word) => PLACEHOLDER_WORD_SET.has(word))
    && words.every((word) => PLACEHOLDER_WORD_SET.has(word) || isFillerWord(word))
  ) {
    return true;
  }

  const compact = words.join('');
  if (compact.length >= 6) {
    if (new Set(compact).size <= 3) {
      return true;
    }

    for (let size = 1; size <= 3; size += 1) {
      const pattern = compact.slice(0, size);
      if (pattern.repeat(Math.ceil(compact.length / size)).slice(0, compact.length) === compact) {
        return true;
      }
    }
  }

  return false;
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

const SUGGESTED_TITLE_MAX_WORDS = 8;
const SUGGESTED_TITLE_MAX_LENGTH = 60;

/** Words a cut title must not end on: "Cat surfing a giant wave at" reads as cut off. */
const TRAILING_JOINER_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'is', 'like', 'of', 'on', 'or',
  'over', 'than', 'that', 'the', 'to', 'under', 'while', 'with', 'without',
]);

function readCreationKind(model: string | null | undefined, category: string | null | undefined): CreationKind {
  const normalizedCategory = category?.trim().toLowerCase();
  // Motion control creations carry no category of their own, only the model.
  if (normalizedCategory === 'motion' || model?.toLowerCase().includes('motion')) {
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
  const kind = readCreationKind(input.model, input.category);
  if (!input.hasRecipe) {
    const fromPrompt = titleFromPrompt(input.prompt);
    if (fromPrompt) {
      return { title: fromPrompt, source: 'prompt' };
    }
  }

  return { title: input.hasRecipe ? RECIPE_TITLE_BY_KIND[kind] : TITLE_BY_KIND[kind], source: 'kind' };
}

/** The line under a title that is still the composer's suggestion, in the same words on the web and in the app. */
export function describeTitleSuggestion(source: CreationTitleSuggestion['source'], hasRecipe: boolean): string {
  if (source === 'prompt') {
    return 'Suggested from your prompt. Edit it if you like.';
  }
  return hasRecipe ? 'Suggested. Your prompt stays private inside the recipe.' : 'Suggested. Edit it if you like.';
}

const SUGGESTED_HANDLE_PATTERN = /^[a-z0-9-]{3,24}$/;
const GENERATED_HANDLE_PATTERN = /^creator-[a-f0-9]{8}$/;

/**
 * A handle to offer a creator who still has the signup placeholder
 * (`creator-xxxxxxxx`), from their name, else their email's local part:
 * "Athul S" → "athul-s". Empty when neither gives three usable characters
 * (a name in another script). The server still decides whether it is free
 * or reserved; this only saves typing.
 */
export function suggestProfileHandle(displayName?: string | null, email?: string | null): string {
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
    if (SUGGESTED_HANDLE_PATTERN.test(handle) && !GENERATED_HANDLE_PATTERN.test(handle)) {
      return handle;
    }
  }

  return '';
}
