import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { IMAGE_MODELS, MOTION_MODELS, VIDEO_MODELS } from '../lib/client-generation-models';
import { getPostModelDisplayName } from '../lib/post-feed-presentation';

// The app names a model from its own list (`ugc-mobile/lib/model-display-names.ts`)
// on feed cards, in Details and in the composer's Made with, and publishing
// stores the name `getPostModelDisplayName` gives. The app's tables once held
// only its first creators' models, so 16 newer ones went unnamed there. Read as
// text: this suite cannot load an app module (the web workspace never installs
// the app's dependencies, and the app's tsconfig extends Expo's).
function appModelNames() {
  const source = readFileSync(path.join(process.cwd(), 'ugc-mobile/lib/model-display-names.ts'), 'utf8');
  return Object.fromEntries(
    [...source.matchAll(/^ {2}'([^']+)': '([^']+)',$/gm)].map(([, id, name]) => [id, name]),
  );
}

describe('the app’s model names', () => {
  it('name every model the web’s catalog names, as it names them', () => {
    const webNames = Object.fromEntries(
      [...Object.values(IMAGE_MODELS), ...Object.values(VIDEO_MODELS), ...Object.values(MOTION_MODELS)]
        .map((model) => [model.id, model.displayName]),
    );

    expect(appModelNames()).toEqual(webNames);
    for (const [id, name] of Object.entries(appModelNames())) {
      expect(getPostModelDisplayName(id), id).toBe(name);
    }
  });
});
