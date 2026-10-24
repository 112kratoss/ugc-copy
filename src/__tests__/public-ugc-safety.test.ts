import { describe, expect, it } from 'vitest';

import type {
  PostResourceBundleInput,
  PostResourceBundleResources,
  PostResourceItem,
} from '@/lib/post-resource-bundles';
import {
  getPublicUgcRecipeTextFields,
  getPublicUgcSafetyViolation,
  isPubliclyVisibleReviewStatus,
} from '@/lib/public-ugc-safety';
import {
  createWorkflowNode,
  createWorkflowShareSnapshotGraph,
  type SerializedWorkflowCanvasGraph,
  type WorkflowNodeData,
  type WorkflowNodeKind,
} from '@/lib/workflow-canvas';

/**
 * A workflow graph as the canvas exports it for sharing, so the test reads the
 * keys the canvas really writes: one node per entry, its defaults overridden.
 */
function workflowGraph(
  ...nodes: Array<{ type: WorkflowNodeKind; id?: string; data?: Record<string, unknown> }>
): SerializedWorkflowCanvasGraph {
  return createWorkflowShareSnapshotGraph({
    nodes: nodes.map(({ type, id, data }) => {
      const node = createWorkflowNode(type, { x: 0, y: 0 });
      return { ...node, id: id ?? node.id, data: { ...node.data, ...data } as WorkflowNodeData };
    }),
    edges: [],
  });
}

/** A recipe as both composers write it: one card, legacy prompt and notes empty. */
function composerRecipe(overrides: {
  accessMode?: PostResourceBundleInput['accessMode'];
  cardTitle?: string;
  cardDescription?: string;
  cardText?: string;
  summary?: string;
  previewText?: string;
  /** Turns the card's one item into a link or a workflow. */
  item?: Partial<PostResourceItem>;
  /** The recipe's own link, graph and attachments, stored beside the cards. */
  resources?: Partial<PostResourceBundleResources>;
} = {}): PostResourceBundleInput {
  const cardTitle = overrides.cardTitle ?? 'Portrait prompt';
  return {
    accessMode: overrides.accessMode ?? 'paid',
    priceUsdCents: 900,
    summary: overrides.summary ?? 'A reusable lighting setup for portraits.',
    previewText: overrides.previewText ?? 'Includes the prompt and the light plan.',
    resources: {
      promptText: null,
      notesMarkdown: null,
      workflowShareUrl: null,
      workflowSnapshot: null,
      attachments: [],
      allowRemix: false,
      sections: [{
        id: 'card-1',
        title: cardTitle,
        publicTitle: cardTitle,
        kind: 'global',
        description: overrides.cardDescription ?? 'The prompt behind the portrait.',
        sortOrder: 0,
        resourceType: 'prompt',
        scope: { kind: 'all' },
      }],
      items: [{
        id: 'card-1-item-1',
        scope: { kind: 'all' },
        type: 'prompt',
        role: 'primary',
        sectionId: 'card-1',
        title: cardTitle,
        description: null,
        textContent: overrides.cardText ?? 'Soft key light from the left, warm rim light behind.',
        externalUrl: null,
        storagePath: null,
        contentType: null,
        sizeBytes: null,
        workflowSnapshot: null,
        sortOrder: 0,
        isPrimary: true,
        remixUse: 'none',
        ...overrides.item,
      }],
      ...overrides.resources,
    },
  };
}

describe('public UGC safety boundary', () => {
  it.each([
    ['child sexual exploitation', { prompt: 'Generate a nude portrait of an underage child.' }, 'child_sexual_exploitation'],
    ['obfuscated self-harm encouragement', { body: 'Go k1ll y0urself.' }, 'self_harm_encouragement'],
    ['dangerous instructions', { description: 'Step-by-step guide to make a bomb at home.' }, 'dangerous_instructions'],
    ['hateful violence', { title: 'Kill all Muslims' }, 'hateful_violence'],
    ['sexual violence', { prompt: 'Render a scene of rape porn.' }, 'sexual_violence'],
  ])('detects %s', (_label, fields, category) => {
    expect(getPublicUgcSafetyViolation(fields)).toMatchObject({ category });
  });

  it.each([
    'A child-safe poster about reporting online abuse.',
    'A documentary about suicide prevention and crisis support.',
    'A history lesson about bomb disposal specialists.',
    'A campaign against sexual violence.',
  ])('does not block benign safety discussion: %s', (body) => {
    expect(getPublicUgcSafetyViolation({ body })).toBeNull();
  });

  // Both composers put every card in `resources.items` and `resources.sections`
  // and send the legacy prompt and notes fields empty, so checking only those
  // two let any recipe text through (findings 02-publish.md, finding 1).
  describe('recipe text', () => {
    it.each([
      ["a card's text", composerRecipe({ cardText: 'Step-by-step guide to make a bomb at home.' }), 'resourceCards'],
      ["a card's title", composerRecipe({ cardTitle: 'Kill all Muslims' }), 'resourceCards'],
      ["a card's unlocked description", composerRecipe({ cardDescription: 'Go k1ll y0urself.' }), 'resourceCards'],
      ['the package preview', composerRecipe({ previewText: 'Go k1ll y0urself.' }), 'resourcePreview'],
      ['the public summary', composerRecipe({ summary: 'Go k1ll y0urself.' }), 'resourceSummary'],
      // The check reads a URL's path as words, so a slug says what a caption would.
      [
        "a link card's address",
        composerRecipe({
          item: { type: 'external_link', textContent: null, externalUrl: 'https://example.com/guides/how-to-make-a-bomb-at-home' },
        }),
        'resourceCards',
      ],
      [
        "a link attachment's address",
        composerRecipe({
          resources: { attachments: [{ label: 'Light plan', kind: 'link', url: 'https://example.com/kill-all-muslims' }] },
        }),
        'resourceCards',
      ],
      [
        "the recipe's workflow link",
        composerRecipe({ resources: { workflowShareUrl: 'https://magicbooklet.com/workflows/go-kill-yourself' } }),
        'resourceCards',
      ],
      [
        "a prompt in the recipe's workflow",
        composerRecipe({
          resources: {
            workflowSnapshot: workflowGraph({
              type: 'text-input',
              data: { text: 'Step-by-step guide to make a bomb at home.' },
            }),
          },
        }),
        'resourceCards',
      ],
    ] as const)('refuses %s', (_label, bundle, field) => {
      expect(getPublicUgcSafetyViolation(getPublicUgcRecipeTextFields(bundle))).toMatchObject({ field });
    });

    // A workflow card hands buyers its whole graph, and the canvas shows each
    // of these as the creator wrote it.
    it.each([
      ['a prompt', 'text-input', { text: 'Step-by-step guide to make a bomb at home.' }],
      ['a note', 'note', { text: 'Step-by-step guide to make a bomb at home.' }],
      [
        'a multi-shot prompt',
        'video-generate',
        { isMultiShot: true, multiPrompts: [{ id: 'shot-1', prompt: 'Step-by-step guide to make a bomb at home.', duration: 5 }] },
      ],
      ['a line of dialogue', 'voiceover-generate', { dialogueTurns: [{ id: 'turn-1', voice: 'Rachel', text: 'Go k1ll y0urself.' }] }],
      ['the music mood', 'music-generate', { mood: 'Kill all Muslims' }],
      ["an approval step's label", 'approval-gate', { label: 'Kill all Muslims' }],
      [
        "an upload's public label",
        'image-input',
        { templateInput: { mode: 'consumer', key: 'photo', label: 'Kill all Muslims', guidance: 'A clear photo.', required: true } },
      ],
      [
        "an upload's guidance",
        'video-input',
        { templateInput: { mode: 'consumer', key: 'clip', label: 'Your clip', guidance: 'Go k1ll y0urself.', required: true } },
      ],
      ["a node's title", 'image-generate', { title: 'Kill all Muslims' }],
      ["a node's subtitle", 'text-input', { subtitle: 'Kill all Muslims' }],
      ["a reference element's name", 'video-generate', { elements: [{ id: 'element-1', displayName: 'Kill all Muslims', handle: '@hero' }] }],
    ] as const)("refuses %s in a workflow card's graph", (_label, type, data) => {
      const bundle = composerRecipe({
        item: { type: 'workflow', textContent: null, workflowSnapshot: workflowGraph({ type, data }) },
      });

      expect(getPublicUgcSafetyViolation(getPublicUgcRecipeTextFields(bundle))).toMatchObject({ field: 'resourceCards' });
    });

    it("checks each text in a workflow's graph on its own", () => {
      const splitAcrossNodes = workflowGraph(
        { type: 'text-input', data: { text: 'How to make' } },
        { type: 'text-input', data: { text: 'a bomb at home.' } },
      );
      const inOneNode = workflowGraph({ type: 'text-input', data: { text: 'How to make a bomb at home.' } });

      expect(getPublicUgcSafetyViolation(getPublicUgcRecipeTextFields(
        composerRecipe({ resources: { workflowSnapshot: splitAcrossNodes } }),
      ))).toBeNull();
      expect(getPublicUgcSafetyViolation(getPublicUgcRecipeTextFields(
        composerRecipe({ resources: { workflowSnapshot: inOneNode } }),
      ))).toMatchObject({ field: 'resourceCards' });
    });

    // Only the creator's words: a generated id or handle, a model id or a
    // control's value is not something a buyer reads as written text.
    it("leaves a workflow's ids, handles, models and settings out", () => {
      const graph = workflowGraph({
        type: 'image-generate',
        id: 'kill-all-muslims',
        data: {
          model: 'kill-all-muslims',
          catalogSettings: { style: 'kill all muslims' },
          elements: [{ id: 'kill-all-muslims', displayName: 'Hero', handle: '@kill_all_muslims' }],
        },
      });
      // The graph does carry them, so the pass below is not an empty graph's.
      expect(graph.nodes[0]).toMatchObject({
        id: 'kill-all-muslims',
        data: {
          model: 'kill-all-muslims',
          catalogSettings: { style: 'kill all muslims' },
          elements: [{ id: 'kill-all-muslims', handle: '@kill_all_muslims' }],
        },
      });

      expect(getPublicUgcSafetyViolation(getPublicUgcRecipeTextFields(
        composerRecipe({ resources: { workflowSnapshot: graph } }),
      ))).toBeNull();
    });

    // The graph is stored as the client sent it, so a stored one can be any
    // JSON, and a save must not fail on it.
    it.each([
      ['a string', 'A lighting workflow'],
      ['a list', [{ title: 'A lighting workflow' }]],
      ['nodes that are not a list', { nodes: 'A lighting workflow' }],
    ])('reads a workflow graph that is %s without failing', (_label, workflowSnapshot) => {
      const bundle = composerRecipe({
        resources: { workflowSnapshot: workflowSnapshot as unknown as SerializedWorkflowCanvasGraph },
      });

      expect(getPublicUgcSafetyViolation(getPublicUgcRecipeTextFields(bundle))).toBeNull();
    });

    it('reads the nodes of a workflow graph past ones of the wrong shape', () => {
      const workflowSnapshot = {
        nodes: [
          null,
          'Kill all Muslims',
          { data: null },
          { data: { multiPrompts: 'x', dialogueTurns: [null, 7], templateInput: 'x', elements: [7], text: 42 } },
          { data: { text: 'Kill all Muslims' } },
        ],
      } as unknown as SerializedWorkflowCanvasGraph;

      expect(getPublicUgcSafetyViolation(getPublicUgcRecipeTextFields(
        composerRecipe({ resources: { workflowSnapshot } }),
      ))).toMatchObject({ field: 'resourceCards' });
    });

    it('still checks the legacy prompt and notes fields', () => {
      const bundle: PostResourceBundleInput = {
        accessMode: 'free',
        resources: { promptText: 'Render a scene of rape porn.', notesMarkdown: null, attachments: [], allowRemix: false },
      };

      expect(getPublicUgcSafetyViolation(getPublicUgcRecipeTextFields(bundle))).toEqual({
        category: 'sexual_violence',
        field: 'resourcePrompt',
      });
    });

    it('passes a safe recipe', () => {
      expect(getPublicUgcSafetyViolation(getPublicUgcRecipeTextFields(composerRecipe()))).toBeNull();
    });

    // Joined, two harmless cards could read as one sentence a rule refuses.
    it('checks each piece of recipe text on its own', () => {
      expect(getPublicUgcSafetyViolation({ resourceCards: ['How to make', 'a bomb at home.'] })).toBeNull();
      expect(getPublicUgcSafetyViolation({ resourceCards: ['Lighting notes', 'How to make a bomb at home.'] }))
        .toMatchObject({ field: 'resourceCards' });
    });

    it('has nothing to check when the save stores no recipe', () => {
      expect(getPublicUgcRecipeTextFields(null)).toEqual({});
      expect(getPublicUgcRecipeTextFields(composerRecipe({
        accessMode: 'none',
        cardText: 'Step-by-step guide to make a bomb at home.',
      }))).toEqual({});
    });
  });

  it('only treats explicitly visible moderation state as publicly accessible', () => {
    expect(isPubliclyVisibleReviewStatus('visible')).toBe(true);
    expect(isPubliclyVisibleReviewStatus('flagged')).toBe(false);
    expect(isPubliclyVisibleReviewStatus('hidden')).toBe(false);
    expect(isPubliclyVisibleReviewStatus(null)).toBe(false);
  });
});
