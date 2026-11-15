/**
 * A creator opened on a model: `/create/video?model=seedance-2`, as search's
 * row for a catalog model nobody has posted with yet opens it (2026-11-15;
 * the web's creators read the same `?model=`). The creator chooses the model
 * once, as its picker would, after its saved drafts are read and its catalog's
 * revision is confirmed, so neither puts another model over it afterwards.
 */

import { MODEL_CATALOG_ID_PATTERN } from './model-catalog/protocol';

/**
 * The model a creator link names, or null: none named, or text no catalog id
 * could be. A remix restores its source's model and a guided first creation
 * names its starter's, so neither takes one from the link.
 */
export function creatorLinkModel({ model, remix = false, guided = false }: {
  model: string | string[] | undefined;
  remix?: boolean;
  guided?: boolean;
}): string | null {
  if (remix || guided) return null;
  const value = (Array.isArray(model) ? model[0] : model)?.trim() ?? '';
  // A catalog id as every route and client reads one (`seedance-2`, `kling-2.6`):
  // anything else no catalog names, and is not looked up.
  return MODEL_CATALOG_ID_PATTERN.test(value) ? value : null;
}

/**
 * What the creator does with the link's model now:
 *
 *   - `wait` until the saved drafts are read and the catalog's revision is
 *     confirmed (`ready`: a stored catalog's word on the model is not the
 *     last), and the model's details are in (`loaded`);
 *   - `pick` it, as the picker would, when this creator may run it (`usable`:
 *     the creator's kind, offered in the app);
 *   - `drop` it otherwise, or when the confirmed catalog has no such model
 *     (`missing`): the draft keeps the model it has.
 */
export function creatorLinkModelStep({ ready, loaded, missing, usable }: {
  ready: boolean;
  loaded: boolean;
  missing: boolean;
  usable: boolean;
}): 'wait' | 'pick' | 'drop' {
  if (!ready) return 'wait';
  if (missing) return 'drop';
  if (!loaded) return 'wait';
  return usable ? 'pick' : 'drop';
}
