import {
  getPostResourceItemTypeLabel,
  type PostResourceItem,
  type PostResourceItemScope,
  type PostResourceItemType,
  type PostResourceSection,
} from '@/lib/post-resource-bundles';
import { getSafeInternalReturnPath } from '@/lib/share';

/**
 * How a recipe reads to a buyer on the web: the post page's panel, the reel
 * (which draws the same panel) and the buyer library. The app reads the same
 * recipe through `ugc-mobile/lib/post-resource-bundle-view-model.ts`; where it
 * already had an answer (settings as keys and values, link buttons named by
 * what they open, the creator's order, a card line that does not repeat its
 * title) these are its rules, ported (recipe audit B-F16, B-F17, 2026-10-27).
 */

/** The buyer's library: Studio's "Unlocked recipes" tab. */
export const UNLOCKED_RECIPES_PATH = '/creations?view=unlocks';

/** Where items with no section of their own are gathered, after the creator's sections. */
export const RECIPE_MORE_GROUP_TITLE = 'More from this post';

/**
 * The composer's name for each stored type, the title a card is given when
 * its creator names it nothing else ("Prompt or script"). The same words as
 * the app's `resourceTypeLabel`.
 */
const RECIPE_ITEM_TYPE_TITLES: Record<PostResourceItemType, string> = {
  prompt: 'Prompt or script',
  workflow: 'Workflow or project',
  reference_image: 'Reference media',
  reference_video: 'Reference media',
  reference_audio: 'Reference media',
  settings: 'Model settings',
  source_file: 'Source assets',
  preset: 'Preset',
  note: 'Guide or notes',
  external_link: 'External link',
  remix_link: 'Remix link',
  remix_access: 'Remix access',
};

function normalizeTitle(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export const GENERATION_SETUP_HEADER = 'Saved generation setup';

export interface GenerationSetup {
  title: 'Generation setup';
  entries: Array<{ key: string; value: string }>;
}

/**
 * The publish flow writes a creation's settings as a fixed shape: a header
 * line, then `Key: Value` lines (`generation-paywall.ts`). Values carry colons
 * of their own ("Aspect ratio: 9:16"), so each line splits at its first ": "
 * only. Anything that does not match the shape exactly stays text: a
 * creator's own notes are never read as settings. The app's
 * `parseGenerationSetupNotes`, ported.
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

  return { title: 'Generation setup', entries };
}

/** A link's button says what it opens, as the app's do. */
export function getRecipeItemLinkLabel(type: PostResourceItemType): string {
  if (type === 'workflow') return 'Open workflow';
  if (type === 'remix_link') return 'Open remix';
  return 'Open link';
}

export interface RecipeReadingGroup {
  id: string;
  /** The creator's section title; "More from this post" for the rest; null when the recipe has no sections. */
  title: string | null;
  description: string | null;
  scope: PostResourceItemScope | null;
  items: PostResourceItem[];
}

/**
 * A legacy recipe's remix flag stored as an item says nothing a buyer can
 * open; the panel says "Remix included" once, from the recipe itself.
 */
function isEmptyRemixAccessItem(item: PostResourceItem): boolean {
  return item.type === 'remix_access' && !item.textContent && !item.externalUrl && !item.storagePath;
}

/**
 * The creator's order: their sections as they arranged them, each with its
 * items as they arranged them, then everything with no section of its own
 * (the creation's references a recipe gains at read time, an item whose
 * section is gone) under "More from this post". The web used to lead with
 * those under "Full post resources" and regroup each section by type; the app
 * kept the creator's order (B-F17).
 */
export function groupRecipeItemsForReading(
  items: PostResourceItem[],
  sections: PostResourceSection[],
): RecipeReadingGroup[] {
  const readable = items.filter((item) => !isEmptyRemixAccessItem(item));
  const sectionIds = new Set(sections.map((section) => section.id));
  const sectionGroups: RecipeReadingGroup[] = sections
    .map((section) => ({
      id: section.id,
      title: section.title,
      description: section.description ?? null,
      // A section carries its own scope; its items may leave theirs at the default.
      scope: section.scope ?? null,
      items: readable.filter((item) => item.sectionId === section.id),
    }))
    .filter((group) => group.items.length > 0);
  const rest = readable.filter((item) => !item.sectionId || !sectionIds.has(item.sectionId));

  if (rest.length === 0) return sectionGroups;
  return [
    ...sectionGroups,
    {
      id: '__more_from_this_post__',
      title: sectionGroups.length > 0 ? RECIPE_MORE_GROUP_TITLE : null,
      description: null,
      scope: null,
      items: rest,
    },
  ];
}

/**
 * A lone item named after its card ("Prompt" under "Prompt or script",
 * "Notes" under "Guide or notes") is the card; its title would be a third
 * heading over one paragraph. The app's `shouldShowResourceItemTitle`.
 */
export function shouldShowRecipeItemTitle(
  group: { title: string | null; itemCount: number },
  item: Pick<PostResourceItem, 'title' | 'type'>,
): boolean {
  if (group.title === null || group.itemCount !== 1) return true;
  const itemTitle = normalizeTitle(item.title);
  if (!itemTitle) return false;
  if (itemTitle === normalizeTitle(group.title)) return false;
  const generic = new Set(['prompt', 'notes', 'note', 'settings', 'workflow', 'files', 'file']);
  return !(generic.has(itemTitle) && normalizeTitle(RECIPE_ITEM_TYPE_TITLES[item.type]) === normalizeTitle(group.title));
}

/**
 * A locked card's line after its title: the type, unless the title already
 * is the type ("Prompt or script · prompt" said it twice), and the count only
 * past one ("1 item" counted to one). The app's `getResourceGroupSubtitle`.
 */
export function describeRecipeCardPreview(card: {
  title: string;
  resourceType: PostResourceItemType;
  itemCount: number;
}): { typeLabel: string | null; countLabel: string | null } {
  const count = Math.max(0, Math.round(card.itemCount));
  const typeLabel = getPostResourceItemTypeLabel(card.resourceType, count || 1);
  const title = normalizeTitle(card.title);
  const repeatsTitle = title === normalizeTitle(typeLabel)
    || title === normalizeTitle(RECIPE_ITEM_TYPE_TITLES[card.resourceType]);

  return {
    typeLabel: repeatsTitle ? null : typeLabel,
    countLabel: count > 1 ? `${count} items` : null,
  };
}

/**
 * "Buy credits" from a recipe: Pricing, told where the recipe is so it can
 * offer the way back ("Back to the recipe"). The recipe's own anchor replaces
 * any the path had; the whole path travels encoded, its `#` included.
 */
export function buildRecipeTopUpHref(recipePath: string): string {
  const hashIndex = recipePath.indexOf('#');
  const path = hashIndex >= 0 ? recipePath.slice(0, hashIndex) : recipePath;
  return `/pricing?returnTo=${encodeURIComponent(`${path}#recipe`)}`;
}

/**
 * The recipe Pricing was sent from, if it is a path on this site; anything
 * else (another origin, a scheme, Pricing itself) is no way back.
 */
export function resolvePricingReturnTo(value: string | string[] | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const path = getSafeInternalReturnPath(value, '');
  if (!path || path.startsWith('/pricing')) return null;
  return path;
}
