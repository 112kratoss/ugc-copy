// Mobile half of the shared resource-bundle authoring contract. The web
// composer has its own implementation of the same card model, and the two are
// deliberately duplicated because ugc-mobile is a separate npm workspace and
// cannot import from src/lib. This fixture is what keeps them byte-identical:
// the twin file is src/__tests__/post-resource-bundle-authoring-fixture.test.ts
// and both replay contracts/post-resource-bundle-authoring-v1.json.
import { describe, expect, it } from 'vitest';

import fixture from '../../contracts/post-resource-bundle-authoring-v1.json';
import {
  buildPostResourceBundleInput,
  getDefaultResourceDraft,
  hydratePostComposerAllowRemix,
  hydratePostComposerResourceCards,
  type PostComposerResourceDraft,
} from '../lib/post-new-view-model';
import type { PostResourceBundleInput } from '../lib/types';

type SerializationCase = (typeof fixture)['serializationCases'][number];
type HydrationCase = (typeof fixture)['hydrationCases'][number];
type LosslessCompatibilityCase = (typeof fixture)['losslessCompatibilityCases'][number];

function buildResourceDraft(caseResource: SerializationCase['resource']): PostComposerResourceDraft {
  return {
    ...getDefaultResourceDraft(),
    ...caseResource,
  } as PostComposerResourceDraft;
}

function compatibilityBundle(
  compatibilityCase: LosslessCompatibilityCase,
): PostResourceBundleInput {
  return {
    accessMode: 'free',
    summary: compatibilityCase.summary,
    previewText: compatibilityCase.previewText,
    priceUsdCents: 0,
    resources: {
      promptText: null,
      notesMarkdown: null,
      workflowShareUrl: null,
      attachments: [],
      allowRemix: false,
      sections: [compatibilityCase.section],
      items: compatibilityCase.items.map((item, index) => ({
        id: item.id,
        type: item.type,
        role: item.role,
        sectionId: compatibilityCase.section.id,
        title: item.title,
        description: null,
        textContent: 'textContent' in item ? item.textContent : null,
        externalUrl: 'externalUrl' in item ? item.externalUrl : null,
        storagePath: 'storagePath' in item ? item.storagePath : null,
        contentType: 'contentType' in item ? item.contentType : null,
        sizeBytes: 'sizeBytes' in item ? item.sizeBytes : null,
        workflowSnapshot: 'workflowSnapshot' in item ? item.workflowSnapshot : null,
        remixUse: item.remixUse,
        scope: item.scope,
        sortOrder: index,
        isPrimary: index === 0,
      })),
    },
  } as PostResourceBundleInput;
}

function rebuildBundle(bundle: PostResourceBundleInput) {
  return buildPostResourceBundleInput(buildResourceDraft({
    accessMode: bundle.accessMode,
    summary: bundle.summary ?? '',
    previewText: bundle.previewText ?? '',
    allowRemix: hydratePostComposerAllowRemix(bundle),
    priceTokens: String(bundle.priceUsdCents ?? 0),
    priceUsd: '0',
    cards: hydratePostComposerResourceCards(bundle),
  } as SerializationCase['resource']));
}

describe('post resource bundle authoring contract (mobile)', () => {
  it('pins the contract version so a shape change has to be deliberate', () => {
    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.serializationCases.length).toBeGreaterThan(0);
    expect(fixture.hydrationCases.length).toBeGreaterThan(0);
  });

  describe('serialization', () => {
    for (const serializationCase of fixture.serializationCases as SerializationCase[]) {
      it(`serializes ${serializationCase.name}`, () => {
        const bundle = buildPostResourceBundleInput(buildResourceDraft(serializationCase.resource));

        expect(bundle).toEqual(serializationCase.expectedBundle);
      });
    }
  });

  describe('hydration', () => {
    for (const hydrationCase of fixture.hydrationCases as HydrationCase[]) {
      it(`hydrates ${hydrationCase.name}`, () => {
        const bundle = hydrationCase.bundle as Parameters<typeof hydratePostComposerResourceCards>[0];

        expect(hydratePostComposerResourceCards(bundle)).toMatchObject(hydrationCase.expectedCards);

        if ('expectedAllowRemix' in hydrationCase) {
          expect(hydratePostComposerAllowRemix(bundle)).toBe(hydrationCase.expectedAllowRemix);
        }
      });
    }
  });

  // Every non-lossy hydration case must survive a second serialization pass, or
  // opening a bundle in the composer and pressing save would quietly rewrite it.
  describe('round trip', () => {
    for (const hydrationCase of fixture.hydrationCases as HydrationCase[]) {
      // Both clients keep remix permission alive across an edit, but they
      // encode a remix-only legacy bundle differently (mobile emits the
      // remix_access item, web leaves the server to synthesize it). Pin the
      // invariant, not the shape.
      if (hydrationCase.expectedCards.length === 0) {
        it(`keeps remix permission when re-serializing ${hydrationCase.name}`, () => {
          const bundle = hydrationCase.bundle as Parameters<typeof hydratePostComposerResourceCards>[0];
          const rebuilt = buildPostResourceBundleInput(buildResourceDraft({
            accessMode: bundle!.accessMode,
            summary: bundle!.summary ?? '',
            previewText: bundle!.previewText ?? '',
            allowRemix: hydratePostComposerAllowRemix(bundle),
            priceTokens: String(bundle!.priceUsdCents ?? 0),
            priceUsd: '0',
            cards: hydratePostComposerResourceCards(bundle),
          } as SerializationCase['resource']));

          expect(rebuilt?.resources?.allowRemix).toBe(true);
        });
        continue;
      }

      it(`re-serializes ${hydrationCase.name} without losing its original semantics`, () => {
        const bundle = hydrationCase.bundle as Parameters<typeof hydratePostComposerResourceCards>[0];
        const cards = hydratePostComposerResourceCards(bundle);
        const rebuilt = buildPostResourceBundleInput(
          buildResourceDraft({
            accessMode: bundle!.accessMode,
            summary: bundle!.summary ?? '',
            previewText: bundle!.previewText ?? '',
            allowRemix: hydratePostComposerAllowRemix(bundle),
            priceTokens: String(bundle!.priceUsdCents ?? 0),
            priceUsd: '0',
            cards,
          } as SerializationCase['resource'])
        );
        expect(rebuilt).not.toBeNull();
        expect(rebuilt?.accessMode).toBe(bundle!.accessMode);
        expect(rebuilt?.summary).toBe(bundle!.summary);
        expect(rebuilt?.previewText).toBe(bundle!.previewText);
        expect(rebuilt?.priceUsdCents).toBe(bundle!.priceUsdCents);
        expect(rebuilt?.resources?.allowRemix).toBe(bundle!.resources?.allowRemix ?? false);
        expect(rebuilt?.resources?.sections ?? []).toEqual(bundle!.resources?.sections ?? []);
        expect(rebuilt?.resources?.items ?? []).toEqual(bundle!.resources?.items ?? []);
      });
    }
  });

  describe('lossless legacy compatibility', () => {
    for (const compatibilityCase of fixture.losslessCompatibilityCases) {
      it(`preserves ${compatibilityCase.name} on the first rebuild`, () => {
        const original = compatibilityBundle(compatibilityCase);
        const cards = hydratePostComposerResourceCards(original);
        const rebuilt = rebuildBundle(original);

        expect(cards).toHaveLength(1);
        expect(cards[0]).toMatchObject(compatibilityCase.expectedCard);
        expect(rebuilt?.resources?.sections).toEqual(original.resources?.sections);
        expect(rebuilt?.resources?.items).toEqual(original.resources?.items);
      });
    }

    it('publishes a legacy-private title only after an explicit public-title edit', () => {
      const original = compatibilityBundle(fixture.losslessCompatibilityCases[0]);
      const [card] = hydratePostComposerResourceCards(original);
      const untouched = rebuildBundle(original);
      const explicitlyRetitled = buildPostResourceBundleInput(buildResourceDraft({
        accessMode: original.accessMode,
        summary: original.summary ?? '',
        previewText: original.previewText ?? '',
        allowRemix: false,
        priceTokens: '0',
        priceUsd: '0',
        cards: [{
          ...card!,
          title: 'Reusable launch prompt',
          publicTitleIntent: 'explicit',
        }],
      } as unknown as SerializationCase['resource']));

      expect(untouched?.resources?.sections?.[0]).toMatchObject({
        title: 'Secret client launch prompt',
        publicTitle: null,
      });
      expect(explicitlyRetitled?.resources?.sections?.[0]).toMatchObject({
        title: 'Secret client launch prompt',
        publicTitle: 'Reusable launch prompt',
      });
    });
  });
});
