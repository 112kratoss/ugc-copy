import type { PostResourceItem, PostResourceItemType } from './types';

/**
 * Reading decisions for an unlocked resource bundle — what a group is called,
 * what its subtitle adds, and whether a creator's saved setup can be shown
 * as settings rather than as a paragraph.
 */

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
