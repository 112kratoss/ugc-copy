import { getCanonicalStoredMediaLocation } from '@/lib/storage-ownership';
// The copies' folder is the shared rule's, whose `creationReferenceCopyPath` files them.
import { CREATION_REFERENCES_FOLDER, creationReferencesFolder } from '../../ugc-mobile/lib/creation-recipe/creation-recipe';

/**
 * Where a recipe's copies of its creation's inputs live, and where a run start keeps its import of
 * one (owner, 2026-11-03): the server's readers of both layouts and the writer of the imports. The
 * copies are filed by `creationReferenceCopyPath` (`ugc-mobile/lib/creation-recipe/`, one rule
 * with both composers), in the folder read here.
 *
 * - A copy, which "Include creation references" files in the publisher's recipe files:
 *   `post_resource_files/<publisher>/generation-references/<generation>/<file>`.
 * - A run start's import of a copy, for a remix of a recipe its caller bought:
 *   `generation_inputs/<caller>/recipe-imports/<publisher>/<generation>/<file>`, which names the copy
 *   it was made from, so a later use of it is checked against the unlock again.
 */

/** The bucket a recipe's files are kept in: its seller's uploads and the copies of its creation's inputs. */
export const RECIPE_FILES_BUCKET = 'post_resource_files';
const GENERATION_INPUTS_BUCKET = 'generation_inputs';
/** The folder of a publisher's recipe files "Include creation references" keeps its copies in. */
export const GENERATION_REFERENCE_COPY_FOLDER = CREATION_REFERENCES_FOLDER;
/** The folder of a caller's generation inputs a run start keeps its imports of recipe copies in. */
export const RECIPE_IMPORT_FOLDER = 'recipe-imports';

/** A copy, by its publisher, its creation and its file's name. */
export interface GenerationReferenceCopyParts {
  ownerUserId: string;
  generationId: string;
  fileName: string;
}

/** A creation's copies' folder in its publisher's recipe files, with its trailing slash. */
export function generationReferenceCopyFolder(ownerUserId: string, generationId: string): string {
  return creationReferencesFolder(ownerUserId, generationId);
}

/**
 * A copy's object path in the recipe files read back: its publisher, its creation and its file name,
 * or null for anything else, a file deeper in the folder included. Nothing is decoded: a caller reads
 * the path as storage would (`getCanonicalStoredMediaLocation`) before asking.
 */
export function parseGenerationReferenceCopyPath(filePath: string): GenerationReferenceCopyParts | null {
  const [ownerUserId, folder, generationId, fileName, ...deeper] = filePath.split('/');
  if (folder !== GENERATION_REFERENCE_COPY_FOLDER || !ownerUserId || !generationId || !fileName || deeper.length > 0) {
    return null;
  }
  return { ownerUserId, generationId, fileName };
}

/** Where a run start keeps its caller's import of a copy, in the generation inputs. */
export function recipeImportPath(viewerUserId: string, copy: GenerationReferenceCopyParts): string {
  return `${viewerUserId}/${RECIPE_IMPORT_FOLDER}/${copy.ownerUserId}/${copy.generationId}/${copy.fileName}`;
}

/** An import's object path in the generation inputs read back: whose it is and the copy it was made from, or null. */
export function parseRecipeImportPath(filePath: string): (GenerationReferenceCopyParts & { viewerUserId: string }) | null {
  const [viewerUserId, folder, ownerUserId, generationId, fileName, ...deeper] = filePath.split('/');
  if (folder !== RECIPE_IMPORT_FOLDER || !viewerUserId || !ownerUserId || !generationId || !fileName || deeper.length > 0) {
    return null;
  }
  return { viewerUserId, ownerUserId, generationId, fileName };
}

/**
 * The copy a source names, as `post_resource_files/<publisher>/generation-references/<generation>/<file>`:
 * the copy itself, where its publisher is none of `ownerIds` (a publisher's own copy is their own file),
 * or a run start's import of one, in anyone's folder. Null for anything else.
 */
export function recipeCopyOfSource(source: unknown, ownerIds: ReadonlySet<string>): string | null {
  if (typeof source !== 'string' || !source.trim()) return null;
  const location = getCanonicalStoredMediaLocation(source);
  if (!location) return null;
  if (location.bucket === RECIPE_FILES_BUCKET) {
    const copy = parseGenerationReferenceCopyPath(location.filePath);
    return copy && !ownerIds.has(copy.ownerUserId) ? `${RECIPE_FILES_BUCKET}/${location.filePath}` : null;
  }
  if (location.bucket !== GENERATION_INPUTS_BUCKET) return null;
  const imported = parseRecipeImportPath(location.filePath);
  return imported
    ? `${RECIPE_FILES_BUCKET}/${generationReferenceCopyFolder(imported.ownerUserId, imported.generationId)}${imported.fileName}`
    : null;
}

/** Whether a source is in a run start's folder of recipe imports, whoever's folder it is. */
export function isRecipeImportSource(source: unknown): boolean {
  if (typeof source !== 'string' || !source.trim()) return false;
  const location = getCanonicalStoredMediaLocation(source);
  return location?.bucket === GENERATION_INPUTS_BUCKET && location.filePath.split('/')[1] === RECIPE_IMPORT_FOLDER;
}
