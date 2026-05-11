import { describe, expect, it } from 'vitest';

import { validatePostResourceBundleInput } from '@/lib/post-resource-bundles';

describe('post resource bundle validation', () => {
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
  });
});
