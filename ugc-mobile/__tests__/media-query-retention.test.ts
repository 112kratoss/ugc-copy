import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { pruneInactiveMediaQueries, installMediaQueryRetention } from '../lib/media-query-retention';
const rows = (count: number) => ({ pages: [{ items: Array.from({ length: count }, (_, i) => ({ id: String(i) })) }], pageParams: [0] });
describe('media query retention', () => {
  it('bounds old filter/viewer snapshots without changing observed feed data or page parameters', () => {
    const client = new QueryClient();
    const key = ['showcase-feed', 'active'];
    const active = rows(1000);
    client.setQueryData(key, active);
    const observer = new QueryObserver(client, { queryKey: key, enabled: false });
    const unsubscribe = observer.subscribe(() => {});
    for (let i = 0; i < 20; i++) client.setQueryData(['immersive-preview-source', i], { showcaseItems: rows(60).pages[0].items }, { updatedAt: i + 1 });
    client.setQueryData(['profile', 'u'], { credits: 25 });
    pruneInactiveMediaQueries(client);
    expect(client.getQueryData(key)).toBe(active);
    expect(client.getQueryCache().findAll({ queryKey: ['immersive-preview-source'] })).toHaveLength(4);
    expect(client.getQueryData(['profile', 'u'])).toEqual({ credits: 25 });
    unsubscribe(); client.clear();
  });
  it('evicts an oversized unobserved library and retains observed viewer content under memory pressure', () => {
    const client = new QueryClient();
    client.setQueryData(['profile-owner-posts','u'], { pages: [{ posts: rows(500).pages[0].items }], pageParams: [0] });
    const key = ['immersive-preview-source', 'visible'];
    client.setQueryData(key, { showcaseItems: rows(1).pages[0].items });
    const observer = new QueryObserver(client, { queryKey: key, enabled: false });
    const unsubscribe = observer.subscribe(() => {});
    pruneInactiveMediaQueries(client, true);
    expect(client.getQueryData(['profile-owner-posts','u'])).toBeUndefined();
    expect(client.getQueryData(key)).toBeDefined();
    unsubscribe(); client.clear();
  });
  it('coalesces cache events and disposes cleanly', async () => {
    const client = new QueryClient();
    const dispose = installMediaQueryRetention(client);
    for(let i=0;i<30;i++) client.setQueryData(['showcase-post',i], { item: { id: i } });
    await Promise.resolve();
    expect(client.getQueryCache().getAll()).toHaveLength(6);
    dispose(); client.clear();
  });
});
