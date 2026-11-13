import { IMAGE_MODELS, MOTION_MODELS, VIDEO_MODELS } from '@/lib/models';
import { getPostModelDisplayName } from '@/lib/post-feed-presentation';

/**
 * The name search gives a model or a tool, for every place that names one:
 * an entity result of full search and a row of the typeahead.
 *
 * A tool is named as its posts print it. A model made here is named by the
 * catalog, whatever name the database first saw it under, because a creation
 * stored without a Made with row is known there by its model column alone, and
 * that column does not always hold the catalog's id: a motion creation is
 * stored under the provider's id (`kling-2.6/motion-control`), which the
 * database keys as `kling-2.6-motion-control` and labels with the raw id. No
 * catalog entry has that key, and the post itself prints no model for it
 * (`getPostModelDisplayName` knows catalog ids only), so the entity read
 * "kling-2.6/motion-control" in the box. It is looked up here by the catalog's
 * id and by the provider's id, each as the database keys a name.
 *
 * A model nothing here knows keeps the name its posts print, unless that name
 * is a path-like id (a slash and no space), which is spelled as words.
 */

/** `public.search_entity_key` for the names the catalog holds: lower case, every run of characters other than letters, digits and dots a hyphen, at most 80 characters. */
function entityKey(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

type CatalogModel = { id: string; displayName: string; apiModelId?: string };

let namesByKey: Map<string, string> | null = null;

function catalogNamesByKey(): Map<string, string> {
  if (namesByKey) return namesByKey;
  const models = [IMAGE_MODELS, VIDEO_MODELS, MOTION_MODELS]
    .flatMap((catalog) => Object.values(catalog as Record<string, CatalogModel>));
  const names = new Map<string, string>();
  // A catalog id outranks a provider's id that happens to key the same.
  for (const model of models) names.set(entityKey(model.id), model.displayName);
  for (const model of models) {
    const key = model.apiModelId ? entityKey(model.apiModelId) : '';
    if (key && !names.has(key)) names.set(key, model.displayName);
  }
  namesByKey = names;
  return names;
}

function isPathLikeId(label: string): boolean {
  return label.includes('/') && !/\s/.test(label);
}

/** `kling-2.6/motion-control` as "Kling 2.6 Motion Control". */
function spelledAsWords(id: string): string {
  const words = id.split(/[/_-]+/).filter(Boolean);
  return words.length === 0 ? id : words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

export function searchEntityLabel(row: { kind: 'model' | 'tool'; key: string; label: string }): string {
  if (row.kind !== 'model') return row.label;
  return getPostModelDisplayName(row.key)
    ?? catalogNamesByKey().get(row.key)
    ?? catalogNamesByKey().get(entityKey(row.label))
    ?? (isPathLikeId(row.label) ? spelledAsWords(row.label) : row.label);
}
