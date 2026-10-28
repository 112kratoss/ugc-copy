import type {
  PostResourceBundleLockedPreview,
  PostResourceItem,
  PostResourceItemType,
  PostResourceKind,
} from './types';
import { formatUnlockDate } from './unlock-library-view-model';

/**
 * Reading decisions for an unlocked resource bundle — what a group is called,
 * what its subtitle adds, and whether a creator's saved setup can be shown
 * as settings rather than as a paragraph.
 */

/**
 * The line older composers wrote for the prompt card the app attaches on the
 * creator's behalf. It only restates the card's own title, so it is filler
 * above the prompt rather than anything the creator meant to say.
 *
 * Nothing writes it any more, and the backend now strips it from what it stores
 * and serves. This stays as the last guard, for the window where an app built
 * before that change is still talking to a backend built before it too — the
 * two ship separately, so that pairing is real. `composer-prompt-boilerplate`
 * on the web side pins this string against the backend's copy.
 */
export const COMPOSER_PROMPT_CARD_PREVIEW = 'The reusable prompt used for this creation.';

/** The creator's own words, or nothing when all we have is our own boilerplate. */
export function creatorAuthoredDescription(
  resourceType: PostResourceItemType | undefined,
  description: string | null | undefined
) {
  const trimmed = description?.trim();
  if (!trimmed) return null;
  if (resourceType === 'prompt' && trimmed === COMPOSER_PROMPT_CARD_PREVIEW) return null;
  return trimmed;
}

export function resourceTypeLabel(type: PostResourceItemType) {
  if (type === 'prompt') return 'Prompt or script';
  if (type === 'workflow') return 'Workflow or project';
  if (type === 'reference_image' || type === 'reference_video' || type === 'reference_audio') return 'Reference media';
  if (type === 'settings') return 'Model settings';
  if (type === 'source_file') return 'Source assets';
  if (type === 'preset') return 'Preset';
  if (type === 'note') return 'Guide or notes';
  if (type === 'remix_link') return 'Remix link';
  if (type === 'remix_access') return 'Remix access';
  return 'External link';
}

export function formatItemCount(count: number) {
  const normalized = Math.max(0, Math.round(count));
  return `${normalized} ${normalized === 1 ? 'item' : 'items'}`;
}

/**
 * What a recipe holds, in the words the web uses (`getPostResourceKindLabel`).
 * The one table for every chip and summary in the app: four copies of it had
 * drifted apart before.
 */
const RESOURCE_KIND_LABELS: Record<PostResourceKind, string> = {
  prompt: 'Prompt',
  workflow: 'Workflow',
  files: 'Files',
  notes: 'Notes',
  remix: 'Remix',
};

/** '' for a kind this build does not know, so callers can drop it. */
export function resourceKindLabel(kind: string) {
  return RESOURCE_KIND_LABELS[kind as PostResourceKind] ?? '';
}

// Ported from src/lib/post-resource-bundles.ts (`RESOURCE_ITEM_COUNT_ORDER`,
// `RESOURCE_ITEM_LABELS`), so a locked recipe counts its contents in the same
// order and the same words on both platforms.
const RESOURCE_ITEM_COUNT_ORDER: PostResourceItemType[] = [
  'prompt',
  'workflow',
  'reference_image',
  'reference_video',
  'reference_audio',
  'source_file',
  'preset',
  'settings',
  'note',
  'external_link',
  'remix_link',
  'remix_access',
];

const RESOURCE_ITEM_COUNT_LABELS: Record<PostResourceItemType, { singular: string; plural: string }> = {
  prompt: { singular: 'prompt', plural: 'prompts' },
  workflow: { singular: 'workflow', plural: 'workflows' },
  reference_image: { singular: 'reference image', plural: 'reference images' },
  reference_video: { singular: 'reference video', plural: 'reference videos' },
  reference_audio: { singular: 'reference audio', plural: 'reference audio files' },
  source_file: { singular: 'file', plural: 'files' },
  preset: { singular: 'preset', plural: 'presets' },
  settings: { singular: 'settings', plural: 'settings' },
  note: { singular: 'note', plural: 'notes' },
  external_link: { singular: 'link', plural: 'links' },
  remix_link: { singular: 'remix link', plural: 'remix links' },
  remix_access: { singular: 'remix access', plural: 'remix access' },
};

// Settings read as one thing however many items hold them: "settings", never
// "2 settings" (the web's `UNCOUNTED_RESOURCE_ITEM_TYPES`).
const UNCOUNTED_RESOURCE_ITEM_TYPES = new Set<PostResourceItemType>(['settings']);

/**
 * What a recipe holds, in buyer words: "1 prompt, 2 files, settings, 1 link",
 * the web's `formatPostResourceBundleCountSummary`. Cards ("sections") are how
 * the creator arranged it, not something a buyer gets, so they are not counted
 * (recipe audit B-F16).
 */
export function formatPostResourceBundleCountSummary(
  preview: Pick<PostResourceBundleLockedPreview, 'itemCounts'> | null | undefined
) {
  const parts: string[] = [];
  for (const type of RESOURCE_ITEM_COUNT_ORDER) {
    const count = Math.max(0, Math.round(preview?.itemCounts?.[type] ?? 0));
    if (count === 0) continue;
    const labels = RESOURCE_ITEM_COUNT_LABELS[type];
    const label = count === 1 ? labels.singular : labels.plural;
    parts.push(UNCOUNTED_RESOURCE_ITEM_TYPES.has(type) ? label : `${count} ${label}`);
  }

  return parts.join(', ');
}

/** "12 sold" for a paid recipe, "12 opened" for a free one (web: `formatUnlockCountLabel`). */
export function formatUnlockCountLabel(accessMode: 'free' | 'paid', count: number) {
  const normalized = Math.max(0, Math.round(count));
  return accessMode === 'free' ? `${normalized} opened` : `${normalized} sold`;
}

/**
 * The locked card's line of social proof and freshness, "12 sold · Updated
 * Oct 3, 2026", the facts the web panel's header carries. The server keeps
 * both counts public for exactly this. Since 2026-10-17 a free unlock is not
 * a sale, so a free recipe's "opened" reads `freeUnlockCount` and a paid one's
 * "sold" reads `salesCount`, whatever the other holds from an earlier price.
 */
export function formatLockedBundleFacts({
  accessMode,
  salesCount,
  freeUnlockCount,
  updatedAt,
}: {
  accessMode: 'free' | 'paid';
  salesCount?: number | null;
  freeUnlockCount?: number | null;
  updatedAt?: string | null;
}) {
  const parts: string[] = [];
  const count = accessMode === 'free' ? freeUnlockCount : salesCount;
  if (typeof count === 'number' && Number.isFinite(count)) {
    parts.push(formatUnlockCountLabel(accessMode, count));
  }
  const updated = updatedAt ? formatUnlockDate(updatedAt) : '';
  if (updated) parts.push(`Updated ${updated}`);
  return parts.join(' · ');
}

function normalizeTitle(value: string) {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * A subtitle only says what the title did not. A group the creator named
 * "Prompt or script" used to read "Prompt or script · Prompt or script ·
 * 1 item" — the type echoed the title and the count counted to one.
 */
export function getResourceGroupSubtitle(group: { title: string; resourceType: PostResourceItemType; itemCount: number }) {
  const parts: string[] = [];
  const typeLabel = resourceTypeLabel(group.resourceType);
  if (normalizeTitle(typeLabel) !== normalizeTitle(group.title)) parts.push(typeLabel);
  if (group.itemCount > 1) parts.push(formatItemCount(group.itemCount));
  return parts.join(' · ');
}

/**
 * A lone item named after its group ("Prompt" under "Prompt or script",
 * "Notes" under "Guide or notes") is the group; its title is a third heading
 * over one paragraph.
 */
export function shouldShowResourceItemTitle(
  group: { title: string; resourceType: PostResourceItemType; itemCount: number },
  item: Pick<PostResourceItem, 'title' | 'type'>
) {
  if (group.itemCount !== 1) return true;
  const itemTitle = normalizeTitle(item.title);
  if (!itemTitle) return false;
  if (itemTitle === normalizeTitle(group.title)) return false;
  const generic = new Set(['prompt', 'notes', 'note', 'settings', 'workflow', 'files', 'file']);
  return !(generic.has(itemTitle) && normalizeTitle(resourceTypeLabel(item.type)) === normalizeTitle(group.title));
}

export const GENERATION_SETUP_HEADER = 'Saved generation setup';

export interface GenerationSetup {
  title: 'Generation setup';
  entries: Array<{ key: string; value: string }>;
}

/**
 * The publish flow writes a creation's settings into the notes as a fixed
 * shape — a header line, then `Key: Value` lines (web: generation-paywall.ts).
 * Values carry colons of their own ("Aspect ratio: 9:16"), so each line
 * splits on its first ": " only. Anything that does not match the shape
 * exactly stays a paragraph; a creator's hand-written notes are never
 * reinterpreted as settings.
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
