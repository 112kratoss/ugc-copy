import { describe, expect, it } from 'vitest';

import { resolveWebNotificationPath } from '@/lib/web-notification-links';

describe('resolveWebNotificationPath', () => {
  it('maps generation viewer links to the web studio', () => {
    expect(resolveWebNotificationPath('/viewer?source=studio-creations&initialId=gen-1'))
      .toBe('/creations');
  });

  it('maps showcase viewer links to the post detail route', () => {
    expect(resolveWebNotificationPath('/viewer?source=showcase-feed&initialId=post-1'))
      .toBe('/showcase/post-1');
  });

  it('maps the mobile studio route to the web studio', () => {
    expect(resolveWebNotificationPath('/studio')).toBe('/creations');
  });

  it('preserves valid web routes', () => {
    expect(resolveWebNotificationPath('/marketplace/asset-1')).toBe('/marketplace/asset-1');
    expect(resolveWebNotificationPath('/creators/athul?tab=posts')).toBe('/creators/athul?tab=posts');
  });

  it('rejects missing or unsafe links', () => {
    expect(resolveWebNotificationPath(null)).toBeNull();
    expect(resolveWebNotificationPath('https://example.com/account')).toBeNull();
  });
});
