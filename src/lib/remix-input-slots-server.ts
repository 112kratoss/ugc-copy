import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError } from '@/lib/backend-logger';
import {
  buildLegacyGenerationInputMedia,
  loadGenerationInputMediaMap,
  toRemixerInputMedia,
  type GenerationInputMediaItem,
} from '@/lib/generation-input-media';
import { isRecipeFileInput } from '@/lib/generation-input-origin';
import { isValidElementHandle } from '@/lib/image-elements';
import {
  loadGenerationRecipeReferenceCopies,
  type GenerationReferenceCopy,
  type GenerationReferenceCopyRecipe,
} from '@/lib/post-resource-bundles-server';
import { SUBJECT_IMAGES_PER_NAME } from '../../ugc-mobile/lib/model-catalog/protocol';
import {
  buildRemixInputSlots,
  remixInputSlotRoleFor,
  SINGLE_USE_REMIX_SLOT_ROLES,
  type RemixInputSlot,
  type RemixInputSlotRole,
  type RemixInputSlotTool,
  type RemixSlotWords,
} from '../../ugc-mobile/lib/remix-input-slots/remix-input-slots';

/**
 * The server half of remix input slots (owner, 2026-11-03): what a remix that
 * is given none of the run's inputs gets in their place. `remix-source-server.ts`
 * decides who that is; the slots themselves are `ugc-mobile/lib/remix-input-slots`.
 */

/**
 * The restore issue of a remix whose inputs could not be read for it: the run's rows, or the
 * copies the recipe its viewer bought holds. No slot is named then, since an input with a copy
 * would read as one the creator kept to themselves, for good: the clients read any restore issue
 * as a failed restore, which reads the source again (the web on a reload, the app on Retry and
 * on its next visit), and slots come only from inputs that read says are not given.
 */
export const WITHHELD_INPUTS_RESTORE_ISSUE = 'withheld-inputs';

/**
 * The words a run's handles are read in: its prompt, and each shot of a story, which keeps only its
 * first shot as the creation's prompt while every shot reaches the remixer (`workflowSettings.multiPrompts`).
 */
export function remixSlotWords(prompt: string | null, workflowSettings: Record<string, unknown>): RemixSlotWords {
  const shots = Array.isArray(workflowSettings.multiPrompts) ? workflowSettings.multiPrompts : [];
  return [
    prompt,
    ...shots.map((shot) => (shot && typeof shot === 'object' && typeof (shot as { prompt?: unknown }).prompt === 'string'
      ? (shot as { prompt: string }).prompt
      : null)),
  ];
}

/** The slots for inputs a remix is not given: what the builder reads of each, never its file, link, name, row id or source. */
export function remixInputSlotsOf(
  items: readonly GenerationInputMediaItem[],
  options: { tool: RemixInputSlotTool; words: RemixSlotWords },
): RemixInputSlot[] {
  return buildRemixInputSlots(items.map((item) => ({
    mediaType: item.mediaType,
    role: item.role,
    sortOrder: item.sortOrder,
    metadata: item.metadata,
  })), { tool: options.tool, prompt: options.words });
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
 * the recipe has copies of when they still make a subject: fewer than a subject
 * takes (`SUBJECT_IMAGES_PER_NAME.min`) and it is not restored part-way, but
 * gets its slot, as a subject with no copies does. A frame, a motion run's
 * character and its clip are the first of their role, so a later one of the
 * same role neither restores nor gets a slot. A subject's picture that names
 * no subject cannot be restored as one, so it gets a slot whatever the recipe
 * holds. An input no creator restores for `tool` is in neither list.
 */
export function splitRemixInputsByCopy(
  items: readonly GenerationInputMediaItem[],
  copiedRowIds: ReadonlySet<string>,
  tool: RemixInputSlotTool,
): { restored: GenerationInputMediaItem[]; withheld: GenerationInputMediaItem[] } {
  const units = new Map<string, { role: RemixInputSlotRole; restorable: boolean; members: GenerationInputMediaItem[] }>();
  for (const item of [...items].sort(byRunOrder)) {
    const role = remixInputSlotRoleFor(item, tool);
    if (!role) continue;
    const handle = role === 'subject' ? subjectHandleOf(item) : null;
    const key = handle
      ? `subject:${handle}`
      : SINGLE_USE_REMIX_SLOT_ROLES.has(role) ? `role:${role}` : `input:${item.id}`;
    const unit = units.get(key) ?? { role, restorable: role !== 'subject' || handle !== null, members: [] };
    unit.members.push(item);
    units.set(key, unit);
  }

  const restored: GenerationInputMediaItem[] = [];
  const withheld: GenerationInputMediaItem[] = [];
  for (const unit of units.values()) {
    const candidates = SINGLE_USE_REMIX_SLOT_ROLES.has(unit.role) ? unit.members.slice(0, 1) : unit.members;
    const copied = unit.restorable ? candidates.filter((item) => copiedRowIds.has(item.id)) : [];
    const restores = unit.role === 'subject' ? copied.length >= SUBJECT_IMAGES_PER_NAME.min : copied.length > 0;
    if (restores) {
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
   * The inputs restored from the copies in the recipe the remixer bought:
   * each row cut down as any remixer's is (`toRemixerInputMedia`), with the
   * copy's location and a short-lived link to it in place of the creator's own.
   */
  restoredFromCopies: GenerationInputMediaItem[];
  /** An empty slot for each of the rest. Never a restore failure. */
  inputSlots: RemixInputSlot[];
  /** `WITHHELD_INPUTS_RESTORE_ISSUE` where a read failed, and then no slots; null otherwise. */
  restoreIssue: string | null;
}

const UNREAD: WithheldRemixInputs = { restoredFromCopies: [], inputSlots: [], restoreIssue: WITHHELD_INPUTS_RESTORE_ISSUE };

/**
 * What a remix given none of the run's inputs gets in their place (owner,
 * 2026-11-03): an empty slot for each, named as its role and, where the run's
 * words mention it (its prompt or a story's shots, `remixSlotWords`), by its
 * handle, so the remixer adds their own and the prompt works unchanged. Someone
 * who bought the post's recipe has the copies the creator put in it ("Include
 * creation references"), so those inputs are restored from the copies instead
 * and only the rest are slots.
 *
 * `recipe` is the recipe on the post as the remix gate read it
 * (`resolveRemixAccess`), never a post the client named: its copies go to
 * whoever bought it, a retired recipe's buyers too, and are read and signed for
 * no one else (`loadGenerationRecipeReferenceCopies`). A read that fails, of the
 * rows or of the recipe, names no slot and raises `WITHHELD_INPUTS_RESTORE_ISSUE`:
 * an input with a copy is never turned into a slot by a failure. A file of
 * someone else's recipe the creator's run used is no copy of theirs to restore:
 * it gets its slot.
 */
export async function resolveWithheldRemixInputs(params: {
  adminSupabase: SupabaseClient;
  generation: { id: string; user_id: string | null; category: string | null; prompt: string | null };
  workflowSettings: Record<string, unknown>;
  tool: RemixInputSlotTool;
  recipe: GenerationReferenceCopyRecipe | null;
  viewerUserId: string;
}): Promise<WithheldRemixInputs> {
  const inputs = await loadUnsignedRunInputs(params);
  if (!inputs) {
    return UNREAD;
  }
  if (inputs.items.length === 0) {
    return { restoredFromCopies: [], inputSlots: [], restoreIssue: null };
  }

  // Only kept rows have copies: a recipe copies what `generation_input_media` holds.
  let copies = new Map<string, GenerationReferenceCopy>();
  if (params.recipe && inputs.kept) {
    try {
      copies = await loadGenerationRecipeReferenceCopies({
        adminSupabase: params.adminSupabase,
        recipe: params.recipe,
        generationId: params.generation.id,
        viewerUserId: params.viewerUserId,
        inputRowIds: inputs.items.map((item) => item.id),
      });
    } catch (error) {
      logBackendError('failed_to_load_remix_recipe_reference_copies', { error });
      return UNREAD;
    }
  }
  const creatorIds = new Set(params.generation.user_id ? [params.generation.user_id] : []);
  const copiedRowIds = new Set(inputs.items
    .filter((item) => copies.has(item.id) && !isRecipeFileInput(item, creatorIds))
    .map((item) => item.id));

  const { restored, withheld } = splitRemixInputsByCopy(inputs.items, copiedRowIds, params.tool);
  return {
    restoredFromCopies: restored.flatMap((item) => {
      const copy = copies.get(item.id);
      return copy ? [{ ...toRemixerInputMedia(item), storagePath: copy.storagePath, url: copy.url }] : [];
    }),
    inputSlots: remixInputSlotsOf(withheld, {
      tool: params.tool,
      words: remixSlotWords(params.generation.prompt, params.workflowSettings),
    }),
    restoreIssue: null,
  };
}
