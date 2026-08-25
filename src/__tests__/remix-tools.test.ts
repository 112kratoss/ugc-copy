import { describe, expect, it } from 'vitest';

import { resolvePostRemixCapability } from '@/lib/post-resource-bundles';
import {
  remixCreatePathForCategory,
  remixToolCreatePath,
  resolveRemixTool,
  type RemixTool,
} from '@/lib/remix-tools';

const MEDIA_CATEGORIES = ['image', 'video', 'motion', 'ugc-ad', 'audio', 'something-new', null] as const;

describe('remix tool resolution', () => {
  it.each([
    ['image', 'image', '/create-image'],
    ['video', 'video', '/create-video'],
    ['motion', 'motion', '/create-motion'],
    // Legacy category whose generations are videos — this was the live
    // disagreement between the advertised target and the redirect.
    ['ugc-ad', 'video', '/create-video'],
    ['audio', 'image', '/create-image'],
    ['something-new', 'image', '/create-image'],
    [null, 'image', '/create-image'],
  ] as Array<[string | null, RemixTool, string]>)(
    'routes %s to the %s tool at %s',
    (category, tool, path) => {
      expect(resolveRemixTool(category)).toBe(tool);
      expect(remixCreatePathForCategory(category)).toBe(path);
    }
  );

  it.each(MEDIA_CATEGORIES)(
    'advertises the same tool for %s that the remix redirect lands in',
    (category) => {
      const { target } = resolvePostRemixCapability({
        category,
        generationId: 'gen-1',
        postFormat: 'media',
        sourceKind: 'magicbooklet',
      });

      // The invariant this module exists to hold. A post that says "remix as
      // video" must not redirect into the image tool, and vice versa.
      expect(target).not.toBeNull();
      expect(remixToolCreatePath(target as RemixTool)).toBe(remixCreatePathForCategory(category));
    }
  );
});
