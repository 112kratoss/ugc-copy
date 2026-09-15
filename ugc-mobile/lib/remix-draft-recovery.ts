import { extractPromptHandles, type CreationDraft } from './media-creation-view-model';

/** A completed restore with an empty image rail can be a saved, failed restore.
 * Normal reference removal also removes its prompt handle, so do not retry drafts
 * without mentions, or drafts where the creator has supplied replacement inputs.
 */
export function needsRemixReferenceRecovery(draft: CreationDraft): boolean {
  if (draft.tool === 'motion' || draft.references.length > 0) return false;
  if (draft.tool === 'video' && (draft.startFrame || draft.endFrame || draft.referenceVideos.length > 0)) return false;
  return extractPromptHandles(draft.prompt).length > 0;
}

/** Repair only missing, still-mentioned images from the authorized source.
 * Keep the saved prompt/settings and any edits made while the source was loading.
 */
export function recoverRemixReferences(current: CreationDraft, restored: CreationDraft): CreationDraft {
  if (!needsRemixReferenceRecovery(current) || current.tool === 'motion' || restored.tool === 'motion'
    || current.tool !== restored.tool || current.model !== restored.model) return current;
  const handles = new Set(extractPromptHandles(current.prompt));
  const references = restored.references.filter(reference => reference.handle && handles.has(reference.handle));
  return references.length ? { ...current, references } : current;
}
