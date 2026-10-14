import { describe, expect, it } from 'vitest';

import { resolveWebNotificationPath } from '@/lib/web-notification-links';

describe('resolveWebNotificationPath', () => {
  it('maps generation viewer links to the web studio', () => {
    expect(resolveWebNotificationPath('/viewer?source=studio-creations&initialId=gen-1'))
      .toBe('/creations?generation=gen-1');
  });

  it('maps showcase viewer links to the post detail route', () => {
    // Post alerts written before they linked the post page directly.
    expect(resolveWebNotificationPath('/viewer?source=showcase-feed&initialId=post-1'))
      .toBe('/showcase/post-1');
  });

  it('opens a post alert on the post page as written', () => {
    // Saved, shared, remixed and recipe-unlocked alerts link /showcase/<id>.
    expect(resolveWebNotificationPath('/showcase/post-1')).toBe('/showcase/post-1');
    expect(resolveWebNotificationPath('/showcase/post%201')).toBe('/showcase/post%201');
  });

  it("opens the follower's page from a New follower alert", () => {
    expect(resolveWebNotificationPath('/creators/athul')).toBe('/creators/athul');
    expect(resolveWebNotificationPath('/creators/creator-1a2b3c4d')).toBe('/creators/creator-1a2b3c4d');
  });

  it('keeps a bare Alerts-tab link on the Alerts page, as the app does', () => {
    // A "New follower" alert with no handle to open, and every one written
    // before they named the follower, link to /studio, the app's Alerts tab;
    // opening the Creations library for a follow made no sense.
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
