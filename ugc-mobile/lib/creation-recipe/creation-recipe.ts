/**
 * A creation's recipe, as the server and both composers read it (owner,
 * 2026-11-03). Every creation's recipe holds the creation's exact prompt, as a
 * locked item, unless the creator keeps a prompt item of their own; and the
 * creation's saved inputs join it only when the creator asks, copied into the
 * creator's references folder for that creation. The server adds the prompt
 * item a recipe lacks and makes the copies (`post-resource-bundles-server.ts`);
 * the web and app composers draw the locked row and "From this creation" by the
 * same rules and in the same words.
 *
 * Shared with the web by relative import, like the post publish policy: keep it
 * free of React Native, Expo and Node imports. The folder keeps its own
 * self-contained tsconfig.json.
 */

// ─── The exact prompt ────────────────────────────────────────────────────────

/** The title of the item a creation's exact prompt makes (recipe audit A-F16). */
export const CREATION_PROMPT_ITEM_TITLE = 'Exact generation prompt';

/**
 * The id both composers give the exact prompt's card, as the app's Made with
 * row is `mw-generation`: a draft kept on the device and the same creation
 * opened afresh then read the same. A random id read as unsaved work on every
 * reopen of an untouched composer.
 */
export const CREATION_PROMPT_CARD_ID = 'creation-prompt';

/** The id the server gives the exact prompt's item where it adds one itself. */
export const CREATION_PROMPT_ITEM_ID = 'creation-prompt-item';

/** What these rules read of a recipe item or a composer's card; both carry more. */
export interface CreationRecipeItemLike {
  type: string;
  title?: string | null;
  textContent?: string | null;
}

function trimmed(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Whether an item holds the creation's exact prompt: a prompt item whose text is that prompt. */
export function holdsCreationPrompt(item: CreationRecipeItemLike, prompt: string | null | undefined): boolean {
  const exact = trimmed(prompt);
  return Boolean(exact) && item.type === 'prompt' && trimmed(item.textContent) === exact;
}

/**
 * The exact prompt's own item, which a creation's recipe keeps locked: drawn
 * with neither Edit nor Remove. Its title and its text both say so. A prompt
 * item the creator rewrote keeps the title but not the text, and one of their
 * own holding the same words has a title of its own: both stay theirs to edit.
 */
export function isLockedCreationPromptItem(item: CreationRecipeItemLike, prompt: string | null | undefined): boolean {
  return holdsCreationPrompt(item, prompt) && trimmed(item.title) === CREATION_PROMPT_ITEM_TITLE;
}

/**
 * Whether a creation's recipe needs the exact prompt added: the creation has a
 * prompt and the recipe has no prompt item of its own. A recipe that keeps one,
 * however worded, keeps it alone; one whose own was removed gets the exact
 * prompt back.
 */
export function needsCreationPromptItem(
  items: readonly CreationRecipeItemLike[],
  prompt: string | null | undefined,
): boolean {
  return Boolean(trimmed(prompt)) && !items.some((item) => item.type === 'prompt' && Boolean(trimmed(item.textContent)));
}

// ─── A creation that gives its recipe nothing ───────────────────────────────

/** What the rule below reads of a creation: whether it was removed or archived. */
export interface CreationStateLike {
  archived_at?: string | null;
  moderation_removed_at?: string | null;
}

/**
 * Whether anything of a creation, its exact prompt or its saved inputs, may go
 * into its post's recipe: not once an operator has removed it or its creator
 * has archived it (`moderation_removed_at`, `archived_at`), as Remix withholds
 * such a creation's prompt too. The server holds every save to it, taking out
 * a locked card a composer sent, and both composers neither add nor keep that
 * card for such a creation (#677's re-reviews). The gate is those two marks
 * and not `is_public`, which other states write as well: a creation behind an
 * NSFW cover is not public either, and not holding its recipe back for that is
 * intended. A creation only not published yet has neither mark.
 */
export function creationMayShareRecipe(creation: CreationStateLike | null | undefined): boolean {
  return Boolean(creation) && !creation?.moderation_removed_at && !creation?.archived_at;
}

/** Items or cards without the exact prompt's locked one, for a creation that gives its recipe nothing. */
export function withoutLockedCreationPrompt<T extends CreationRecipeItemLike>(
  items: readonly T[],
  prompt: string | null | undefined,
): T[] {
  return items.filter((item) => !isLockedCreationPromptItem(item, prompt));
}

/** "From this creation" while the recipe holds the exact prompt. */
export const CREATION_PROMPT_INCLUDED = 'Exact prompt included.';
export const CREATION_PROMPT_INCLUDED_DETAIL = "Every creation's recipe has it: the Remix that comes with one fills it in for whoever unlocks it.";

// ─── The creation's saved inputs ─────────────────────────────────────────────

const REFERENCES_FOLDER = 'generation-references';

/** The creator's folder for the copies of one creation's saved inputs: `<owner>/generation-references/<creation>/`. */
export function creationReferencesFolder(ownerUserId: string, generationId: string): string {
  return `${ownerUserId}/${REFERENCES_FOLDER}/${generationId}/`;
}

/** A segment of a copy's path or id: lower case letters, digits, dots and single dashes. */
export function creationReferencePathSegment(value: string | null | undefined, fallback: string): string {
  const sanitized = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/_/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return sanitized || fallback;
}

/**
 * Where the copy of one saved input is kept. The path is fixed by the input,
 * so a copy made again lands where the first one did, with the same bytes.
 */
export function creationReferenceCopyPath(input: {
  ownerUserId: string;
  generationId: string;
  inputId: string;
  role: string | null | undefined;
  sortOrder: number | null | undefined;
  extension: string;
}): string {
  const order = Math.max(0, input.sortOrder ?? 0).toString().padStart(2, '0');
  const role = creationReferencePathSegment(input.role, 'reference');
  const id = creationReferencePathSegment(input.inputId, 'input');
  return `${creationReferencesFolder(input.ownerUserId, input.generationId)}${order}-${role}-${id}.${input.extension}`;
}

/**
 * The id a recipe keeps one saved input's copy under, which is also how a read
 * knows that input is in the recipe already (S-F8).
 */
export function creationReferenceItemId(inputId: string, index: number): string {
  return `reference-${creationReferencePathSegment(inputId, String(index + 1))}`;
}

/** Whether a stored file is one of the copies of this creation's saved inputs. */
export function isCreationReferenceCopyPath(
  storagePath: string | null | undefined,
  generationId: string | null | undefined,
): boolean {
  return Boolean(generationId)
    && typeof storagePath === 'string'
    && storagePath.includes(`/${REFERENCES_FOLDER}/${generationId}/`);
}

/** Whether a stored file is the copy of this one saved input. */
export function isCreationReferenceCopyOf(
  storagePath: string | null | undefined,
  generationId: string | null | undefined,
  inputId: string | null | undefined,
): boolean {
  if (!inputId || typeof storagePath !== 'string' || !isCreationReferenceCopyPath(storagePath, generationId)) {
    return false;
  }
  const fileName = storagePath.slice(storagePath.lastIndexOf('/') + 1);
  return fileName.includes(`-${creationReferencePathSegment(inputId, 'input')}.`);
}

/** A saved input of a creation, as `/api/generations` sends it (`input_media`). */
export interface CreationInputLike {
  id?: string | null;
  url?: string | null;
  storagePath?: string | null;
  kind?: string | null;
  mediaType?: string | null;
  role?: string | null;
  sortOrder?: number | null;
  metadata?: Record<string, unknown> | null;
  label?: string | null;
  /**
   * The server copies it into the creation's recipe when the creator asks: a
   * saved input row of the creator's, or of a guest linked to them, whose file
   * sits in that identity's own folder. Absent from servers before 2026-11-03.
   */
  recipeCopyable?: boolean | null;
}

/** A saved input as both clients draw it. */
export interface GenerationReference {
  id: string;
  url: string | null;
  storagePath: string | null;
  mediaKind: 'image' | 'video' | 'audio';
  label: string;
  caption: string;
}

const ROLE_LABELS: Record<string, string> = {
  reference_image: 'Reference image', start_frame: 'Start frame', end_frame: 'End frame',
  reference_video: 'Reference video', reference_audio: 'Reference audio',
  character_image: 'Character image', motion_reference_video: 'Motion reference video',
  subject_image: 'Subject image',
};

/** A creation's saved inputs in their order, each with its kind and the name it is shown under. */
export function generationReferences(media: readonly CreationInputLike[] | null | undefined = []): GenerationReference[] {
  return [...(media ?? [])].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)).map((item, index) => {
    const kind = item.mediaType ?? item.kind;
    const mediaKind: 'image' | 'video' | 'audio' = kind === 'video' || kind === 'audio' ? kind : 'image';
    const roleLabel = ROLE_LABELS[item.role ?? ''] ?? `Reference ${mediaKind}`;
    const handle = typeof item.metadata?.handle === 'string' ? item.metadata.handle.trim() : '';
    const label = handle || item.label?.trim() || roleLabel;
    return {
      id: item.id ?? item.storagePath ?? `reference-${index}`,
      url: item.url ?? null,
      storagePath: item.storagePath ?? null,
      mediaKind,
      label,
      caption: roleLabel,
    };
  });
}

/**
 * The saved inputs "From this creation" shows, counts and offers: those the
 * server copies into the recipe when asked. A remix's references kept in its
 * original's folder, and the inputs an older run's settings name, are not
 * copied, so they are not promised either.
 */
export function recipeCopyableInputs(media: readonly CreationInputLike[] | null | undefined): GenerationReference[] {
  return generationReferences((media ?? []).filter((item) => item.recipeCopyable === true));
}

/** How many of those inputs the recipe already holds a copy of, read from the files its items keep. */
export function countCreationInputsInRecipe(
  inputs: readonly Pick<GenerationReference, 'id'>[],
  storagePaths: readonly (string | null | undefined)[],
  generationId: string | null | undefined,
): number {
  return inputs.filter((input) => storagePaths.some((path) => isCreationReferenceCopyOf(path, generationId, input.id))).length;
}

/** "From this creation" once every saved input it offers is in the recipe. */
export const CREATION_INPUTS_INCLUDED = 'Saved inputs included in this recipe.';
export const CREATION_INPUTS_INCLUDED_DETAIL = 'They are listed with the items below.';

/** The switch's line: what ticking it does, given how many of the inputs the recipe holds already. */
export function describeCreationInputsSwitch(included: number, offered: number): string {
  if (included <= 0) {
    return 'Attach the saved inputs above as reusable references. Off unless you choose it: inputs can be personal.';
  }
  return `${included} of ${offered} are in this recipe already. Attach the rest as reusable references.`;
}

/** Said after a save the server could not copy every asked-for input into. */
export function describeUncopiedCreationInputs(count: number): string {
  return count === 1
    ? '1 saved input could not be copied into the recipe. Include it again and save to try once more.'
    : `${count} saved inputs could not be copied into the recipe. Include them again and save to try once more.`;
}
