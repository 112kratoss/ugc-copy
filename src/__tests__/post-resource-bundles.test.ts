import { describe, expect, it } from 'vitest';

import {
  buildPostResourceBundleLockedPreview,
  formatPostResourceBundleCountSummary,
  formatPostResourceItemCountSummary,
  normalizePostResourceItems,
  normalizePostResourceSections,
  resolvePostRemixCapability,
  validatePostResourceBundleInput,
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
    expect(formatPostResourceItemCountSummary(preview.itemCounts)).toBe('1 prompt, 2 workflows, 2 reference images, 1 note');
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
    expect(preview.sectionPreviews.map((section) => section.title)).toEqual(['Hook', 'Section 2']);
    expect(formatPostResourceBundleCountSummary(preview)).toBe('2 sections, 1 prompt, 1 reference image');
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
