import { describe, expect, it } from 'vitest';

import { resolveCreditEntitlement } from '../lib/iap-entitlements';

describe('IAP entitlement mapping', () => {
  it('maps native credit products to credit grants', () => {
    expect(resolveCreditEntitlement('magicbooklet.credits.creator')).toEqual({
      type: 'credits',
      productId: 'magicbooklet.credits.creator',
      credits: 2000,
    });
  });

  it('rejects unknown products', () => {
    expect(resolveCreditEntitlement('magicbooklet.credits.unknown')).toBeNull();
  });
});
