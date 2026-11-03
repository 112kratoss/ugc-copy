import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError } from '@/lib/backend-logger';
import {
  buildLegacyGenerationInputMedia,
  loadGenerationInputMediaMap,
  toRemixerInputMedia,
  type GenerationInputMediaItem,
} from '@/lib/generation-input-media';
import { isValidElementHandle } from '@/lib/image-elements';
import {
  loadGenerationRecipeReferenceCopiesByPostId,
  type GenerationReferenceCopy,
} from '@/lib/post-resource-bundles-server';
import {
  buildRemixInputSlots,
  type RemixInputSlot,
  type RemixInputSlotRole,
  type RemixInputSlotSource,
  type RemixInputSlotTool,
} from '../../ugc-mobile/lib/remix-input-slots/remix-input-slots';

/**
 * The server half of remix input slots (owner, 2026-11-03): what a remix that
 * is given none of the run's inputs gets in their place. `remix-source-server.ts`
 * decides who that is; the slots themselves are `ugc-mobile/lib/remix-input-slots`.
 */

/** Roles a run holds one of: the slot builder keeps the first of each, as a restore does. */
const SINGLE_USE_SLOT_ROLES: ReadonlySet<RemixInputSlotRole> = new Set<RemixInputSlotRole>([
  'start_frame',
  'end_frame',
  'character_image',
  'motion_reference_video',
]);

/** What the slot builder reads of a saved input. Its file, link, name, row id and source never go in. */
function toRemixInputSlotSource(item: GenerationInputMediaItem): RemixInputSlotSource {
  return {
    mediaType: item.mediaType,
    role: item.role,
    sortOrder: item.sortOrder,
    metadata: item.metadata,
  };
}

/** The slot an input fills for a run of `tool`, as the builder itself reads it, or null for none. */
function slotRoleOf(item: GenerationInputMediaItem, tool: RemixInputSlotTool): RemixInputSlotRole | null {
  return buildRemixInputSlots([toRemixInputSlotSource(item)], { tool, prompt: null })[0]?.role ?? null;
}

function subjectHandleOf(item: GenerationInputMediaItem): string | null {
  const handle = item.metadata?.handle;
  return typeof handle === 'string' && isValidElementHandle(handle) ? handle : null;
}

function byRunOrder(left: GenerationInputMediaItem, right: GenerationInputMediaItem): number {
  return left.sortOrder - right.sortOrder;
}

/**
 * Which of a run's inputs a remix restores from the copies its unlocked recipe
 * holds (`restored`), and which it is given empty slots for (`withheld`), each
 * in the run's order. An input counts as its slot does. A named subject is one,
 * however many pictures it fused, and is restored from those of its pictures
 * the recipe has copies of: its other pictures get no slot of their own beside
 * it. A frame, a motion run's character and its clip are the first of their
 * role, so a later one of the same role neither restores nor gets a slot. A
 * subject's picture that names no subject cannot be restored as one, so it
 * gets a slot whatever the recipe holds. An input no creator restores for
 * `tool` is in neither list.
 */
export function splitRemixInputsByCopy(
  items: readonly GenerationInputMediaItem[],
  copiedRowIds: ReadonlySet<string>,
  tool: RemixInputSlotTool,
): { restored: GenerationInputMediaItem[]; withheld: GenerationInputMediaItem[] } {
  const units = new Map<string, { role: RemixInputSlotRole; restorable: boolean; members: GenerationInputMediaItem[] }>();
  for (const item of [...items].sort(byRunOrder)) {
    const role = slotRoleOf(item, tool);
    if (!role) continue;
    const handle = role === 'subject' ? subjectHandleOf(item) : null;
    const key = handle
      ? `subject:${handle}`
      : SINGLE_USE_SLOT_ROLES.has(role) ? `role:${role}` : `input:${item.id}`;
    const unit = units.get(key) ?? { role, restorable: role !== 'subject' || handle !== null, members: [] };
    unit.members.push(item);
    units.set(key, unit);
  }

  const restored: GenerationInputMediaItem[] = [];
  const withheld: GenerationInputMediaItem[] = [];
  for (const unit of units.values()) {
    const candidates = SINGLE_USE_SLOT_ROLES.has(unit.role) ? unit.members.slice(0, 1) : unit.members;
    const copied = unit.restorable ? candidates.filter((item) => copiedRowIds.has(item.id)) : [];
    if (copied.length > 0) {
      restored.push(...copied);
    } else {
      withheld.push(...unit.members);
    }
  }

  return { restored: restored.sort(byRunOrder), withheld: withheld.sort(byRunOrder) };
}

/**
 * A run's saved inputs read without signing anything: its kept rows, or for a
 * run that kept none, the inputs its settings name. Null when the rows cannot
 * be read, which is not "nothing kept": the settings would then stand in for
 * rows that exist (the loader has logged the failure).
 */
async function loadUnsignedRunInputs(params: {
  adminSupabase: SupabaseClient;
  generation: { id: string; user_id: string | null; category: string | null };
  workflowSettings: Record<string, unknown>;
}): Promise<{ items: GenerationInputMediaItem[]; kept: boolean } | null> {
  let rows: GenerationInputMediaItem[];
  try {
    const inputMap = await loadGenerationInputMediaMap({
      supabase: params.adminSupabase,
      generationIds: [params.generation.id],
      urlMode: 'none',
      throwOnError: true,
    });
    rows = inputMap.get(params.generation.id) ?? [];
  } catch {
    return null;
  }
  if (rows.length > 0) {
    return { items: rows, kept: true };
  }

  return {
    items: await buildLegacyGenerationInputMedia({
      supabase: params.adminSupabase,
      generationId: params.generation.id,
      ownerUserId: params.generation.user_id,
      category: params.generation.category,
      workflowSettings: params.workflowSettings,
      urlMode: 'none',
    }),
    kept: false,
  };
}

export interface WithheldRemixInputs {
  /**
   * The inputs restored from the copies in the recipe the remixer unlocked:
   * each row cut down as any remixer's is (`toRemixerInputMedia`), with the
   * copy's location and a short-lived link to it in place of the creator's own.
   */
  restoredFromCopies: GenerationInputMediaItem[];
  /** An empty slot for each of the rest. Never a restore failure. */
  inputSlots: RemixInputSlot[];
}

/**
 * What a remix given none of the run's inputs gets in their place (owner,
 * 2026-11-03): an empty slot for each, named as its role and, where the prompt
 * mentions it, by its handle, so the remixer adds their own and the prompt
 * works unchanged. Someone who unlocked the post's recipe has the copies the
 * creator put in it ("Include creation references"), so those inputs are
 * restored from the copies instead and only the rest are slots.
 *
 * `unlockedPostId` is the post the remix gate found this viewer unlocked the
 * recipe of (`resolveRemixAccess`, basis `unlocked`), never a post the client
 * named: no copy is read or signed for anyone else. A read that fails gives
 * what the remix had before: no slots for a failed read of the rows, and
 * slots in place of copies for a failed read of the recipe.
 */
export async function resolveWithheldRemixInputs(params: {
  adminSupabase: SupabaseClient;
  generation: { id: string; user_id: string | null; category: string | null; prompt: string | null };
  workflowSettings: Record<string, unknown>;
  tool: RemixInputSlotTool;
  unlockedPostId: string | null;
  viewerUserId: string;
}): Promise<WithheldRemixInputs> {
  const inputs = await loadUnsignedRunInputs(params);
  if (!inputs || inputs.items.length === 0) {
    return { restoredFromCopies: [], inputSlots: [] };
  }

  // Only kept rows have copies: a recipe copies what `generation_input_media` holds.
  let copies = new Map<string, GenerationReferenceCopy>();
  if (params.unlockedPostId && inputs.kept) {
    try {
      copies = await loadGenerationRecipeReferenceCopiesByPostId({
        postId: params.unlockedPostId,
        generationId: params.generation.id,
        viewerUserId: params.viewerUserId,
        inputRowIds: inputs.items.map((item) => item.id),
        adminSupabase: params.adminSupabase,
      });
    } catch (error) {
      logBackendError('failed_to_load_remix_recipe_reference_copies', { error });
    }
  }

  const { restored, withheld } = splitRemixInputsByCopy(inputs.items, new Set(copies.keys()), params.tool);
  return {
    restoredFromCopies: restored.flatMap((item) => {
      const copy = copies.get(item.id);
      return copy ? [{ ...toRemixerInputMedia(item), storagePath: copy.storagePath, url: copy.url }] : [];
    }),
    inputSlots: buildRemixInputSlots(withheld.map(toRemixInputSlotSource), {
      tool: params.tool,
      prompt: params.generation.prompt,
    }),
  };
}
