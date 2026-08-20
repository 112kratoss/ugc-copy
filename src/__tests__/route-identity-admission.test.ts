import fs from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

import { guardUserFacingRouteIdentity, proxy } from '@/proxy';
import { routeIdentityPolicyForPathname } from '@/lib/route-identity-policy';

function identityClient(options: {
  anonymous?: boolean;
  authError?: unknown;
  state?: unknown;
  stateError?: unknown;
} = {}) {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: {
          user: options.authError
            ? null
            : { id: 'identity-1', is_anonymous: options.anonymous ?? false },
        },
        error: options.authError ?? null,
      })),
    },
    rpc: vi.fn(async () => ({
      data: options.state ?? 'active',
      error: options.stateError ?? null,
    })),
  };
}

function authenticatedRequest(pathname: string) {
  return new NextRequest(`https://magicbooklet.test${pathname}`, {
    headers: { Authorization: 'Bearer signed-user-token' },
  });
}

describe('central route identity admission', () => {
  it('resolves concrete dynamic API paths through the identity registry', () => {
    expect(routeIdentityPolicyForPathname('/api/generations/abc/restore')).toBe('guest');
    expect(routeIdentityPolicyForPathname('/api/showcase/posts/post-1/comments')).toBe('registered');
    expect(routeIdentityPolicyForPathname('/api/webhooks/kie')).toBe('service');
  });

  it('rejects merged and deleting tokens before route adapters run', async () => {
    for (const [state, code] of [
      ['merged', 'SESSION_MERGED'],
      ['deleting', 'ACCOUNT_DELETING'],
    ] as const) {
      const response = await guardUserFacingRouteIdentity(
        authenticatedRequest('/api/generations'),
        { createUserClient: () => identityClient({ state }) },
      );

      expect(response?.status).toBe(409);
      await expect(response?.json()).resolves.toMatchObject({ code });
    }
  });

  it('gates an ordinary non-mobile web API request through the full proxy', async () => {
    const request = authenticatedRequest('/api/generations');
    expect(request.headers.has('x-magicbooklet-client')).toBe(false);

    const response = await proxy(request, {
      createUserClient: () => identityClient({ state: 'merged' }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'SESSION_MERGED' });
  });

  it('rejects stale bearer tokens on public event and preview endpoints', async () => {
    for (const pathname of [
      '/api/showcase/feed/events',
      '/api/showcase/preview?id=generation-1',
    ]) {
      const response = await proxy(authenticatedRequest(pathname), {
        createUserClient: () => identityClient({ state: 'merged' }),
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ code: 'SESSION_MERGED' });
    }
  });

  it('fails closed with 503 when durable state lookup fails or is missing', async () => {
    for (const client of [
      identityClient({ stateError: new Error('database unavailable') }),
      identityClient({ state: 'unknown' }),
    ]) {
      const response = await guardUserFacingRouteIdentity(
        authenticatedRequest('/api/workflow-canvases/canvas-1/run'),
        { createUserClient: () => client },
      );

      expect(response?.status).toBe(503);
      await expect(response?.json()).resolves.toMatchObject({
        code: 'IDENTITY_CHECK_UNAVAILABLE',
      });
    }
  });

  it('admits active guests only on guest-enabled routes', async () => {
    const guest = identityClient({ anonymous: true });
    await expect(guardUserFacingRouteIdentity(
      authenticatedRequest('/api/generate'),
      { createUserClient: () => guest },
    )).resolves.toBeNull();

    const response = await guardUserFacingRouteIdentity(
      authenticatedRequest('/api/showcase/publish'),
      { createUserClient: () => guest },
    );
    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toMatchObject({ code: 'REGISTRATION_REQUIRED' });
  });

  it('keeps tokenless public routes public and never gates service routes', async () => {
    const createUserClient = vi.fn();
    await expect(guardUserFacingRouteIdentity(
      new NextRequest('https://magicbooklet.test/api/showcase/feed'),
      { createUserClient },
    )).resolves.toBeNull();
    await expect(guardUserFacingRouteIdentity(
      authenticatedRequest('/api/cron/backend-jobs'),
      { createUserClient },
    )).resolves.toBeNull();
    expect(createUserClient).not.toHaveBeenCalled();
  });

  it('keeps raw auth.getUser inside the one audited server authentication boundary', () => {
    const apiRoot = path.resolve(process.cwd(), 'src/app/api');
    const sourceRoot = path.resolve(process.cwd(), 'src');
    const routeFiles: string[] = [];
    const visit = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(target);
        if (entry.isFile() && entry.name === 'route.ts') routeFiles.push(target);
      }
    };
    visit(apiRoot);

    const resolveLocalModule = (fromFile: string, specifier: string) => {
      const moduleBase = specifier.startsWith('@/')
        ? path.join(sourceRoot, specifier.slice(2))
        : specifier.startsWith('.')
          ? path.resolve(path.dirname(fromFile), specifier)
          : null;
      if (!moduleBase || !moduleBase.startsWith(`${sourceRoot}${path.sep}`)) return null;

      const candidates = [
        moduleBase,
        `${moduleBase}.ts`,
        `${moduleBase}.tsx`,
        path.join(moduleBase, 'index.ts'),
        path.join(moduleBase, 'index.tsx'),
      ];
      return candidates.find((candidate) => (
        /\.(?:ts|tsx)$/.test(candidate)
        && fs.existsSync(candidate)
        && fs.statSync(candidate).isFile()
      )) ?? null;
    };

    // Follow the local import graph from every actual route entry point. This
    // includes the route adapters/services where authentication normally lives,
    // without pretending a scan of route.ts wrappers alone proves anything.
    const reachableServerFiles = new Set(routeFiles);
    const queue = [...routeFiles];
    while (queue.length > 0) {
      const file = queue.pop();
      if (!file) continue;
      const source = fs.readFileSync(file, 'utf8');
      const specifiers = [
        ...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g),
        ...source.matchAll(/\bimport\s*(?:\(\s*)?['"]([^'"]+)['"]/g),
      ].map((match) => match[1]);

      for (const specifier of specifiers) {
        const importedFile = resolveLocalModule(file, specifier);
        if (!importedFile || reachableServerFiles.has(importedFile)) continue;
        reachableServerFiles.add(importedFile);
        queue.push(importedFile);
      }
    }

    const relativeReachableFiles = [...reachableServerFiles]
      .map((file) => path.relative(process.cwd(), file));
    expect(routeFiles.length).toBeGreaterThan(100);
    expect(relativeReachableFiles).toContain(
      'src/lib/generation-restore-media-route-adapter-service.ts',
    );
    expect(relativeReachableFiles).toContain('src/lib/account-identity.ts');

    const rawAuthBoundaries = [...reachableServerFiles]
      .filter((file) => /\bauth\s*\.\s*getUser\s*\(/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(process.cwd(), file))
      .sort();

    expect(rawAuthBoundaries).toEqual(['src/lib/server-auth-user.ts']);
  });
});
