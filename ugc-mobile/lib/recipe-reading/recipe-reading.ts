/**
 * How an unlocked recipe reads, on the web and in the app: what goes
 * together, in which order, and under which name. The web's post page, reel
 * and library and the app's Details, library and marketplace screens all
 * group a recipe with this one rule. Each used to keep its own copy, and the
 * copies drifted: the web gathered everything outside the creator's cards
 * under "More from this post", while the app made a card per stored type, so
 * a creation's reference video sat apart from its pictures under "Source
 * assets" (recipe reading review, 2026-10-29).
 *
 * It is shared with the web by relative import, like the post publish policy:
 * keep it free of React Native, Expo and Node imports. The folder keeps its own
 * self-contained tsconfig.json.
 */

export type RecipeItemType =
  | 'prompt'
  | 'workflow'
  | 'reference_image'
  | 'reference_video'
  | 'reference_audio'
  | 'source_file'
  | 'preset'
  | 'settings'
  | 'note'
  | 'external_link'
  | 'remix_link'
  | 'remix_access';

/** What the rule reads of an item. Both clients' items carry more, and keep it. */
export interface RecipeReadingItem {
  id?: string | null;
  type: RecipeItemType;
  title: string;
  sectionId?: string | null;
  sortOrder?: number | null;
  textContent?: string | null;
  externalUrl?: string | null;
  storagePath?: string | null;
  contentType?: string | null;
}

/** A card the creator made and named. */
export interface RecipeReadingSection {
  id: string;
  title: string;
  sortOrder?: number | null;
}

/** What a group holds, which decides its icon and, outside a creator's card, its name and place. */
export type RecipeGroupKind = 'prompt' | 'references' | 'settings' | 'notes' | 'workflow' | 'files' | 'links';

/**
 * The order of everything the creator did not put in a card of their own:
 * the prompt, the pictures and clips it uses, how it was set up, what the
 * creator says about it, then the project, files and links to take away.
 */
export const RECIPE_GROUP_ORDER: readonly RecipeGroupKind[] = [
  'prompt',
  'references',
  'settings',
  'notes',
  'workflow',
  'files',
  'links',
];

/** The buyer's word for each kind: a group's name outside a card, and the kind said under a card's own name. */
const RECIPE_GROUP_WORDS: Record<RecipeGroupKind, string> = {
  prompt: 'Prompt',
  references: 'References',
  settings: 'Settings',
  notes: 'Notes',
  workflow: 'Workflow',
  files: 'Files',
  links: 'Links',
};

/**
 * "Includes 1 prompt, 3 reference images, settings…": a locked recipe's
 * contents counted in the order the unlocked recipe reads.
 */
export const RECIPE_ITEM_COUNT_ORDER: readonly RecipeItemType[] = [
  'prompt',
  'reference_image',
  'reference_video',
  'reference_audio',
  'settings',
  'preset',
  'note',
  'workflow',
  'source_file',
  'external_link',
  'remix_link',
  'remix_access',
];

function normalizeTitle(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export const GENERATION_SETUP_HEADER = 'Saved generation setup';
export const GENERATION_SETUP_TITLE = 'Generation setup';

export interface GenerationSetup {
  title: typeof GENERATION_SETUP_TITLE;
  entries: Array<{ key: string; value: string }>;
}

/**
 * The publish flow writes a creation's settings as a fixed shape: a header
 * line, then `Key: Value` lines (`src/lib/generation-paywall.ts`). Values
 * carry colons of their own ("Aspect ratio: 9:16"), so each line splits at its
 * first ": " only. Anything that does not match the shape exactly stays text:
 * a creator's own notes are never read as settings.
 */
export function parseGenerationSetupNotes(text: string | null | undefined): GenerationSetup | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2 || lines[0] !== GENERATION_SETUP_HEADER) return null;

  const entries: GenerationSetup['entries'] = [];
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(': ');
    if (separator <= 0) return null;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 2).trim();
    if (!key || !value) return null;
    entries.push({ key, value });
  }

  return { title: GENERATION_SETUP_TITLE, entries };
}

export type RecipeMediaKind = 'image' | 'video' | 'audio';

/** What a file is to look at, by its content type first and its stored type after. */
export function recipeMediaKind(item: Pick<RecipeReadingItem, 'type' | 'contentType'>): RecipeMediaKind | null {
  const contentType = item.contentType?.trim().toLowerCase() ?? '';
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  if (item.type === 'reference_image') return 'image';
  if (item.type === 'reference_video') return 'video';
  if (item.type === 'reference_audio') return 'audio';
  return null;
}

/**
 * A picture, clip or sound the reader looks at rather than reads: every
 * reference, and a source file that is one. These are drawn together as one
 * gallery, after a group's text.
 */
export function isRecipeMediaItem(item: Pick<RecipeReadingItem, 'type' | 'contentType'>): boolean {
  if (item.type === 'reference_image' || item.type === 'reference_video' || item.type === 'reference_audio') return true;
  return item.type === 'source_file' && recipeMediaKind(item) !== null;
}

/** Which group an item joins when the creator put it in no card of theirs. */
export function recipeItemKind(item: Pick<RecipeReadingItem, 'type' | 'contentType' | 'textContent'>): RecipeGroupKind {
  if (isRecipeMediaItem(item)) return 'references';
  switch (item.type) {
    case 'prompt':
      return 'prompt';
    case 'settings':
    case 'preset':
      return 'settings';
    case 'note':
      // A saved generation setup is stored as a note and read as settings.
      return parseGenerationSetupNotes(item.textContent) ? 'settings' : 'notes';
    case 'workflow':
      return 'workflow';
    case 'source_file':
      return 'files';
    case 'external_link':
    case 'remix_link':
    case 'remix_access':
      return 'links';
    default:
      // A type a newer server sends and this build does not know reads as text.
      return 'notes';
  }
}

/**
 * A legacy recipe's remix flag stored as an item says nothing a reader can
 * open; each client says "Remix included" once, from the recipe itself.
 */
export function isEmptyRemixAccessItem(item: Pick<RecipeReadingItem, 'type' | 'textContent' | 'externalUrl' | 'storagePath'>): boolean {
  return item.type === 'remix_access'
    && !item.textContent?.trim()
    && !item.externalUrl?.trim()
    && !item.storagePath?.trim();
}

export interface RecipeReadingGroup<I extends RecipeReadingItem, S extends RecipeReadingSection> {
  /** The creator's section id, or `recipe-kind:<kind>` for a group gathered by kind. */
  id: string;
  kind: RecipeGroupKind;
  /** The creator's card, or null for a group gathered by kind. */
  section: S | null;
  /** The card's name, or the buyer's word for the kind ("Prompt", "References"). */
  title: string;
  /** What is read, copied or opened, in the creator's order. */
  items: I[];
  /** The pictures, clips and sounds, drawn together after the text. */
  media: I[];
}

/**
 * The names the composer gives an item or a card by default, and the buyer's
 * words for the kinds. A lone item called one of these, in a card called one
 * of these, is the card: its title would be a third heading over one
 * paragraph.
 */
const GENERIC_RECIPE_TITLES = new Set([
  'prompt',
  'prompts',
  'prompt or script',
  'reference',
  'references',
  'reference media',
  'settings',
  'model settings',
  'preset',
  'generation setup',
  'saved generation setup',
  'note',
  'notes',
  'guide or notes',
  'workflow',
  'workflows',
  'workflow or project',
  'file',
  'files',
  'source assets',
  'link',
  'links',
  'external link',
  'remix link',
  'remix access',
]);

export function isGenericRecipeTitle(title: string | null | undefined): boolean {
  return GENERIC_RECIPE_TITLES.has(normalizeTitle(title));
}

function inCreatorOrder<T extends { sortOrder?: number | null }>(values: readonly T[]): T[] {
  return values
    .map((value, index) => ({
      value,
      index,
      order: typeof value.sortOrder === 'number' && Number.isFinite(value.sortOrder) ? value.sortOrder : index,
    }))
    .sort((left, right) => left.order - right.order || left.index - right.index)
    .map(({ value }) => value);
}

function groupTitle(
  section: RecipeReadingSection | null,
  kind: RecipeGroupKind,
  text: RecipeReadingItem[],
  media: RecipeReadingItem[],
): string {
  const loneSetup = text.length === 1 && media.length === 0 && parseGenerationSetupNotes(text[0].textContent) !== null;
  const sectionTitle = section?.title.trim() ?? '';
  if (sectionTitle) {
    // A card left under a form name ("Guide or notes") reads as what it holds.
    return loneSetup && isGenericRecipeTitle(sectionTitle) ? GENERATION_SETUP_TITLE : sectionTitle;
  }
  if (loneSetup) return GENERATION_SETUP_TITLE;
  const count = text.length + media.length;
  if (kind === 'prompt' && count > 1) return 'Prompts';
  if (kind === 'workflow' && count > 1) return 'Workflows';
  return RECIPE_GROUP_WORDS[kind];
}

function buildGroup<I extends RecipeReadingItem, S extends RecipeReadingSection>(
  id: string,
  section: S | null,
  groupItems: I[],
  kind?: RecipeGroupKind,
): RecipeReadingGroup<I, S> {
  const items = groupItems.filter((item) => !isRecipeMediaItem(item));
  const media = groupItems.filter((item) => isRecipeMediaItem(item));
  // A card is what its first text says it is; a card of pictures alone is references.
  const groupKind = kind ?? (items.length > 0 ? recipeItemKind(items[0]) : 'references');
  return { id, kind: groupKind, section, title: groupTitle(section, groupKind, items, media), items, media };
}

const KIND_GROUP_ID_PREFIX = 'recipe-kind:';

/**
 * A recipe in reading order:
 *
 * 1. the creator's cards, in the order they arranged them, each with its
 *    items in their order;
 * 2. everything the creator put in no card (the creation's own references,
 *    which a recipe gains when it is read, an item whose card is gone, an
 *    older recipe's loose items), gathered by kind in `RECIPE_GROUP_ORDER`;
 * 3. except the gathered references, which come straight after the first
 *    group holding a prompt: the prompt names them ("@ali").
 *
 * Inside every group the text comes first and its pictures, clips and sounds
 * after, as one gallery. A legacy remix flag with nothing in it is left out.
 */
export function groupRecipeForReading<I extends RecipeReadingItem, S extends RecipeReadingSection>(
  items: readonly I[],
  sections: readonly S[] = [],
): Array<RecipeReadingGroup<I, S>> {
  const readable = inCreatorOrder(items.filter((item) => !isEmptyRemixAccessItem(item)));
  const orderedSections = inCreatorOrder(sections);
  const sectionIds = new Set(orderedSections.map((section) => section.id));

  const sectionGroups = orderedSections.flatMap((section) => {
    const sectionItems = readable.filter((item) => item.sectionId === section.id);
    return sectionItems.length > 0 ? [buildGroup<I, S>(section.id, section, sectionItems)] : [];
  });
  const loose = readable.filter((item) => !item.sectionId || !sectionIds.has(item.sectionId));
  const kindGroups = RECIPE_GROUP_ORDER.flatMap((kind) => {
    const kindItems = loose.filter((item) => recipeItemKind(item) === kind);
    return kindItems.length > 0 ? [buildGroup<I, S>(`${KIND_GROUP_ID_PREFIX}${kind}`, null, kindItems, kind)] : [];
  });

  const references = kindGroups.find((group) => group.kind === 'references');
  const groups = [...sectionGroups, ...kindGroups.filter((group) => group !== references)];
  if (!references) return groups;
  const promptAt = groups.findIndex((group) => group.items.some((item) => item.type === 'prompt'));
  groups.splice(promptAt >= 0 ? promptAt + 1 : sectionGroups.length, 0, references);
  return groups;
}

const RECIPE_KIND_STEMS: Record<RecipeGroupKind, readonly string[]> = {
  prompt: ['prompt', 'script'],
  references: ['reference', 'image', 'photo', 'picture', 'video', 'clip', 'audio', 'media'],
  settings: ['setting', 'setup', 'preset'],
  notes: ['note', 'guide'],
  workflow: ['workflow', 'project'],
  files: ['file', 'asset', 'source'],
  links: ['link'],
};

/** "Exact generation prompt" already says it is a prompt; "Why this works" does not say it is notes. */
function titleNamesKind(title: string, kind: RecipeGroupKind): boolean {
  const words = normalizeTitle(title).split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((word) => RECIPE_KIND_STEMS[kind].some((stem) => word.startsWith(stem)));
}

const RECIPE_MEDIA_WORDS: Record<RecipeMediaKind, readonly [string, string]> = {
  image: ['image', 'images'],
  video: ['video', 'videos'],
  audio: ['audio clip', 'audio clips'],
};

/** "3 images · 1 video": what a gallery holds. */
export function describeRecipeMedia(media: ReadonlyArray<Pick<RecipeReadingItem, 'type' | 'contentType'>>): string {
  const counts: Record<RecipeMediaKind, number> = { image: 0, video: 0, audio: 0 };
  for (const item of media) {
    const kind = recipeMediaKind(item);
    if (kind) counts[kind] += 1;
  }
  return (['image', 'video', 'audio'] as const)
    .filter((kind) => counts[kind] > 0)
    .map((kind) => `${counts[kind]} ${RECIPE_MEDIA_WORDS[kind][counts[kind] === 1 ? 0 : 1]}`)
    .join(' · ');
}

/**
 * The line under a group's name: the kind, under a card whose own name does
 * not say it (a prompt's box says so itself), then how much it holds, past
 * one. A gallery counts its pictures and clips ("3 images · 1 video").
 */
export function describeRecipeGroup(group: Pick<RecipeReadingGroup<RecipeReadingItem, RecipeReadingSection>, 'kind' | 'section' | 'title' | 'items' | 'media'>): string {
  const parts: string[] = [];
  if (group.section && group.kind !== 'prompt' && group.title !== GENERATION_SETUP_TITLE && !titleNamesKind(group.title, group.kind)) {
    parts.push(RECIPE_GROUP_WORDS[group.kind]);
  }
  const total = group.items.length + group.media.length;
  if (total > 1) {
    parts.push(group.items.length === 0 ? describeRecipeMedia(group.media) : `${total} items`);
  }
  return parts.join(' · ');
}

/**
 * A locked card's line after its public title: its kind, unless the title
 * says it, and its count past one. Nothing is open yet, so a prompt card says
 * it is one too ("Hook · Prompt").
 */
export function describeRecipeCardPreview(card: { title: string; resourceType: RecipeItemType; itemCount: number }): {
  kindLabel: string | null;
  countLabel: string | null;
} {
  const kind = recipeItemKind({ type: card.resourceType, contentType: null, textContent: null });
  const count = Math.max(0, Math.round(card.itemCount));
  return {
    kindLabel: titleNamesKind(card.title, kind) ? null : RECIPE_GROUP_WORDS[kind],
    countLabel: count > 1 ? `${count} items` : null,
  };
}

/**
 * Whether an item's own title is printed in its group. In a group of one, an
 * item named like its group, or named by a form label in a group named by
 * one, is the group: "Prompt" in "Prompt or script".
 */
export function shouldShowRecipeItemTitle(
  group: { title: string; itemCount: number },
  item: Pick<RecipeReadingItem, 'title'>,
): boolean {
  if (group.itemCount !== 1) return true;
  const title = normalizeTitle(item.title);
  if (!title) return false;
  if (title === normalizeTitle(group.title)) return false;
  return !(isGenericRecipeTitle(item.title) && isGenericRecipeTitle(group.title));
}

/** A link's button says what it opens. */
export function recipeLinkLabel(type: RecipeItemType): string {
  if (type === 'workflow') return 'Open workflow';
  if (type === 'remix_link') return 'Open remix';
  return 'Open link';
}

const RECIPE_FILE_TYPE_NAMES: Record<string, string> = {
  'application/pdf': 'PDF',
  'application/zip': 'ZIP',
  'application/x-zip-compressed': 'ZIP',
  'application/gzip': 'GZ',
  'application/x-gzip': 'GZ',
  'application/json': 'JSON',
  'application/yaml': 'YAML',
  'application/x-yaml': 'YAML',
  'text/yaml': 'YAML',
  'text/plain': 'Text',
  'text/markdown': 'Markdown',
  'text/csv': 'CSV',
};

const RECIPE_MEDIA_SUBTYPE_NAMES: Record<string, string> = {
  jpeg: 'JPG',
  pjpeg: 'JPG',
  quicktime: 'MOV',
  'svg+xml': 'SVG',
  'x-wav': 'WAV',
  'x-m4a': 'M4A',
};

/** "PDF", "PNG image", "MOV video", "MP3 audio": a file's type in a reader's words, never its MIME type. */
export function recipeFileTypeName(contentType: string | null | undefined): string {
  const value = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!value) return '';
  const known = RECIPE_FILE_TYPE_NAMES[value];
  if (known) return known;
  const [family, subtype = ''] = value.split('/');
  if (family !== 'image' && family !== 'video' && family !== 'audio') return 'File';
  const name = family === 'audio' && subtype === 'mpeg'
    ? 'MP3'
    : RECIPE_MEDIA_SUBTYPE_NAMES[subtype] ?? subtype.replace(/^x-/, '').toUpperCase();
  return name ? `${name} ${family}` : family;
}

export function formatRecipeFileSize(sizeBytes: number | null | undefined): string {
  if (!sizeBytes || !Number.isFinite(sizeBytes) || sizeBytes <= 0) return '';
  if (sizeBytes < 1024) return `${Math.round(sizeBytes)} B`;
  if (sizeBytes < 1024 * 1024) return `${Math.round(sizeBytes / 102.4) / 10} KB`;
  return `${Math.round(sizeBytes / 1024 / 102.4) / 10} MB`;
}

/** "PDF · 2.1 MB": a file row's facts. */
export function describeRecipeFile(contentType: string | null | undefined, sizeBytes: number | null | undefined): string {
  return [recipeFileTypeName(contentType), formatRecipeFileSize(sizeBytes)].filter(Boolean).join(' · ');
}
