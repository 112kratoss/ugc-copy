import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '..');

function readProjectFile(path: string) {
  return readFileSync(resolve(projectRoot, path), 'utf8');
}

describe('mobile startup performance contracts', () => {
  it('does not initialize RevenueCat from the global auth provider', () => {
    const authSource = readProjectFile('lib/auth.tsx');
    const pricingSource = readProjectFile('app/(tabs)/pricing.tsx');

    expect(authSource).not.toContain('configureIapForUser');
    expect(pricingSource).toContain('configureIapForUser');
  });
});
