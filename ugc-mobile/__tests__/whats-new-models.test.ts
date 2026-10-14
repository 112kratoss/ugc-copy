import { describe, expect, it } from 'vitest';

import whatsNewContract from '../../contracts/whats-new-models-v1.json';
import type { ModelCatalogKind } from '../lib/model-catalog/protocol';
import {
  hasNewBadge,
  inCatalogOrder,
  selectWhatsNewModels,
  selectWhatsNewStripModels,
  WHATS_NEW_LIMIT,
  type WhatsNewCandidate,
} from '../lib/whats-new-models';

type FixtureModel = { id: string; kind: string; badge: string | null; sortOrder: number; displayName: string };

function candidates(models: readonly FixtureModel[]): WhatsNewCandidate[] {
  return models.map((model) => ({ ...model, kind: model.kind as ModelCatalogKind }));
}

/** The order the app's catalog session keeps its pages in (`lib/model-catalog/session.ts`): sortOrder, then id. */
function inSessionOrder(models: readonly WhatsNewCandidate[]) {
  return [...models].sort((left, right) => left.sortOrder - right.sortOrder || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

const ids = (models: readonly WhatsNewCandidate[]) => models.map((model) => model.id);
const [newInTwoKinds, noneNew] = whatsNewContract.cases;

// The web's rail card and the app's Create tab strip make one selection
// (src/lib/home-dashboard.ts, lib/whats-new-models.ts). The suites share no
// module, so both answer contracts/whats-new-models-v1.json:
// src/__tests__/home-dashboard.test.ts for the web's.
describe("What's new, on the fixture the web answers too", () => {
  it.each(whatsNewContract.cases)('picks from $name as the web does', ({ models, expectedIds }) => {
    expect(ids(selectWhatsNewModels(candidates(models)))).toEqual(expectedIds);
  });

  it.each(whatsNewContract.cases)('lists $name in the strip, from the pages as the catalog session keeps them', ({ models, appStripIds }) => {
    expect(ids(selectWhatsNewStripModels(candidates(models)))).toEqual(appStripIds);
    expect(ids(selectWhatsNewStripModels(inSessionOrder(candidates(models))))).toEqual(appStripIds);
  });

  it('holds every case in the order the web hands the selection', () => {
    for (const { models } of whatsNewContract.cases) {
      expect(ids(inCatalogOrder(candidates(models)))).toEqual(ids(candidates(models)));
    }
  });

  it('would give the video the first turn in the session’s own order, which is why the strip sorts first', () => {
    // Pixel Pro and Swift Kite 2 tie on sortOrder: by id the video comes first.
    // Without this the case above could pass on a strip that never sorted.
    const sessionOrder = inSessionOrder(candidates(newInTwoKinds.models));
    expect(ids(selectWhatsNewModels(sessionOrder))).toEqual(['orbit-max', 'pixel-flash', 'orbit', 'aurora']);
    expect(ids(selectWhatsNewStripModels(sessionOrder))).toEqual(newInTwoKinds.appStripIds);
  });

  it('leaves the pages it is given in their order', () => {
    const sessionOrder = inSessionOrder(candidates(newInTwoKinds.models));
    const before = ids(sessionOrder);
    selectWhatsNewStripModels(sessionOrder);
    expect(ids(sessionOrder)).toEqual(before);
  });

  it('reads New in any case and with space around it, and no other badge', () => {
    for (const badge of ['New', 'new', 'NEW', ' new ', '\tNew\n']) expect(hasNewBadge({ badge })).toBe(true);
    for (const badge of ['Newest', 'New model', 'Pro', '', null]) expect(hasNewBadge({ badge })).toBe(false);
  });

  it('takes at most four, fewer when asked, and nothing from nothing', () => {
    expect(WHATS_NEW_LIMIT).toBe(4);
    expect(ids(selectWhatsNewStripModels(candidates(newInTwoKinds.models), 2))).toEqual(['pixel-flash', 'orbit-max']);
    expect(selectWhatsNewModels(candidates(newInTwoKinds.models), 0)).toEqual([]);
    expect(selectWhatsNewModels([])).toEqual([]);
    expect(selectWhatsNewStripModels([])).toEqual([]);
    // The web's fallback to the catalog's head stays the web rail's: the strip hides instead.
    expect(selectWhatsNewModels(candidates(noneNew.models))).toHaveLength(4);
    expect(selectWhatsNewStripModels(candidates(noneNew.models))).toEqual([]);
  });
});
