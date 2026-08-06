import { describe, expect, it } from 'vitest';

import {
  buildResourceCardBundleInput,
  createPostComposerResourceCard,
  getPostComposerResourceCardErrors,
  getResourceCardPreview,
  getResourceCardSummary,
  hydratePostComposerResourceCards,
  isPostComposerResourceCardReady,
  POST_COMPOSER_RESOURCE_CARD_OPTIONS,
  resourceCardHasContent,
} from '@/lib/post-composer-resource-cards';

// Payload equality with the mobile composer is covered by
// post-resource-bundle-authoring-fixture.test.ts. This file covers the
// composer-facing helpers around it, which never reach the wire.
describe('post composer resource cards', () => {
  it('offers a card type for every kind of thing a buyer can receive', () => {
    expect(POST_COMPOSER_RESOURCE_CARD_OPTIONS.map((option) => option.id)).toEqual([
      'prompt',
      'reference_media',
      'settings',
      'workflow',
      'source_assets',
      'guide',
      'external_link',
      'remix_link',
      'other',
    ]);
  });

  it('titles a new card after its type so a section always has a public title', () => {
    const card = createPostComposerResourceCard('reference_media');

    expect(card.title).toBe('Reference media');
    expect(card.appliesToAll).toBe(true);
    expect(card.mediaKeys).toEqual([]);
    // Absent rather than null, so a card the composer made compares equal to a
    // mobile draft.
    expect('workflowSnapshot' in card).toBe(false);
  });

  describe('content requirements per card type', () => {
    it('asks text cards for text', () => {
      const card = createPostComposerResourceCard('prompt');

      expect(resourceCardHasContent(card)).toBe(false);
      expect(getPostComposerResourceCardErrors(card)).toEqual({
        content: 'Add the protected content, link, or file for this resource.',
      });
      expect(isPostComposerResourceCardReady({ ...card, textContent: 'A prompt' })).toBe(true);
    });

    it('asks link cards for a link, not text', () => {
      const card = createPostComposerResourceCard('external_link', { textContent: 'not a link' });

      expect(resourceCardHasContent(card)).toBe(false);
      expect(resourceCardHasContent({ ...card, externalUrl: 'https://example.com' })).toBe(true);
    });

    it('rejects every populated non-http protected URL locally', () => {
      const invalidLink = createPostComposerResourceCard('external_link', { externalUrl: 'example.com' });
      const invalidWorkflow = createPostComposerResourceCard('workflow', {
        externalUrl: 'javascript:alert(1)',
        workflowSnapshot: {
          version: 1,
          nodes: [],
          edges: [],
          viewport: { x: 0, y: 0, zoom: 1 },
        },
      });
      const invalidAttachment = createPostComposerResourceCard('source_assets', {
        attachments: [{
          id: 'link-1',
          kind: 'link',
          label: 'Project',
          url: 'ftp://example.com/project',
        }],
      });

      for (const card of [invalidLink, invalidWorkflow, invalidAttachment]) {
        expect(getPostComposerResourceCardErrors(card).content).toBe(
          'Add a valid http:// or https:// link.'
        );
        expect(isPostComposerResourceCardReady(card)).toBe(false);
      }
    });

    it('asks media cards for a file that actually landed in storage', () => {
      const card = createPostComposerResourceCard('reference_media', {
        attachments: [{ id: 'a1', kind: 'file', label: 'ref.png', storagePath: '' }],
      });

      expect(resourceCardHasContent(card)).toBe(false);
      expect(resourceCardHasContent({
        ...card,
        attachments: [{ id: 'a1', kind: 'file', label: 'ref.png', storagePath: 'user-1/ref.png' }],
      })).toBe(true);
    });

    it('keeps snapshot-only workflows and file-backed presets publishable', () => {
      const workflow = createPostComposerResourceCard('workflow', {
        workflowSnapshot: {
          version: 1,
          nodes: [],
          edges: [],
          viewport: { x: 0, y: 0, zoom: 1 },
        },
      });
      const preset = createPostComposerResourceCard('settings', {
        attachments: [{
          id: 'preset-1',
          kind: 'file',
          label: 'camera.preset',
          storagePath: 'user-1/camera.preset',
          resourceType: 'preset',
          role: 'manual_import',
          remixUse: 'import_source',
        }],
      });

      expect(resourceCardHasContent(workflow)).toBe(true);
      expect(resourceCardHasContent(preset)).toBe(true);

      const workflowBundle = buildResourceCardBundleInput({
        accessMode: 'free', cards: [workflow], allowRemix: false,
        summary: '', previewText: '', priceTokens: 0,
      });
      const presetBundle = buildResourceCardBundleInput({
        accessMode: 'free', cards: [preset], allowRemix: false,
        summary: '', previewText: '', priceTokens: 0,
      });

      expect(workflowBundle?.resources?.items?.[0]?.workflowSnapshot).toEqual({
        version: 1,
        nodes: [],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      });
      expect(presetBundle?.resources?.items?.[0]).toMatchObject({
        type: 'preset',
        role: 'manual_import',
        remixUse: 'import_source',
        storagePath: 'user-1/camera.preset',
      });
    });

    it('reports a missing title separately from missing content', () => {
      const card = createPostComposerResourceCard('prompt', { title: '  ', textContent: 'A prompt' });

      expect(getPostComposerResourceCardErrors(card)).toEqual({ title: 'Add a resource title.' });
    });
  });

  it('drops cards with no content instead of publishing empty sections', () => {
    const bundle = buildResourceCardBundleInput({
      accessMode: 'free',
      cards: [
        createPostComposerResourceCard('prompt', { id: 'resource-kept', textContent: 'Real prompt' }),
        createPostComposerResourceCard('guide', { id: 'resource-empty' }),
      ],
      allowRemix: false,
      summary: '',
      previewText: '',
      priceTokens: 0,
    });

    expect(bundle?.resources?.sections).toHaveLength(1);
    expect(bundle?.resources?.sections?.[0]?.id).toBe('resource-kept');
  });

  it('preserves a stored attachment external fallback when its visible label changes', () => {
    const original = buildResourceCardBundleInput({
      accessMode: 'free',
      cards: [createPostComposerResourceCard('source_assets', {
        id: 'dual-location-card',
        attachments: [{
          id: 'dual-location-file',
          kind: 'file',
          label: 'Project archive',
          storagePath: 'user-1/project.zip',
          contentType: 'application/zip',
          sizeBytes: 42,
        }],
      })],
      allowRemix: false,
      summary: 'Project files',
      previewText: 'Includes the project archive.',
      priceTokens: 0,
    });
    const originalItem = original?.resources?.items?.[0];
    expect(originalItem).toBeTruthy();
    originalItem!.externalUrl = 'https://downloads.example.com/project.zip';

    const [hydratedCard] = hydratePostComposerResourceCards(original);
    const rebuilt = buildResourceCardBundleInput({
      accessMode: 'free',
      cards: [{
        ...hydratedCard!,
        attachments: hydratedCard!.attachments.map((attachment) => ({
          ...attachment,
          label: 'Renamed project archive',
        })),
      }],
      allowRemix: false,
      summary: 'Project files',
      previewText: 'Includes the project archive.',
      priceTokens: 0,
    });

    expect(rebuilt?.resources?.items?.[0]).toMatchObject({
      ...originalItem,
      title: 'Renamed project archive',
      externalUrl: 'https://downloads.example.com/project.zip',
    });
  });

  it('removes only the file fields from a workflow item that also backs a visible URL', () => {
    const original = buildResourceCardBundleInput({
      accessMode: 'free',
      cards: [createPostComposerResourceCard('workflow', {
        id: 'combined-workflow',
        externalUrl: 'https://workflow.example.com/share/combined',
        attachments: [{
          id: 'combined-workflow-file',
          kind: 'file',
          label: 'workflow.json',
          storagePath: 'user-1/workflow.json',
          contentType: 'application/json',
          sizeBytes: 84,
        }],
      })],
      allowRemix: false,
      summary: 'Workflow files',
      previewText: 'Includes the shared workflow and its import file.',
      priceTokens: 0,
    });
    const [urlItem, fileItem] = original?.resources?.items ?? [];
    expect(urlItem).toBeTruthy();
    expect(fileItem).toBeTruthy();
    original!.resources!.items = [{
      ...urlItem!,
      storagePath: fileItem!.storagePath,
      contentType: fileItem!.contentType,
      sizeBytes: fileItem!.sizeBytes,
    }];
    const [hydratedCard] = hydratePostComposerResourceCards(original);

    const rebuilt = buildResourceCardBundleInput({
      accessMode: 'free',
      cards: [{ ...hydratedCard!, attachments: [] }],
      allowRemix: false,
      summary: 'Workflow files',
      previewText: 'Includes the shared workflow and its import file.',
      priceTokens: 0,
    });

    expect(rebuilt?.resources?.items).toHaveLength(1);
    expect(rebuilt?.resources?.items?.[0]).toMatchObject({
      externalUrl: 'https://workflow.example.com/share/combined',
      storagePath: null,
      contentType: null,
      sizeBytes: null,
    });
  });

  it('returns no bundle at all when nothing has content', () => {
    expect(buildResourceCardBundleInput({
      accessMode: 'free',
      cards: [createPostComposerResourceCard('prompt')],
      allowRemix: false,
      summary: '',
      previewText: '',
      priceTokens: 0,
    })).toBeNull();

    expect(buildResourceCardBundleInput({
      accessMode: 'none',
      cards: [],
      allowRemix: false,
      summary: '',
      previewText: '',
      priceTokens: 0,
    })).toBeNull();
  });

  // A bundle written before the card model can grant remix and nothing else.
  // Dropping it here would revoke the permission on the next save.
  it('keeps a remix-only bundle alive even with no cards', () => {
    const bundle = buildResourceCardBundleInput({
      accessMode: 'free',
      cards: [],
      allowRemix: true,
      summary: '',
      previewText: '',
      priceTokens: 0,
    });

    expect(bundle?.resources?.allowRemix).toBe(true);
    expect(bundle?.resources?.items).toEqual([]);
  });

  describe('derived buyer copy', () => {
    const cards = ['One', 'Two', 'Three', 'Four'].map((title, index) => (
      createPostComposerResourceCard('prompt', { id: `resource-${index}`, title })
    ));

    it('names a single-card package after the card', () => {
      expect(getResourceCardSummary(cards.slice(0, 1))).toBe('One');
      expect(getResourceCardSummary(cards)).toBe('4 reusable resources');
    });

    it('lists up to three cards and counts the rest', () => {
      expect(getResourceCardPreview(cards.slice(0, 1))).toBe('Includes One.');
      expect(getResourceCardPreview(cards.slice(0, 3))).toBe('Includes One, Two, and Three.');
      expect(getResourceCardPreview(cards)).toBe('Includes One, Two, and Three and 1 more.');
    });

    // An author-written summary always wins over the derived one.
    it('keeps author copy when it is supplied', () => {
      const bundle = buildResourceCardBundleInput({
        accessMode: 'free',
        cards: [createPostComposerResourceCard('prompt', { id: 'resource-1', textContent: 'A prompt' })],
        allowRemix: false,
        summary: '  Hand written summary  ',
        previewText: '  Hand written preview  ',
        priceTokens: 0,
      });

      expect(bundle?.summary).toBe('Hand written summary');
      expect(bundle?.previewText).toBe('Hand written preview');
    });
  });
});
