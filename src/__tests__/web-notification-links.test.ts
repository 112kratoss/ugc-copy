import { describe, expect, it } from 'vitest';

import { resolveWebNotificationPath } from '@/lib/web-notification-links';

describe('resolveWebNotificationPath', () => {
  it('maps generation viewer links to the web studio', () => {
    expect(resolveWebNotificationPath('/viewer?source=studio-creations&initialId=gen-1'))
      .toBe('/creations?generation=gen-1');
  });

  it('maps showcase viewer links to the post detail route', () => {
    expect(resolveWebNotificationPath('/viewer?source=showcase-feed&initialId=post-1'))
      .toBe('/showcase/post-1');
  });

  it('keeps a bare Alerts-tab link on the Alerts page, as the app does', () => {
    // "New follower" alerts link to /studio, the app's Alerts tab; opening
    // the Creations library for a follow made no sense.
    expect(resolveWebNotificationPath('/studio')).toBeNull();
    expect(resolveWebNotificationPath('/studio?tab=alerts')).toBeNull();
  });

  it('maps a workflow run link to its canvas', () => {
    expect(resolveWebNotificationPath('/studio?workflowCanvas=canvas-1')).toBe('/create-workflow?canvas=canvas-1');
    expect(resolveWebNotificationPath('/studio?workflowCanvas=')).toBeNull();
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
