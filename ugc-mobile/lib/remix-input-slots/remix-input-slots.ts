/**
 * Input slots: what a remix is given in place of an input its creator did not
 * share (owner, 2026-11-03).
 *
 * A remix hands over a creation's prompt, model and settings, but its saved
 * inputs (reference pictures, frames, clips, tracks, a named subject's
 * pictures, a motion run's character and clip) only where the creator shares
 * them. For every input it does not, the remix source names an empty slot:
 * what kind of input went there and, when the prompt mentions it, the @handle
 * it goes by. The remixer adds their own in its place and the prompt works
 * unchanged. A slot never carries the creator's file, its link, its stored
 * name or anything else that points at it: its name is its role's own.
 *
 * Shared by the server and the web creators (`src/lib/remix-source.ts`,
 * `src/lib/remix-source-server.ts`, `src/app/create-*`) and the app, by
 * relative import, so it stays free of React Native, Expo and Node imports.
 */

export type RemixInputSlotKind = 'image' | 'video' | 'audio';

export const REMIX_INPUT_SLOT_ROLES = [
  'reference_image',
  'start_frame',
  'end_frame',
  'reference_video',
  'reference_audio',
  'character_image',
  'motion_reference_video',
  // One slot per named subject (Kling O3), however many pictures it fused.
  'subject',
] as const;
export type RemixInputSlotRole = (typeof REMIX_INPUT_SLOT_ROLES)[number];

export interface RemixInputSlot {
  /** `slot-1`, `slot-2`, … in the run's order: stable within one bundle, never a stored row's id. */
  id: string;
  kind: RemixInputSlotKind;
  role: RemixInputSlotRole;
  /**
   * The handle the creation's prompt mentions this input by (`@product`), or
   * null when the prompt does not mention it. Only a mentioned handle is
   * given: it is in the prompt the remixer reads anyway, while an unmentioned
   * one can have been made from an upload's file name.
   */
  handle: string | null;
  /**
   * What the slot is called: its role's own name, numbered where the role repeats ("Reference image 2").
   * Nothing else of the input goes with it: not a clip's length, nor how many pictures a subject fused,
   * which say something of what the creator kept to themselves and which no creator reads.
   */
  name: string;
}

/** Which creator a run belongs to: a motion run's inputs are its character and its clip whatever their stored roles. */
export type RemixInputSlotTool = 'image' | 'video' | 'motion';

/** A saved input as the slot builder reads it: never its file, link or name. */
export interface RemixInputSlotSource {
  mediaType: string;
  role: string;
  sortOrder: number;
  metadata?: Record<string, unknown> | null;
}

// The mention grammar: copies of the server's (`isValidElementHandle` and `HANDLE_PATTERN` in
// src/lib/image-elements.ts), since this module imports nothing. The parity test in
// ugc-mobile/__tests__/media-creation-view-model.test.ts holds both to the server's.
const HANDLE_PATTERN = /^@[a-z0-9_]+$/;
const PROMPT_HANDLE_PATTERN = /(^|[^\w])(@[a-z0-9_]+)(?=$|[^\w])/g;

const ROLE_NAMES: Record<RemixInputSlotRole, string> = {
  reference_image: 'Reference image',
  start_frame: 'Start frame',
  end_frame: 'End frame',
  reference_video: 'Reference video',
  reference_audio: 'Reference audio',
  character_image: 'Character image',
  motion_reference_video: 'Motion video',
  subject: 'Subject',
};

/** Roles a run holds more than one of: their slots are numbered. */
const REPEATING_ROLES = new Set<RemixInputSlotRole>(['reference_image', 'reference_video', 'reference_audio', 'subject']);

/**
 * Roles a run holds one of (a start frame, an end frame, a motion run's character and its clip): the
 * first input of the role is the run's, and a later one neither restores nor gets a slot.
 */
export const SINGLE_USE_REMIX_SLOT_ROLES: ReadonlySet<RemixInputSlotRole> = new Set(
  REMIX_INPUT_SLOT_ROLES.filter((role) => !REPEATING_ROLES.has(role)),
);

const ROLE_KINDS: Record<RemixInputSlotRole, RemixInputSlotKind> = {
  reference_image: 'image',
  start_frame: 'image',
  end_frame: 'image',
  reference_video: 'video',
  reference_audio: 'audio',
  character_image: 'image',
  motion_reference_video: 'video',
  subject: 'image',
};

/** The words a run is written in: its prompt, or a story's shots beside it, each read on its own. */
export type RemixSlotWords = string | readonly (string | null | undefined)[] | null | undefined;

function promptHandles(words: RemixSlotWords): Set<string> {
  const handles = new Set<string>();
  for (const text of typeof words === 'string' ? [words] : words ?? []) {
    (text ?? '').replace(PROMPT_HANDLE_PATTERN, (match, _prefix: string, handle: string) => {
      handles.add(handle);
      return match;
    });
  }
  return handles;
}

function readHandle(metadata: Record<string, unknown> | null | undefined): string | null {
  const handle = metadata?.handle;
  return typeof handle === 'string' && HANDLE_PATTERN.test(handle) ? handle : null;
}

/**
 * A stored input's slot role for a run of `tool`, or null for an input no creator restores: what the
 * builder below reads, and what the server splits a run's inputs by before it builds them.
 */
export function remixInputSlotRoleFor(source: Pick<RemixInputSlotSource, 'mediaType' | 'role'>, tool: RemixInputSlotTool): RemixInputSlotRole | null {
  if (tool === 'motion') {
    // The catalog path stored these under plain reference roles until motion
    // runs got motion roles: a motion run holds one picture and one clip.
    if (source.role === 'character_image' || (source.mediaType === 'image' && source.role === 'reference_image')) return 'character_image';
    if (source.role === 'motion_reference_video' || (source.mediaType === 'video' && source.role === 'reference_video')) return 'motion_reference_video';
    return null;
  }
  if (source.role === 'subject_image') return tool === 'video' ? 'subject' : null;
  if (tool === 'image') return source.role === 'reference_image' && source.mediaType === 'image' ? 'reference_image' : null;
  switch (source.role) {
    case 'reference_image':
    case 'start_frame':
    case 'end_frame':
      return source.mediaType === 'image' ? source.role : null;
    case 'reference_video':
      return source.mediaType === 'video' ? 'reference_video' : null;
    case 'reference_audio':
      return source.mediaType === 'audio' ? 'reference_audio' : null;
    default:
      return null;
  }
}

/**
 * The slots for a run's saved inputs, in the run's order: one per input, one
 * per named subject, and at most one character and one clip for a motion run.
 * A handle is kept only where the run's words mention it: `prompt` is the
 * creation's prompt, or that and each of a story's shots, since a story keeps
 * only its first shot as the prompt while the remixer is given every shot.
 */
export function buildRemixInputSlots(
  sources: readonly RemixInputSlotSource[],
  options: { tool: RemixInputSlotTool; prompt: RemixSlotWords },
): RemixInputSlot[] {
  const mentioned = promptHandles(options.prompt);
  const ordered = [...sources].sort((left, right) => left.sortOrder - right.sortOrder);
  const counts = new Map<RemixInputSlotRole, number>();
  const subjectKeys = new Set<string>();
  const slots: RemixInputSlot[] = [];
  const singleUse = new Set<RemixInputSlotRole>();

  for (const source of ordered) {
    const role = remixInputSlotRoleFor(source, options.tool);
    if (!role) continue;
    if (SINGLE_USE_REMIX_SLOT_ROLES.has(role)) {
      // A run holds one start frame, one end frame, one character and one motion clip.
      if (singleUse.has(role)) continue;
      singleUse.add(role);
    }
    const storedHandle = readHandle(source.metadata);
    const handle = storedHandle && mentioned.has(storedHandle) ? storedHandle : null;

    // A subject's pictures share its handle, or its index on runs that kept none: one slot for them all.
    if (role === 'subject') {
      const subjectIndex = source.metadata?.subjectIndex;
      const subjectKey = storedHandle ?? (typeof subjectIndex === 'number' ? `index:${subjectIndex}` : null);
      if (!subjectKey || subjectKeys.has(subjectKey)) continue;
      subjectKeys.add(subjectKey);
    }

    const count = (counts.get(role) ?? 0) + 1;
    counts.set(role, count);
    slots.push({
      id: `slot-${slots.length + 1}`,
      kind: ROLE_KINDS[role],
      role,
      handle,
      name: REPEATING_ROLES.has(role) ? `${ROLE_NAMES[role]} ${count}` : ROLE_NAMES[role],
    });
  }

  return slots;
}

/** A bundle's slots as a client reads them: anything malformed is left out. */
export function parseRemixInputSlots(value: unknown): RemixInputSlot[] {
  if (!Array.isArray(value)) return [];
  const slots: RemixInputSlot[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;
    const role = candidate.role;
    if (typeof candidate.id !== 'string' || !candidate.id) continue;
    if (typeof role !== 'string' || !(REMIX_INPUT_SLOT_ROLES as readonly string[]).includes(role)) continue;
    const slotRole = role as RemixInputSlotRole;
    const handle = typeof candidate.handle === 'string' && HANDLE_PATTERN.test(candidate.handle) ? candidate.handle : null;
    const name = typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name.trim() : ROLE_NAMES[slotRole];
    slots.push({ id: candidate.id, kind: ROLE_KINDS[slotRole], role: slotRole, handle, name });
  }
  return slots;
}

/** The roles each creator has a place for: a slot of any other role is left out of its draft. */
export const REMIX_INPUT_SLOT_TOOL_ROLES: Record<RemixInputSlotTool, readonly RemixInputSlotRole[]> = {
  image: ['reference_image'],
  video: ['start_frame', 'end_frame', 'reference_image', 'reference_video', 'reference_audio', 'subject'],
  motion: ['character_image', 'motion_reference_video'],
};

/** A bundle's slots as `tool`'s creator holds them: read defensively, and only those it has a place for. */
export function parseRemixInputSlotsForTool(tool: RemixInputSlotTool, value: unknown): RemixInputSlot[] {
  return parseRemixInputSlots(value).filter((slot) => REMIX_INPUT_SLOT_TOOL_ROLES[tool].includes(slot.role));
}

/** The slot's title on its empty box: the handle the prompt knows it by, else its name. */
export function remixInputSlotTitle(slot: Pick<RemixInputSlot, 'handle' | 'name'>): string {
  return slot.handle ?? slot.name;
}

/** The empty box's call to action. */
export function remixInputSlotAction(slot: Pick<RemixInputSlot, 'kind' | 'role'>): string {
  if (slot.role === 'subject') return 'Add your pictures';
  if (slot.kind === 'video') return 'Add your video';
  if (slot.kind === 'audio') return 'Add your audio';
  return 'Add your image';
}

/**
 * The restore issue a remix source raises when it could not read the inputs it keeps back (the run's
 * rows, or the copies a bought recipe holds): it names no slot then, and the clients read it as a failed
 * restore, which reads the source again. The app keeps it with a remix session, so any later visit does.
 */
export const WITHHELD_INPUTS_RESTORE_ISSUE = 'withheld-inputs';

/**
 * The name over that line: the app's banner and the web's notice card. Either can be put away for the
 * rest of the remix (2026-11-03), as a box nobody mentions may stay empty for good.
 */
export const REMIX_INPUT_SLOTS_NOTICE_LABEL = 'Remix source';

/** The line above a remix whose creator kept inputs to themselves; null when none are missing. */
export function remixInputSlotsNotice(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return count === 1
    ? 'The creator kept 1 input to themselves. Add your own in the empty box.'
    : `The creator kept ${count} inputs to themselves. Add your own in the empty boxes.`;
}

/** "@a", "@a and @b", "@a, @b and @c": each handle once. */
function listedHandles(handles: readonly string[]): string[] {
  return [...new Set(handles)];
}

function handlesInSentence(unique: readonly string[]): string {
  return unique.length === 1 ? unique[0] : `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`;
}

/**
 * What a prompt that mentions an empty slot says in place of an unknown
 * mention: the run cannot start with it, so the remixer fills the box or takes
 * the mention out.
 */
export function unfilledRemixSlotsMessage(handles: readonly string[]): string | null {
  const unique = listedHandles(handles);
  if (unique.length === 0) return null;
  if (unique.length === 1) return `Add your own for ${unique[0]} in its box, or take ${unique[0]} out of the prompt.`;
  return `Add your own for ${handlesInSentence(unique)} in their boxes, or take them out of the prompt.`;
}

/**
 * What a prompt that mentions an empty slot says once the chosen model has no place for its kind (a
 * switch to a model, or to a setting, that takes no such input): its box is gone from the page, not
 * from the remix, so the remixer switches back, where the box waits as they left it, or takes the
 * mention out. It read as an unknown mention until 2026-11-03, as if the remix had never had it.
 * `modelName` is the chosen model's name, or null where none is known.
 */
export function unplacedRemixSlotsMessage(handles: readonly string[], modelName: string | null | undefined): string | null {
  const unique = listedHandles(handles);
  if (unique.length === 0) return null;
  const model = modelName?.trim() || 'This model';
  const takeOut = unique.length === 1 ? `take ${unique[0]} out of the prompt` : 'take them out of the prompt';
  return `${model} has no place for ${handlesInSentence(unique)}. Switch back, or ${takeOut}.`;
}

/** The handles of slots still empty, for a creator's mention check. */
export function remixInputSlotHandles(slots: readonly Pick<RemixInputSlot, 'handle'>[]): string[] {
  return slots.flatMap((slot) => (slot.handle ? [slot.handle] : []));
}

/**
 * What each creator reads off its chosen model to place a remix's empty slots and to tell which of
 * them are answered: whether that model's clips answer to an @handle (Kling 3.0's video elements),
 * and whether its tracks do (a model whose audio references are named). Unknown (undefined) places,
 * and counts, every clip and track.
 */
export interface RemixSlotPlaceOptions {
  clipsTakeHandles?: boolean;
  tracksTakeHandles?: boolean;
}

/** What a remix holds that can answer to a handle, by kind: each creator lists its own media's handles. */
export interface RemixHeldHandles {
  pictures?: readonly (string | null | undefined)[];
  subjects?: readonly (string | null | undefined)[];
  clips?: readonly (string | null | undefined)[];
  tracks?: readonly (string | null | undefined)[];
}

/**
 * The handles that answer a remix's boxes, by one rule for both creators (2026-11-03): what the remix
 * holds under a handle the run names, so a mention of it reaches that media. A picture or a subject
 * always does; a clip or a track only on a model that takes it under a handle (`options`), since a
 * plain clip answers no mention and its box would hide while the mention went unanswered.
 */
export function remixSlotAnsweringHandles(held: RemixHeldHandles, options: RemixSlotPlaceOptions = {}): string[] {
  return [
    ...(held.pictures ?? []),
    ...(held.subjects ?? []),
    ...(options.clipsTakeHandles === false ? [] : held.clips ?? []),
    ...(options.tracksTakeHandles === false ? [] : held.tracks ?? []),
  ].filter((handle): handle is string => typeof handle === 'string' && HANDLE_PATTERN.test(handle));
}

/**
 * Whether the chosen model has a place for a slot: its role among those the model draws a box for
 * (`placedRoles`, read off the model by each creator; null, before the model is known, places every
 * role), and for a clip the prompt mentions by its handle, clips that answer to one. A plain clip
 * answers no mention (Seedance 2's), so on such a model a box for "@dance" held the run for a
 * mention its fill could never answer, on the web and in the app (2026-11-03): it has no place there.
 */
export function remixInputSlotPlaced(
  slot: Pick<RemixInputSlot, 'role' | 'handle'>,
  placedRoles: ReadonlySet<RemixInputSlotRole> | null,
  options: RemixSlotPlaceOptions = {},
): boolean {
  if (placedRoles && !placedRoles.has(slot.role)) return false;
  return !(slot.role === 'reference_video' && slot.handle && options.clipsTakeHandles === false);
}

/**
 * A remix's empty slots sorted by whether the chosen model has a place for them (`remixInputSlotPlaced`):
 * those it draws a box for, and those it has nowhere to put. A slot without a place stays the remix's,
 * for a switch back.
 */
export function remixInputSlotsByPlace<T extends Pick<RemixInputSlot, 'role' | 'handle'>>(
  slots: readonly T[],
  placedRoles: ReadonlySet<RemixInputSlotRole> | null,
  options: RemixSlotPlaceOptions = {},
): { placed: T[]; unplaced: T[] } {
  const placed = slots.filter((slot) => remixInputSlotPlaced(slot, placedRoles, options));
  return { placed, unplaced: slots.filter((slot) => !placed.includes(slot)) };
}

/**
 * The boxes still open, by one rule for both creators (2026-11-03): a box whose handle something the
 * remix holds already answers (a picture added through the add tile and named so) is not waited on,
 * drawn or counted in the notice, as a fill there would only add a second reference under a renamed
 * handle. It opens again if that reference goes. A box with no handle waits for its own fill.
 */
export function openRemixInputSlots<T extends Pick<RemixInputSlot, 'handle'>>(
  slots: readonly T[],
  answeredHandles: Iterable<string>,
): T[] {
  const answered = new Set(answeredHandles);
  return slots.filter((slot) => !(slot.handle && answered.has(slot.handle)));
}

/**
 * What the remixer's own media in a box is called, by both creators: the words of the handle the
 * prompt mentions the box by ("@product" is "product"), or else the box's own name ("Start frame",
 * "Reference image 2"). `handle` is the box's, which the prompt's mention then finds, or null for a
 * box the prompt does not mention: its fill takes a handle as any reference added under that name.
 */
export function remixSlotFillNaming(slot: Pick<RemixInputSlot, 'handle' | 'name'>): { displayName: string; handle: string | null } {
  return { displayName: slot.handle?.slice(1).replace(/_+/g, ' ').trim() || slot.name, handle: slot.handle };
}

/** A prompt's unknown mentions as a remix's empty slots read them. */
export interface RemixSlotMentions {
  /** Of a box on the page: fill it, or take the mention out (`unfilledRemixSlotsMessage`). */
  waiting: string[];
  /** Of a box the chosen model has no place for: switch back, or take the mention out (`unplacedRemixSlotsMessage`). */
  unplaced: string[];
  /** Of nothing the remix holds, which keep the creators' unknown-mention words. */
  other: string[];
}

/**
 * A prompt's unknown mentions, sorted by the empty slots that answer them: a box on the page first,
 * then one the chosen model has no place for (`remixInputSlotsByPlace`), and every other. Each
 * creator shows the first two in these words (`remixSlotMentionsMessage`) and holds the run on them,
 * as the server refuses all three.
 */
export function readRemixSlotMentions(
  unknownHandles: readonly string[],
  slots: { placed: readonly Pick<RemixInputSlot, 'handle'>[]; unplaced?: readonly Pick<RemixInputSlot, 'handle'>[] },
): RemixSlotMentions {
  const placed = new Set(remixInputSlotHandles(slots.placed));
  const unplaced = new Set(remixInputSlotHandles(slots.unplaced ?? []));
  return {
    waiting: unknownHandles.filter((handle) => placed.has(handle)),
    unplaced: unknownHandles.filter((handle) => !placed.has(handle) && unplaced.has(handle)),
    other: unknownHandles.filter((handle) => !placed.has(handle) && !unplaced.has(handle)),
  };
}

/** What the mentions of empty slots say, those of a box on the page first; null when none is mentioned. */
export function remixSlotMentionsMessage(
  mentions: Pick<RemixSlotMentions, 'waiting' | 'unplaced'>,
  modelName: string | null | undefined,
): string | null {
  return [
    unfilledRemixSlotsMessage(mentions.waiting),
    unplacedRemixSlotsMessage(mentions.unplaced, modelName),
  ].filter(Boolean).join(' ') || null;
}

/**
 * The named references an Enhance request tells the enhancer to keep (`elementReferences`): those the
 * run sends, then every empty slot that `prompt` (the words being enhanced) mentions, under its handle
 * and the name its fill will have (`remixSlotFillNaming`), placed or not. The enhancer keeps a handle
 * only where it is told of it, and an Enhance that rewrote "@product" out of a remix's prompt left its
 * box with nothing to answer (2026-11-03). A box the words do not mention has nothing to keep, and is
 * no reference the run has. A box once filled is its reference's, which the run sends under the same
 * handle. Each handle once, the run's first.
 */
export function withRemixSlotEnhancerReferences(
  references: readonly { handle: string; displayName: string }[],
  slots: readonly Pick<RemixInputSlot, 'handle' | 'name'>[],
  prompt: string | null | undefined,
): Array<{ handle: string; displayName: string }> {
  const mentioned = promptHandles(prompt);
  const kept = new Set(references.map((reference) => reference.handle));
  const boxes = slots.flatMap((slot) => {
    if (!slot.handle || !mentioned.has(slot.handle) || kept.has(slot.handle)) return [];
    kept.add(slot.handle);
    return [{ handle: slot.handle, displayName: remixSlotFillNaming(slot).displayName }];
  });
  return [...references, ...boxes];
}
