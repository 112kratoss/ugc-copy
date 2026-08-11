import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import mobileApiOperationsV1 from '../../contracts/mobile-api-operations-v1.json';
import { ROUTE_IDENTITY_POLICY, routeIdentityPolicy } from '@/lib/route-identity-policy';

function listApiRoutes(dir: string, base = ''): string[] {
  const routes: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const next = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      routes.push(...listApiRoutes(next, `${base}/${entry.name}`));
    } else if (entry.name === 'route.ts') {
      routes.push(`/api${base}`);
    }
  }
  return routes;
}

const routes = listApiRoutes(path.resolve(process.cwd(), 'src/app/api')).sort();

describe('route identity policy', () => {
  it('finds the API surface it is meant to be covering', () => {
    // A guard on the guard: if the traversal ever silently returns nothing, the
    // exhaustiveness test below would pass vacuously.
    expect(routes.length).toBeGreaterThan(100);
    expect(routes).toContain('/api/mobile/commerce/sync');
  });

  it('requires every route to declare who may call it', () => {
    // The whole point. Before anonymous sessions existed, "has a JWT" and "is
    // registered" were the same thing, so no route ever had to choose. They are
    // now different, and a route that does not choose defaults to admitting
    // guests — silently, with no test failure. This makes that impossible to
    // merge: a new endpoint fails here until someone answers the question.
    const undeclared = routes.filter((route) => routeIdentityPolicy(route) === null);

    expect(undeclared).toEqual([]);
  });

  it('does not declare policies for routes that no longer exist', () => {
    // Stale entries are worse than missing ones: they make the registry look
    // like it covers something it does not.
    const known = new Set(routes);
    const orphaned = Object.keys(ROUTE_IDENTITY_POLICY).filter((route) => !known.has(route));

    expect(orphaned).toEqual([]);
  });

  it('keeps commerce and every creation tool reachable by guests', () => {
    // These are the routes App Review 5.1.1(v) is about. If any of them ever
    // becomes registered-only, the rejection comes straight back.
    for (const route of [
      '/api/mobile/commerce/sync',
      '/api/mobile/commerce/restore',
      '/api/account/merge/prepare',
      '/api/generate',
      '/api/generate-image',
      '/api/generate-video',
      '/api/enhance-prompt',
      '/api/generations',
      '/api/uploads/media/sign',
    ]) {
      expect(routeIdentityPolicy(route)).toBe('guest');
    }
  });

  it('keeps community, marketplace and payout surfaces registered-only', () => {
    // The other half of the guideline: registration may be required for
    // account-specific functionality. Letting a guest reach these would be a
    // much larger behavioural change than App Review asked for.
    for (const route of [
      '/api/posts',
      '/api/showcase/publish',
      '/api/showcase/posts/[postId]/comments',
      '/api/profile/follow',
      '/api/marketplace/order',
      '/api/creator/payouts',
      '/api/credits/welcome/claim',
      '/api/mobile/notifications/register',
    ]) {
      expect(routeIdentityPolicy(route)).toBe('registered');
    }
  });

  it('covers every route the mobile app actually calls', () => {
    // The contract drives CORS and version gating at runtime; this registry
    // drives admission. They are different questions — the contract's `required`
    // means "the client sends a token", which is true even for routes that read
    // fine signed out — so this does not compare the two verdicts. What it does
    // catch is drift: a mobile-facing route this registry has never heard of.
    //
    // Params are compared structurally because the two files name them
    // differently: the contract says `:runId` where the filesystem says `[id]`.
    const shape = (route: string) =>
      route.replace(/:([A-Za-z0-9_]+)/g, '[]').replace(/\[[A-Za-z0-9_]+\]/g, '[]');

    const declared = new Set(Object.keys(ROUTE_IDENTITY_POLICY).map(shape));
    const operations = Object.values(mobileApiOperationsV1.operations) as Array<{
      path: string;
      auth: string;
    }>;

    const unknown = operations
      .map((operation) => operation.path)
      .filter((route) => !declared.has(shape(route)));

    expect(unknown).toEqual([]);
  });
});
