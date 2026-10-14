import type { ModelCatalogSummary } from './model-catalog/protocol';

/** What the selection reads of a catalog model: fields every summary page carries. */
export type WhatsNewCandidate = Pick<ModelCatalogSummary, 'id' | 'kind' | 'badge' | 'sortOrder' | 'displayName'>;

export const WHATS_NEW_LIMIT = 4;

/** The badge is free text in the catalog, so `New` counts in any case and with any space around it. */
export function hasNewBadge(model: Pick<WhatsNewCandidate, 'badge'>): boolean {
  return model.badge?.trim().toLowerCase() === 'new';
}

/**
 * The web's "What's new" selection (`selectWhatsNewModels` in `src/lib/home-dashboard.ts`), ported whole so
 * that one fixture, `contracts/whats-new-models-v1.json`, holds both clients to the same answer. Models
 * badged `New`, newest first within each kind: a kind's newest launch has its highest sortOrder, but sortOrder
 * restarts at 0 in every kind, so it ranks only within one. The kinds then take turns, in the order their first
 * New model appears. With no New badge it falls back to the head of the list, as the web's rail card does.
 */
export function selectWhatsNewModels<T extends WhatsNewCandidate>(models: readonly T[], limit = WHATS_NEW_LIMIT): T[] {
  if (limit <= 0) return [];

  const newestByKind = new Map<T['kind'], T[]>();
  for (const model of models) {
    if (!hasNewBadge(model)) continue;
    const list = newestByKind.get(model.kind) ?? [];
    list.push(model);
    newestByKind.set(model.kind, list);
  }
  const flaggedNew: T[] = [];
  const queues = [...newestByKind.values()].map((list) => list.sort((left, right) => right.sortOrder - left.sortOrder));
  while (queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      const next = queue.shift();
      if (next) flaggedNew.push(next);
    }
  }
  const selected = flaggedNew.length > 0 ? flaggedNew : models;

  return selected.slice(0, limit);
}

/**
 * The order the web hands the selection: the published catalog's, by sortOrder and then display name
 * (`src/lib/generation-model-catalog-store.ts`). The app's catalog session keeps its pages by sortOrder and then
 * id, and where two kinds' New models tie on sortOrder that decides which kind takes the first turn.
 */
export function inCatalogOrder<T extends WhatsNewCandidate>(models: readonly T[]): T[] {
  return [...models].sort((left, right) => left.sortOrder - right.sortOrder || left.displayName.localeCompare(right.displayName));
}

/**
 * What the Create tab's strip lists (D9): the web's selection over the catalog pages the screen has read, or
 * nothing when none of them carries a New badge. The strip hides where the web's rail shows the catalog's head.
 */
export function selectWhatsNewStripModels<T extends WhatsNewCandidate>(models: readonly T[], limit = WHATS_NEW_LIMIT): T[] {
  return models.some(hasNewBadge) ? selectWhatsNewModels(inCatalogOrder(models), limit) : [];
}
