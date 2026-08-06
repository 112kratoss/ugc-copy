// Web half of the shared resource-bundle authoring contract. The mobile
// composer has its own implementation of the same card model, and the two are
// deliberately duplicated because ugc-mobile is a separate npm workspace and
// cannot import from src/lib. This fixture is what keeps them byte-identical:
// the twin file is
// ugc-mobile/__tests__/post-resource-bundle-authoring-fixture.test.ts and both
// replay contracts/post-resource-bundle-authoring-v1.json.
import { describe, expect, it } from 'vitest';

import fixture from '../../contracts/post-resource-bundle-authoring-v1.json';
import {
  buildResourceCardBundleInput,
  hydratePostComposerAllowRemix,
  hydratePostComposerResourceCards,
  type PostComposerResourceCardDraft,
} from '@/lib/post-composer-resource-cards';
import {
  buildPostResourceBundleLockedPreview,
  normalizePostResourceItems,
  normalizePostResourceSections,
  validatePostResourceBundleInput,
  type PostResourceBundleAccessMode,
  type PostResourceBundleInput,
} from '@/lib/post-resource-bundles';

type SerializationCase = (typeof fixture)['serializationCases'][number];
type HydrationCase = (typeof fixture)['hydrationCases'][number];
type LosslessCompatibilityCase = (typeof fixture)['losslessCompatibilityCases'][number];

const serializationCases = fixture.serializationCases as unknown as Array<
  SerializationCase & { expectedBundle: PostResourceBundleInput }
>;
const hydrationCases = fixture.hydrationCases as unknown as Array<
  HydrationCase & { bundle: PostResourceBundleInput; expectedCards: PostComposerResourceCardDraft[] }
>;

function serializeCase(serializationCase: (typeof serializationCases)[number]) {
  const resource = serializationCase.resource;
  return buildResourceCardBundleInput({
    accessMode: resource.accessMode as PostResourceBundleAccessMode,
    cards: resource.cards as unknown as PostComposerResourceCardDraft[],
    allowRemix: resource.allowRemix,
    summary: resource.summary,
    previewText: resource.previewText,
    priceTokens: Number.parseInt(resource.priceTokens, 10),
  });
}

function compatibilityBundle(
  compatibilityCase: LosslessCompatibilityCase
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

function rebuildBundle(bundle: PostResourceBundleInput, cards: PostComposerResourceCardDraft[]) {
  return buildResourceCardBundleInput({
    accessMode: bundle.accessMode,
    cards,
    allowRemix: hydratePostComposerAllowRemix(bundle),
    summary: bundle.summary ?? '',
    previewText: bundle.previewText ?? '',
    priceTokens: bundle.priceUsdCents ?? 0,
  });
}

describe('post resource bundle authoring contract (web)', () => {
  it('pins the contract version so a shape change has to be deliberate', () => {
    expect(fixture.schemaVersion).toBe(1);
    expect(serializationCases.length).toBeGreaterThan(0);
    expect(hydrationCases.length).toBeGreaterThan(0);
  });

  for (const serializationCase of serializationCases) {
    describe(serializationCase.name, () => {
      const bundle = serializationCase.expectedBundle;

      // The contract: identical card drafts produce an identical payload on
      // both clients. The mobile twin asserts the same expectation.
      it('serializes to the contracted payload', () => {
        expect(serializeCase(serializationCase)).toEqual(bundle);
      });

      it('is accepted by server validation', () => {
        expect(
          validatePostResourceBundleInput(bundle, serializationCase.validationOptions)
        ).toBeNull();
      });

      // The composer sends exactly what it built. If normalization rewrote any
      // of it, the bundle a creator sees on reload would differ from the one
      // they authored.
      it('normalizes to itself', () => {
        expect(normalizePostResourceSections(bundle.resources?.sections)).toEqual(
          bundle.resources?.sections
        );
        expect(normalizePostResourceItems(bundle.resources?.items, bundle.resources)).toEqual(
          bundle.resources?.items
        );
      });

      it('publishes the expected pre-unlock buyer cards', () => {
        const preview = buildPostResourceBundleLockedPreview(bundle.resources);

        expect(preview.cardPreviews).toEqual(
          serializationCase.expectedCardPreviews.map((card) => expect.objectContaining(card))
        );
      });
    });
  }

  describe('hydration', () => {
    for (const hydrationCase of hydrationCases) {
      it(`hydrates ${hydrationCase.name}`, () => {
        expect(hydratePostComposerResourceCards(hydrationCase.bundle)).toMatchObject(
          hydrationCase.expectedCards
        );

        if ('expectedAllowRemix' in hydrationCase) {
          expect(hydratePostComposerAllowRemix(hydrationCase.bundle)).toBe(
            hydrationCase.expectedAllowRemix
          );
        }
      });
    }
  });

  // Opening a bundle in the composer and pressing save must not rewrite it.
  describe('round trip', () => {
    for (const hydrationCase of hydrationCases) {
      // Both clients keep remix permission alive across an edit, but they
      // encode a remix-only legacy bundle differently (web leaves the server to
      // synthesize the item, mobile emits it). Pin the invariant, not the shape.
      if (hydrationCase.expectedCards.length === 0) {
        it(`keeps remix permission when re-serializing ${hydrationCase.name}`, () => {
          const rebuilt = buildResourceCardBundleInput({
            accessMode: hydrationCase.bundle.accessMode,
            cards: hydratePostComposerResourceCards(hydrationCase.bundle),
            allowRemix: hydratePostComposerAllowRemix(hydrationCase.bundle),
            summary: hydrationCase.bundle.summary ?? '',
            previewText: hydrationCase.bundle.previewText ?? '',
            priceTokens: hydrationCase.bundle.priceUsdCents ?? 0,
          });

          expect(rebuilt?.resources?.allowRemix).toBe(true);
        });
        continue;
      }

      it(`re-serializes ${hydrationCase.name} without losing its original semantics`, () => {
        const { bundle } = hydrationCase;
        const rebuild = (cards: PostComposerResourceCardDraft[]) => buildResourceCardBundleInput({
          accessMode: bundle.accessMode,
          cards,
          allowRemix: hydratePostComposerAllowRemix(bundle),
          summary: bundle.summary ?? '',
          previewText: bundle.previewText ?? '',
          priceTokens: bundle.priceUsdCents ?? 0,
        });

        const rebuilt = rebuild(hydratePostComposerResourceCards(bundle));
        expect(rebuilt).not.toBeNull();
        expect(rebuilt?.accessMode).toBe(bundle.accessMode);
        expect(rebuilt?.summary).toBe(bundle.summary);
        expect(rebuilt?.previewText).toBe(bundle.previewText);
        expect(rebuilt?.priceUsdCents).toBe(bundle.priceUsdCents);
        expect(rebuilt?.resources?.allowRemix).toBe(bundle.resources?.allowRemix ?? false);
        expect(rebuilt?.resources?.sections ?? []).toEqual(
          normalizePostResourceSections(bundle.resources?.sections)
        );
        expect(rebuilt?.resources?.items ?? []).toEqual(
          normalizePostResourceItems(bundle.resources?.items, bundle.resources)
        );
      });
    }
  });

  describe('lossless legacy compatibility', () => {
    for (const compatibilityCase of fixture.losslessCompatibilityCases) {
      it(`preserves ${compatibilityCase.name} on the first rebuild`, () => {
        const original = compatibilityBundle(compatibilityCase);
        const cards = hydratePostComposerResourceCards(original);
        const rebuilt = rebuildBundle(original, cards);

        expect(cards).toHaveLength(1);
        expect(cards[0]).toMatchObject(compatibilityCase.expectedCard);
        expect(rebuilt?.resources?.sections).toEqual(original.resources?.sections);
        // Strict equality protects text, files, URLs, snapshots, item-specific
        // scopes, roles and remix intent—not just card counts or a second pass.
        expect(rebuilt?.resources?.items).toEqual(original.resources?.items);
      });
    }

    it('publishes a legacy-private title only after an explicit public-title edit', () => {
      const original = compatibilityBundle(fixture.losslessCompatibilityCases[0]);
      const [card] = hydratePostComposerResourceCards(original);
      const untouched = rebuildBundle(original, [card!]);
      const explicitlyRetitled = rebuildBundle(original, [{
        ...card!,
        title: 'Reusable launch prompt',
        publicTitleIntent: 'explicit',
      }]);

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
