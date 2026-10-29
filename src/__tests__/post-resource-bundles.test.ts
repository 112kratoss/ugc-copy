import { describe, expect, it } from 'vitest';

import {
  buildPostResourceBundleLockedPreview,
  formatPostResourceBundleCountSummary,
  formatPostResourceCompactPriceLabel,
  formatPostResourceCreditAmount,
  formatPostResourceDownloadName,
  formatPostResourceItemCountSummary,
  formatPostResourcePriceLabel,
  getBundleAccessLabel,
  getPostResourceBundleLengthError,
  normalizePostResourceItems,
  normalizePostResourceSections,
  resolvePostRemixCapability,
  resolveRecipeAllowRemix,
  sanitizePostResourceBundleLockedPreview,
  validatePostResourceBundleInput,
  type PostResourceBundleInput,
} from '@/lib/post-resource-bundles';

describe('post resource bundle validation', () => {
  it('normalizes multiple typed resource items and exposes preview counts', () => {
    const items = normalizePostResourceItems([
      {
        type: 'workflow',
        role: 'primary',
        title: 'Main workflow',
        externalUrl: 'https://example.com/workflow',
        remixUse: 'import_source',
      },
      {
        type: 'workflow',
        role: 'supporting_workflow',
        title: 'Variation workflow',
        storagePath: 'user-1/workflows/variation.json',
        contentType: 'application/json',
      },
      {
        type: 'reference_image',
        role: 'style_reference',
        title: 'Style frame',
        storagePath: 'user-1/references/style.png',
        contentType: 'image/png',
      },
      {
        type: 'reference_image',
        role: 'product_reference',
        title: 'Product frame',
        externalUrl: 'https://example.com/product.png',
      },
      {
        type: 'prompt',
        title: 'Prompt',
        textContent: 'Use a proof-led hook with a product close-up.',
      },
      {
        type: 'note',
        title: 'Settings',
        textContent: 'Use a 9:16 frame and keep the first cut under two seconds.',
      },
    ]);
    const preview = buildPostResourceBundleLockedPreview({ items });

    expect(items).toHaveLength(6);
    expect(preview.itemCounts).toMatchObject({
      prompt: 1,
      workflow: 2,
      reference_image: 2,
      note: 1,
    });
    expect(preview.resourceKinds).toEqual(['prompt', 'workflow', 'files', 'notes']);
    // Counted in the order an unlocked recipe reads (the shared reading rule).
    expect(formatPostResourceItemCountSummary(preview.itemCounts)).toBe('1 prompt, 2 reference images, 1 note, 2 workflows');
  });

  it('falls back from legacy resource fields to typed resource items', () => {
    const items = normalizePostResourceItems(undefined, {
      promptText: 'A reusable prompt for a product proof ad.',
      notesMarkdown: 'Step 1: lead with the problem. Step 2: prove the result.',
      workflowShareUrl: 'https://example.com/workflow',
      workflowSnapshot: null,
      attachments: [
        {
          label: 'Reference frame',
          kind: 'file',
          storagePath: 'user-1/references/frame.png',
          contentType: 'image/png',
        },
        {
          label: 'Preset link',
          kind: 'link',
          url: 'https://example.com/preset',
        },
      ],
      allowRemix: true,
    });

    expect(items.map((item) => item.type)).toEqual([
      'prompt',
      'workflow',
      'reference_image',
      'external_link',
      'note',
      'remix_access',
    ]);
    expect(items.map((item) => item.id)).toEqual([
      'item-1',
      'item-2',
      'item-3',
      'item-4',
      'item-5',
      'item-6',
    ]);
    expect(items.every((item) => item.scope.kind === 'all')).toBe(true);
  });

  it('preserves media scopes and validates their stable proof-media keys', () => {
    const bundle = {
      accessMode: 'free' as const,
      resources: {
        items: [{
          id: 'hook-prompt',
          scope: { kind: 'media' as const, mediaKeys: ['proof-a', 'proof-b'] },
          type: 'prompt' as const,
          title: 'Hook prompt',
          textContent: 'Open on the product result.',
        }],
      },
    };

    expect(normalizePostResourceItems(bundle.resources.items)[0]).toMatchObject({
      id: 'hook-prompt',
      scope: { kind: 'media', mediaKeys: ['proof-a', 'proof-b'] },
    });
    expect(validatePostResourceBundleInput(bundle, { mediaKeys: ['proof-a', 'proof-b'] })).toBeNull();
    expect(validatePostResourceBundleInput(bundle, { mediaKeys: ['proof-a'] })).toMatch(/not part of this post/i);
  });

  it('counts video, audio, and gated remix-link resources without enabling native remix', () => {
    const items = normalizePostResourceItems([
      { type: 'reference_video', title: 'Motion reference', storagePath: 'user-1/reference.mp4' },
      { type: 'reference_audio', title: 'Voice reference', storagePath: 'user-1/reference.mp3' },
      {
        type: 'remix_link',
        title: 'External remix',
        externalUrl: 'https://example.com/remix',
        remixUse: 'direct_remix',
      },
    ]);
    const preview = buildPostResourceBundleLockedPreview({ items });
    const sanitized = sanitizePostResourceBundleLockedPreview(preview);

    expect(items.map((item) => item.remixUse)).toEqual(['reference_only', 'reference_only', 'none']);
    expect(preview.itemCounts).toMatchObject({ reference_video: 1, reference_audio: 1, remix_link: 1 });
    expect(preview.hasRemix).toBe(true);
    expect(sanitized?.hasRemix).toBe(true);
    expect(JSON.stringify(sanitized)).not.toContain('https://example.com/remix');
    expect(resolvePostRemixCapability({
      generationId: null,
      postFormat: 'media',
      category: 'image',
      sourceKind: 'external',
      resourceBundle: { viewerCanAccess: false, allowRemix: false, items: [items[2]!] },
    })).toEqual({ capability: 'unsupported', target: null });
  });

  it('normalizes optional resource sections and keeps invalid item section ids global', () => {
    const sections = normalizePostResourceSections([
      {
        id: 'hook',
        title: 'Hook',
        kind: 'scene',
        description: 'Opening seven seconds',
      },
      {
        id: 'empty-title',
        title: '   ',
        kind: 'not-real',
      },
    ]);
    const items = normalizePostResourceItems([
      {
        type: 'prompt',
        title: 'Hook prompt',
        textContent: 'Open with the before state.',
        sectionId: 'hook',
      },
      {
        type: 'reference_image',
        title: 'Global style reference',
        storagePath: 'user-1/references/style.png',
        sectionId: 'missing-section',
      },
    ], { sections });
    const preview = buildPostResourceBundleLockedPreview({ sections, items });

    expect(sections).toEqual([
      expect.objectContaining({
        id: 'hook',
        title: 'Hook',
        kind: 'scene',
        description: 'Opening seven seconds',
        sortOrder: 0,
      }),
      expect.objectContaining({
        id: 'empty-title',
        title: 'Section 2',
        kind: 'other',
        description: null,
        sortOrder: 1,
      }),
    ]);
    expect(items[0]?.sectionId).toBe('hook');
    expect(items[1]?.sectionId).toBeNull();
    expect(preview.sectionCount).toBe(2);
    expect(preview.sectionPreviews?.map((section) => section.title)).toEqual(['Hook', 'Section 2']);
    // Buyers never meet "sections" (B-F16): the count names what they get.
    expect(formatPostResourceBundleCountSummary(preview)).toBe('1 prompt, 1 reference image');
  });

  it('removes paid input names and section metadata from locked previews', () => {
    const preview = buildPostResourceBundleLockedPreview({
      attachments: [{
        label: 'Secret client brief.pdf',
        kind: 'file',
        storagePath: 'user-1/secret-client-brief.pdf',
        contentType: 'application/pdf',
        sizeBytes: 2048,
      }],
      sections: [{
        id: 'private-hook',
        title: 'Confidential launch hook',
        kind: 'scene',
        description: 'Reveal the unreleased product here.',
        sortOrder: 0,
      }],
      items: [{
        type: 'prompt',
        role: 'primary',
        title: 'Unreleased campaign prompt',
        description: null,
        textContent: 'This text must never appear before purchase.',
        externalUrl: null,
        storagePath: null,
        contentType: null,
        sizeBytes: null,
        workflowSnapshot: null,
        sectionId: 'private-hook',
        sortOrder: 0,
        isPrimary: true,
        remixUse: 'none',
      }],
    });

    const sanitized = sanitizePostResourceBundleLockedPreview(preview);
    const serialized = JSON.stringify(sanitized);

    expect(sanitized?.itemCounts).toEqual({ prompt: 1 });
    expect(sanitized?.sectionCount).toBe(1);
    expect(sanitized?.attachmentPreviews).toEqual([expect.objectContaining({ label: 'File 1' })]);
    expect(sanitized?.itemPreviews).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'prompt', title: 'Prompt', sectionId: null }),
    ]));
    expect(sanitized?.sectionPreviews).toEqual([]);
    expect(serialized).not.toContain('Secret client brief');
    expect(serialized).not.toContain('Confidential launch hook');
    expect(serialized).not.toContain('Reveal the unreleased product');
    expect(serialized).not.toContain('Unreleased campaign prompt');
    expect(serialized).not.toContain('application/pdf');
    expect(sanitized?.cardPreviews).toEqual([]);
  });

  it('publishes only explicitly authored public card metadata in locked previews', () => {
    const preview = buildPostResourceBundleLockedPreview({
      sections: [{
        id: 'hook',
        title: 'Private internal hook notes',
        publicTitle: 'Hook prompt pack',
        resourceType: 'prompt',
        scope: { kind: 'media', mediaKeys: ['proof-a'] },
        kind: 'scene',
        description: 'Private section instructions',
        sortOrder: 0,
      }],
      items: [{
        id: 'hook-prompt',
        scope: { kind: 'media', mediaKeys: ['proof-a'] },
        type: 'prompt',
        role: 'primary',
        sectionId: 'hook',
        title: 'Private prompt name',
        description: null,
        textContent: 'Private prompt content',
        externalUrl: null,
        storagePath: null,
        contentType: null,
        sizeBytes: null,
        workflowSnapshot: null,
        sortOrder: 0,
        isPrimary: true,
        remixUse: 'none',
      }],
    });

    const sanitized = sanitizePostResourceBundleLockedPreview(preview);
    expect(sanitized?.cardPreviews).toEqual([{
      sectionId: 'hook',
      publicTitle: 'Hook prompt pack',
      resourceType: 'prompt',
      scope: { kind: 'media', mediaKeys: ['proof-a'] },
      itemCount: 1,
      hasRemix: false,
    }]);
    expect(JSON.stringify(sanitized)).not.toContain('Private internal hook notes');
    expect(JSON.stringify(sanitized)).not.toContain('Private prompt name');
  });

  it('accepts real unlock content for free and paid bundles', () => {
    expect(validatePostResourceBundleInput({
      accessMode: 'paid',
      priceUsdCents: 500,
      resources: {
        promptText: 'Use a direct hook, show the product, then cut to proof.',
        attachments: [],
        allowRemix: false,
      },
    })).toBeNull();

    expect(validatePostResourceBundleInput({
      accessMode: 'free',
      resources: {
        attachments: [],
        allowRemix: true,
      },
    })).toBeNull();
  });

  it('requires paid prices to start at 10 and use 10-credit increments', () => {
    const bundleForPrice = (priceUsdCents: number) => ({
      accessMode: 'paid' as const,
      priceUsdCents,
      resources: { promptText: 'A complete reusable prompt.' },
    });

    expect(validatePostResourceBundleInput(bundleForPrice(10))).toBeNull();
    expect(validatePostResourceBundleInput(bundleForPrice(20))).toBeNull();
    expect(validatePostResourceBundleInput(bundleForPrice(9))).toMatch(/at least 10 credits/i);
    expect(validatePostResourceBundleInput(bundleForPrice(15))).toMatch(/10-credit increments/i);
  });

  it('accepts bundles powered only by typed resource items', () => {
    expect(validatePostResourceBundleInput({
      accessMode: 'paid',
      priceUsdCents: 500,
      resources: {
        items: [
          {
            type: 'reference_image',
            role: 'style_reference',
            title: 'Style board',
            storagePath: 'user-1/references/style.png',
            contentType: 'image/png',
          },
          {
            type: 'workflow',
            role: 'primary',
            title: 'Reusable workflow',
            externalUrl: 'https://example.com/workflow',
            remixUse: 'import_source',
          },
        ],
      },
    }, { ownerUserId: 'user-1' })).toBeNull();
  });

  it('rejects unlocks without resource content', () => {
    expect(validatePostResourceBundleInput({
      accessMode: 'paid',
      priceUsdCents: 500,
      resources: {
        promptText: '   ',
        notesMarkdown: '',
        workflowShareUrl: '',
        attachments: [],
        allowRemix: false,
      },
    })).toMatch(/add content/i);
  });

  it('rejects unsafe resource links', () => {
    expect(validatePostResourceBundleInput({
      accessMode: 'free',
      resources: {
        workflowShareUrl: 'javascript:alert(1)',
        attachments: [],
        allowRemix: false,
      },
    })).toMatch(/workflow links must start/i);

    expect(validatePostResourceBundleInput({
      accessMode: 'free',
      resources: {
        attachments: [{
          label: 'Unsafe link',
          kind: 'link',
          url: 'data:text/html,<script>alert(1)</script>',
        }],
        allowRemix: false,
      },
    })).toMatch(/unlock links must start/i);

    expect(validatePostResourceBundleInput({
      accessMode: 'free',
      resources: {
        items: [{
          type: 'workflow',
          title: 'Unsafe workflow',
          externalUrl: 'javascript:alert(1)',
        }],
      },
    })).toMatch(/resource links must start/i);
  });

  it('requires uploaded files to stay under the creator storage prefix', () => {
    expect(validatePostResourceBundleInput({
      accessMode: 'paid',
      priceUsdCents: 500,
      resources: {
        attachments: [{
          label: 'Workflow file',
          kind: 'file',
          storagePath: 'other-user/workflow.json',
        }],
        allowRemix: false,
      },
    }, { ownerUserId: 'user-1' })).toMatch(/belong to the creator/i);

    expect(validatePostResourceBundleInput({
      accessMode: 'paid',
      priceUsdCents: 500,
      resources: {
        attachments: [{
          label: 'Workflow file',
          kind: 'file',
          storagePath: 'user-1/workflow.json',
        }],
        allowRemix: false,
      },
    }, { ownerUserId: 'user-1' })).toBeNull();

    expect(validatePostResourceBundleInput({
      accessMode: 'paid',
      priceUsdCents: 500,
      resources: {
        items: [{
          type: 'source_file',
          title: 'Workflow file',
          storagePath: '../workflow.json',
        }],
      },
    }, { ownerUserId: 'user-1' })).toMatch(/belong to the creator/i);

    for (const storagePath of [
      'user-1/%252e%252e/other-user/workflow.json',
      'user-1%252fother-user/workflow.json',
      'user-1/%255cother-user/workflow.json',
      'user-1//workflow.json',
    ]) {
      expect(validatePostResourceBundleInput({
        accessMode: 'paid',
        priceUsdCents: 500,
        resources: {
          attachments: [{ label: 'Workflow file', kind: 'file', storagePath }],
          allowRemix: false,
        },
      }, { ownerUserId: 'user-1' })).toMatch(/belong to the creator/i);
    }
  });

  it('resolves smart remix capability from post and resource context', () => {
    expect(resolvePostRemixCapability({
      generationId: 'generation-1',
      postFormat: 'media',
      category: 'image',
      sourceKind: 'magicbooklet',
      resourceBundle: null,
    })).toEqual({
      capability: 'public',
      target: 'image',
    });

    expect(resolvePostRemixCapability({
      generationId: null,
      postFormat: 'media',
      category: 'image',
      sourceKind: 'external',
      resourceBundle: {
        viewerCanAccess: false,
        allowRemix: false,
        items: normalizePostResourceItems([{
          type: 'workflow',
          title: 'External workflow',
          externalUrl: 'https://example.com/workflow',
          remixUse: 'import_source',
        }]),
      },
    })).toEqual({
      capability: 'unlock_required',
      target: 'workflow',
    });

    expect(resolvePostRemixCapability({
      generationId: null,
      postFormat: 'text',
      category: 'text',
      sourceKind: 'manual',
      resourceBundle: {
        viewerCanAccess: true,
        allowRemix: false,
        items: normalizePostResourceItems([{
          type: 'note',
          title: 'Reusable template',
          textContent: 'Hook / proof / CTA',
          remixUse: 'text_template',
        }]),
      },
    })).toEqual({
      capability: 'public',
      target: 'text_template',
    });

    expect(resolvePostRemixCapability({
      generationId: null,
      postFormat: 'media',
      category: 'video',
      sourceKind: 'external',
      resourceBundle: null,
    })).toEqual({
      capability: 'unsupported',
      target: null,
    });
  });
});

// Recipe audit H1 (2026-10-27): a creation post's published recipe includes
// its Remix. Whoever has not unlocked the recipe unlocks it to remix, whatever
// the stored "Allow direct remix" switch says, so the creation's prompt and
// settings never reach someone who has not unlocked a recipe that sells them.
describe('a creation post’s recipe includes its Remix', () => {
  const creationPost = {
    generationId: 'generation-1',
    postFormat: 'media',
    category: 'image',
    sourceKind: 'magicbooklet',
  };
  const promptItems = normalizePostResourceItems([{
    type: 'prompt',
    title: 'Exact generation prompt',
    textContent: 'A neon portrait with rim light.',
  }]);

  it.each([
    ['free or paid, switch off', false],
    ['switch on', true],
  ])('asks someone who has not unlocked it to unlock first (%s)', (_label, allowRemix) => {
    expect(resolvePostRemixCapability({
      ...creationPost,
      resourceBundle: { viewerCanAccess: false, allowRemix, items: promptItems },
    })).toEqual({ capability: 'unlock_required', target: 'image' });
  });

  it('opens Remix to the owner and to whoever unlocked it', () => {
    expect(resolvePostRemixCapability({
      ...creationPost,
      resourceBundle: { viewerCanAccess: true, allowRemix: false, items: promptItems },
    })).toEqual({ capability: 'public', target: 'image' });
  });

  it('leaves a creation post without a recipe, an upload and a template result as they were', () => {
    expect(resolvePostRemixCapability({ ...creationPost, resourceBundle: null }))
      .toEqual({ capability: 'public', target: 'image' });
    expect(resolvePostRemixCapability({
      generationId: null,
      postFormat: 'media',
      category: 'image',
      sourceKind: 'external',
      resourceBundle: { viewerCanAccess: false, allowRemix: false, items: promptItems },
    })).toEqual({ capability: 'unsupported', target: null });
    expect(resolvePostRemixCapability({
      ...creationPost,
      templateResult: true,
      resourceBundle: { viewerCanAccess: false, allowRemix: false, items: promptItems },
    })).toEqual({ capability: 'none', target: null });
  });

  it('reads a published creation recipe as remix-included, and nothing else', () => {
    const published = { storedAllowRemix: false, status: 'published', generationId: 'generation-1' };

    expect(resolveRecipeAllowRemix(published)).toBe(true);
    expect(resolveRecipeAllowRemix({ ...published, storedAllowRemix: null })).toBe(true);
    // A draft or retired recipe sells nothing, so it gates nothing.
    expect(resolveRecipeAllowRemix({ ...published, status: 'draft' })).toBe(false);
    expect(resolveRecipeAllowRemix({ ...published, generationId: null })).toBe(false);
    expect(resolveRecipeAllowRemix({ ...published, templateResult: true })).toBe(false);
    // What is stored on is still on.
    expect(resolveRecipeAllowRemix({ ...published, status: 'draft', storedAllowRemix: true })).toBe(true);
  });

  it('lists Remix among a remix-included recipe’s kinds, beside its items', () => {
    expect(buildPostResourceBundleLockedPreview({ items: promptItems, allowRemix: true }).resourceKinds)
      .toEqual(['prompt', 'remix']);
    expect(buildPostResourceBundleLockedPreview({ items: promptItems, allowRemix: false }).resourceKinds)
      .toEqual(['prompt']);
  });
});

describe('buyer-facing recipe counts', () => {
  it('counts items in plain words, without sections', () => {
    const items = normalizePostResourceItems([
      { type: 'prompt', title: 'Prompt', textContent: 'A neon portrait.' },
      { type: 'settings', title: 'Model settings', textContent: 'Seed 42' },
      { type: 'source_file', title: 'Project file', storagePath: 'user-1/project.zip' },
      { type: 'source_file', title: 'Brushes', storagePath: 'user-1/brushes.zip' },
      { type: 'external_link', title: 'Tutorial', externalUrl: 'https://example.com/tutorial' },
    ]);
    const preview = buildPostResourceBundleLockedPreview({
      sections: normalizePostResourceSections([{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }]),
      items,
    });

    expect(formatPostResourceBundleCountSummary(preview)).toBe('1 prompt, settings, 2 files, 1 link');
    expect(formatPostResourceItemCountSummary({ settings: 2, source_file: 1 })).toBe('settings, 1 file');
  });
});

// Both composers cap the public summary and the package preview at 180
// characters and a card's unlocked description at 120. The server now holds
// every route to the same numbers, except for a value already stored, which
// a whole-draft save sends back unchanged.
describe('recipe copy length', () => {
  function recipe({
    accessMode = 'paid',
    summary = 'A reusable lighting setup for portraits.',
    previewText = 'Includes the prompt and the light plan.',
    cardDescription = 'The prompt behind the portrait.',
  }: {
    accessMode?: PostResourceBundleInput['accessMode'];
    summary?: string;
    previewText?: string;
    cardDescription?: string;
  } = {}): PostResourceBundleInput {
    return {
      accessMode,
      priceUsdCents: 900,
      summary,
      previewText,
      resources: {
        sections: [
          { id: 'card-1', title: 'Portrait prompt', kind: 'global', description: cardDescription, sortOrder: 0 },
          { id: 'card-2', title: 'Light plan', kind: 'global', description: null, sortOrder: 1 },
        ],
        items: [{
          type: 'prompt',
          role: 'primary',
          sectionId: 'card-1',
          title: 'Portrait prompt',
          description: null,
          textContent: 'Soft key light from the left, warm rim light behind.',
          externalUrl: null,
          storagePath: null,
          contentType: null,
          sizeBytes: null,
          workflowSnapshot: null,
          sortOrder: 0,
          isPrimary: true,
          remixUse: 'none',
        }],
      },
    };
  }

  it('accepts copy exactly at the limits', () => {
    expect(getPostResourceBundleLengthError(recipe({
      summary: 's'.repeat(180),
      previewText: 'p'.repeat(180),
      cardDescription: 'u'.repeat(120),
    }))).toBeNull();
  });

  it.each([
    ['the public summary', { summary: 's'.repeat(181) }, 'resourceSummary', 'Public summaries are limited to 180 characters.'],
    ['the package preview', { previewText: 'p'.repeat(181) }, 'resourcePreview', 'Package previews are limited to 180 characters.'],
    ["a card's unlocked description", { cardDescription: 'u'.repeat(121) }, 'resourceCards', 'Unlocked descriptions are limited to 120 characters.'],
  ] as const)('refuses %s past its limit', (_label, copy, field, error) => {
    expect(getPostResourceBundleLengthError(recipe(copy))).toEqual({ error, field });
  });

  it('measures the copy as it is stored, without surrounding whitespace', () => {
    expect(getPostResourceBundleLengthError(recipe({ summary: `  ${'s'.repeat(180)}\n` }))).toBeNull();
  });

  it('lets a value already stored come back unchanged', () => {
    const stored = recipe({
      summary: 's'.repeat(200),
      previewText: 'p'.repeat(200),
      cardDescription: 'u'.repeat(150),
    });

    expect(getPostResourceBundleLengthError(stored, stored)).toBeNull();
  });

  // A blank summary field is sent as the preview, so a stored preview can come
  // back as the summary without anyone typing it.
  it('lets a stored preview come back as the summary', () => {
    const longPreview = 'p'.repeat(200);

    expect(getPostResourceBundleLengthError(
      recipe({ summary: longPreview, previewText: longPreview }),
      recipe({ summary: '', previewText: longPreview }),
    )).toBeNull();
  });

  it('refuses a stored value once it is changed into a different over-limit one', () => {
    expect(getPostResourceBundleLengthError(
      recipe({ cardDescription: 'v'.repeat(150) }),
      recipe({ cardDescription: 'u'.repeat(150) }),
    )).toMatchObject({ field: 'resourceCards' });
  });

  it('has nothing to measure when the save stores no recipe', () => {
    expect(getPostResourceBundleLengthError(null)).toBeNull();
    expect(getPostResourceBundleLengthError(recipe({ accessMode: 'none', summary: 's'.repeat(400) }))).toBeNull();
  });

  // The database write reruns validatePostResourceBundleInput on every save,
  // so a cap there would turn an unchanged stored value into a failed save.
  it('stays out of the structural validation', () => {
    expect(validatePostResourceBundleInput(recipe({ summary: 's'.repeat(400) }))).toBeNull();
  });
});

describe('recipe price labels', () => {
  it('names both ways to pay for a cash-eligible recipe and credits alone below the cash minimum', () => {
    expect(formatPostResourcePriceLabel(900, '$9.00')).toBe('$9.00 · 900 credits');
    // The viewer's own quote is the cash part when there is one.
    expect(formatPostResourcePriceLabel(1500, '₹1,250.00')).toBe('₹1,250.00 · 1,500 credits');
    expect(formatPostResourcePriceLabel(1500)).toBe('$15.00 · 1,500 credits');
    expect(formatPostResourcePriceLabel(100, null)).toBe('$1.00 · 100 credits');
    // Below 100 credits there is no cash checkout, so no cash figure either.
    expect(formatPostResourcePriceLabel(50, '$0.50')).toBe('50 credits');
    expect(formatPostResourcePriceLabel(99)).toBe('99 credits');
  });

  it('gives chips and badges one figure, never a cash one for a credits-only recipe', () => {
    expect(formatPostResourceCompactPriceLabel(900, '$9.00')).toBe('$9.00');
    expect(formatPostResourceCompactPriceLabel(1500, '₹1,250.00')).toBe('₹1,250.00');
    expect(formatPostResourceCompactPriceLabel(100)).toBe('$1.00');
    expect(formatPostResourceCompactPriceLabel(50, '$0.50')).toBe('50 credits');
    expect(formatPostResourceCompactPriceLabel(90, '₹76')).toBe('90 credits');
  });

  it('labels a listed recipe free, or by its one-figure price', () => {
    expect(getBundleAccessLabel('free', 500)).toBe('Free recipe');
    expect(getBundleAccessLabel('paid', 0)).toBe('Free recipe');
    expect(getBundleAccessLabel('paid', 900)).toBe('$9.00');
    expect(getBundleAccessLabel('paid', 900, '₹750')).toBe('₹750');
    expect(getBundleAccessLabel('paid', 50, '$0.50')).toBe('50 credits');
  });

  it('groups thousands the same way everywhere and counts one credit as one', () => {
    expect(formatPostResourceCreditAmount(1500)).toBe('1,500 credits');
    expect(formatPostResourceCreditAmount(1)).toBe('1 credit');
    expect(formatPostResourceCreditAmount(-5)).toBe('0 credits');
  });
});

describe('resource download names', () => {
  it('adds the extension of the content type to a title that has none', () => {
    expect(formatPostResourceDownloadName('Reference 1', 'image/png')).toBe('Reference 1.png');
    expect(formatPostResourceDownloadName('Brief', 'application/pdf; charset=binary')).toBe('Brief.pdf');
    expect(formatPostResourceDownloadName('  ', 'video/quicktime')).toBe('Resource file.mov');
  });

  it('keeps a title that already ends in an extension of its type, and an unknown type as it is', () => {
    expect(formatPostResourceDownloadName('frame.JPEG', 'image/jpeg')).toBe('frame.JPEG');
    expect(formatPostResourceDownloadName('notes.markdown', 'text/markdown')).toBe('notes.markdown');
    expect(formatPostResourceDownloadName('Blob', 'application/octet-stream')).toBe('Blob');
    expect(formatPostResourceDownloadName('Element 1', null)).toBe('Element 1');
    expect(formatPostResourceDownloadName('Element 1', 'constructor')).toBe('Element 1');
  });
});
