import { describe, expect, it, vi } from 'vitest';

import { retainPurchasedUnlockFiles } from '@/lib/account-deletion-resource-retention';

const CREATOR_ID = '11111111-1111-4111-8111-111111111111';
const REVISION_ID = '22222222-2222-4222-8222-222222222222';

function createAdmin(options: {
  copyError?: unknown;
  destinationExists?: boolean;
  revisionOverrides?: Record<string, unknown>;
  inputRows?: Array<Record<string, unknown>>;
} = {}) {
  const mappings: Array<Record<string, unknown>> = [];
  const supplements: Array<Record<string, unknown>> = [];
  const copies: Array<{ bucket: string; source: string; destination: string; destinationBucket?: string }> = [];

  const tableData: Record<string, unknown[]> = {
    post_resource_bundle_revision_supplements: [],
    generation_input_media: options.inputRows ?? [{
      id: 'input-1',
      generation_id: 'generation-1',
      media_type: 'image',
      role: 'reference_image',
      label: 'Legacy reference',
      storage_path: `generation_inputs/${CREATOR_ID}/generation-1/reference.png`,
      sort_order: 0,
      metadata: {},
    }],
    post_resource_bundle_revision_files: [],
  };

  const from = vi.fn((table: string) => {
    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      in: vi.fn(() => builder),
      upsert: vi.fn(async (value: Record<string, unknown>) => {
        if (table === 'post_resource_bundle_revision_supplements') supplements.push(value);
        if (table === 'post_resource_bundle_revision_files') mappings.push(value);
        return { data: value, error: null };
      }),
      then: (onFulfilled: (value: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: tableData[table] ?? [], error: null }).then(onFulfilled),
    };
    return builder;
  });

  const storage = {
    from: (bucket: string) => ({
      copy: vi.fn(async (source: string, destination: string, copyOptions?: { destinationBucket?: string }) => {
        copies.push({ bucket, source, destination, destinationBucket: copyOptions?.destinationBucket });
        return { data: null, error: options.copyError ?? null };
      }),
      info: vi.fn(async () => ({
        data: options.destinationExists ? { id: 'existing' } : null,
        error: options.destinationExists ? null : { status: 404 },
      })),
    }),
  };

  const admin = {
    rpc: vi.fn(async () => ({
      data: [{
        revision_id: REVISION_ID,
        bundle_id: 'bundle-1',
        post_id: 'post-1',
        generation_id: 'generation-1',
        allow_remix: true,
        attachments: [{ kind: 'file', storagePath: `${CREATOR_ID}/guide.pdf` }],
        resource_items: [{ storagePath: `uploads/${CREATOR_ID}/source.psd` }],
        ...options.revisionOverrides,
      }],
      error: null,
    })),
    from,
    storage,
  };

  return { admin, copies, mappings, supplements };
}

describe('purchased unlock file retention', () => {
  it('copies same-bucket, uploads, and legacy generation references before recording mappings', async () => {
    const { admin, copies, mappings, supplements } = createAdmin();

    await expect(retainPurchasedUnlockFiles(admin as never, CREATOR_ID)).resolves.toEqual({
      revisionsRetained: 1,
      filesRetained: 3,
    });

    expect(supplements).toHaveLength(1);
    expect(copies.map((copy) => copy.bucket)).toEqual(expect.arrayContaining([
      'post_resource_files',
      'uploads',
      'generation_inputs',
    ]));
    expect(copies.every((copy) => copy.destination.startsWith(`retained/${REVISION_ID}/`))).toBe(true);
    expect(copies.every((copy) => copy.destinationBucket === 'post_resource_files')).toBe(true);
    expect(mappings).toHaveLength(3);
  });

  // 2026-11-03 re-review. S sells with allow-remix off; B buys, remixes, and their run imports S's copy.
  // B sells that creation with allow-remix on; its only input is S's file. C buys it. B deletes their
  // account: retention kept every input row of B's for C, S's file among them, signed for good.
  it('keeps no input that was a file of someone else’s recipe for the buyers of a deleted creator', async () => {
    const recipeFile = (id: string, sortOrder: number, metadata: Record<string, unknown>) => ({
      id,
      generation_id: 'generation-1',
      media_type: 'image',
      role: 'reference_image',
      label: `Bought ${id}`,
      storage_path: `generation_inputs/${CREATOR_ID}/generation-1/0${sortOrder}-reference_image.png`,
      sort_order: sortOrder,
      metadata,
    });
    const { admin, copies, supplements } = createAdmin({
      revisionOverrides: { attachments: [], resource_items: [] },
      inputRows: [
        recipeFile('input-marked', 0, { sourceKind: 'recipe-file', recipeFile: 'post_resource_files/seller-9/generation-references/gen-0/00-reference-image-row.png' }),
        recipeFile('input-seller-copy', 1, { sourceStoragePath: 'post_resource_files/seller-9/generation-references/gen-0/01-reference-image-row.png' }),
        recipeFile('input-imported', 2, { sourceUrl: 'https://project.supabase.co/storage/v1/object/sign/generation_inputs/11111111-1111-4111-8111-111111111111/recipe-imports/seller-9/gen-0/02-reference-image-row.png?token=x' }),
      ],
    });

    await expect(retainPurchasedUnlockFiles(admin as never, CREATOR_ID)).resolves.toEqual({ revisionsRetained: 1, filesRetained: 0 });
    expect(supplements).toEqual([]);
    expect(copies).toEqual([]);
  });

  it('keeps the deleted creator’s own inputs beside a recipe file', async () => {
    const { admin, copies, supplements } = createAdmin({
      revisionOverrides: { attachments: [], resource_items: [] },
      inputRows: [
        { id: 'input-own', generation_id: 'generation-1', media_type: 'image', role: 'reference_image', label: 'Own', storage_path: `generation_inputs/${CREATOR_ID}/generation-1/00.png`, sort_order: 0, metadata: { sourceStoragePath: `uploads/${CREATOR_ID}/face.png` } },
        { id: 'input-bought', generation_id: 'generation-1', media_type: 'image', role: 'reference_image', label: 'Bought', storage_path: `generation_inputs/${CREATOR_ID}/generation-1/01.png`, sort_order: 1, metadata: { sourceKind: 'recipe-file' } },
      ],
    });

    await expect(retainPurchasedUnlockFiles(admin as never, CREATOR_ID)).resolves.toMatchObject({ filesRetained: 1 });
    expect((supplements[0]?.resource_items as Array<{ storagePath: string }>).map((item) => item.storagePath))
      .toEqual([`generation_inputs/${CREATOR_ID}/generation-1/00.png`]);
    expect(copies.map((copy) => copy.source)).toEqual([`${CREATOR_ID}/generation-1/00.png`]);
  });

  it('accepts an existing deterministic destination as an idempotent copy success', async () => {
    const { admin, mappings } = createAdmin({ copyError: { status: 409 }, destinationExists: true });

    await expect(retainPurchasedUnlockFiles(admin as never, CREATOR_ID)).resolves.toMatchObject({
      filesRetained: 3,
    });
    expect(mappings).toHaveLength(3);
  });

  it('fails closed and records no mapping when neither copy nor destination exists', async () => {
    const { admin, mappings } = createAdmin({ copyError: { status: 404 }, destinationExists: false });

    await expect(retainPurchasedUnlockFiles(admin as never, CREATOR_ID)).rejects.toThrow(
      'Could not retain purchased resource',
    );
    expect(mappings).toHaveLength(0);
  });

  it('rejects a persisted owner-changing or encoded source before service-role copy', async () => {
    for (const storagePath of [
      `uploads/${CREATOR_ID}/../another-user/private.psd`,
      `uploads/${CREATOR_ID}/%252fanother-user/private.psd`,
      'uploads/another-user/private.psd',
      ` uploads/${CREATOR_ID}/private.psd`,
    ]) {
      const { admin, copies, mappings } = createAdmin({
        revisionOverrides: {
          generation_id: null,
          allow_remix: false,
          attachments: [],
          resource_items: [{ storagePath }],
        },
      });

      await expect(retainPurchasedUnlockFiles(admin as never, CREATOR_ID)).rejects.toThrow(
        'invalid storage path',
      );
      expect(copies).toEqual([]);
      expect(mappings).toEqual([]);
    }
  });
});
