import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET as getRoot, OPTIONS as optionsRoot } from '@/app/.well-known/oauth-protected-resource/route';
import { GET as getMcp, OPTIONS as optionsMcp } from '@/app/.well-known/oauth-protected-resource/api/mcp/route';
import { GET as getPosts, OPTIONS as optionsPosts } from '@/app/.well-known/oauth-protected-resource/api/mcp/posts/route';
import {
  buildOAuthProtectedResourceMetadata,
  createProtectedResourceMetadataResponse,
  mcpResourceUrl,
  protectedResourceMetadataUrl,
  resolveMcpSiteOrigin,
} from '@/lib/oauth-protected-resource-metadata';

describe('OAuth protected resource metadata (RFC 9728)', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://magicbooklet.com/');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://abcdefgh.supabase.co');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('names the MCP route as the resource, Supabase Auth as its authorization server, and the setup page', () => {
    expect(buildOAuthProtectedResourceMetadata()).toEqual({
      resource: 'https://magicbooklet.com/api/mcp',
      authorization_servers: ['https://abcdefgh.supabase.co/auth/v1'],
      bearer_methods_supported: ['header'],
      resource_name: 'Magicbooklet MCP server',
      resource_documentation: 'https://magicbooklet.com/developers/mcp',
    });
  });

  it('describes the posting-only server as a resource of its own, at its own path-aware URL', async () => {
    // Claude takes a document only when its resource equals the URL the person connected, path included.
    expect(buildOAuthProtectedResourceMetadata({ surface: 'posts' })).toEqual({
      resource: 'https://magicbooklet.com/api/mcp/posts',
      authorization_servers: ['https://abcdefgh.supabase.co/auth/v1'],
      bearer_methods_supported: ['header'],
      resource_name: 'Magicbooklet posting server',
      resource_documentation: 'https://magicbooklet.com/developers/mcp/posting',
    });
    expect(mcpResourceUrl('https://magicbooklet.com', 'posts')).toBe('https://magicbooklet.com/api/mcp/posts');
    expect(protectedResourceMetadataUrl('https://magicbooklet.com', 'posts'))
      .toBe('https://magicbooklet.com/.well-known/oauth-protected-resource/api/mcp/posts');

    const response = getPosts();
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect((await response.json()).resource).toBe('https://magicbooklet.com/api/mcp/posts');
    expect(optionsPosts().status).toBe(204);
    // The root document and the full server's stay the full server's.
    expect((await getRoot().json()).resource).toBe('https://magicbooklet.com/api/mcp');
    expect((await getMcp().json()).resource).toBe('https://magicbooklet.com/api/mcp');
  });

  it('links the documentation on the origin it serves, as it does the resource', () => {
    expect(buildOAuthProtectedResourceMetadata({
      siteUrl: 'http://127.0.0.1:3100',
      supabaseUrl: 'https://example.supabase.co',
    })?.resource_documentation).toBe('http://127.0.0.1:3100/developers/mcp');
  });

  it('builds from the values given, and from nothing when either URL is missing or malformed', () => {
    expect(buildOAuthProtectedResourceMetadata({
      siteUrl: 'http://127.0.0.1:3100',
      supabaseUrl: 'https://example.supabase.co/',
    })).toMatchObject({
      resource: 'http://127.0.0.1:3100/api/mcp',
      authorization_servers: ['https://example.supabase.co/auth/v1'],
    });
    expect(buildOAuthProtectedResourceMetadata({ siteUrl: '', supabaseUrl: 'https://x.supabase.co' })).toBeNull();
    expect(buildOAuthProtectedResourceMetadata({ siteUrl: 'https://magicbooklet.com', supabaseUrl: 'not a url' })).toBeNull();
    expect(buildOAuthProtectedResourceMetadata({ siteUrl: 'ftp://magicbooklet.com', supabaseUrl: 'https://x.supabase.co' })).toBeNull();
  });

  it('derives the challenge URL and the resource from the site origin alone', () => {
    expect(resolveMcpSiteOrigin()).toBe('https://magicbooklet.com');
    expect(resolveMcpSiteOrigin('nonsense')).toBeNull();
    expect(mcpResourceUrl('https://magicbooklet.com')).toBe('https://magicbooklet.com/api/mcp');
    expect(protectedResourceMetadataUrl('https://magicbooklet.com'))
      .toBe('https://magicbooklet.com/.well-known/oauth-protected-resource/api/mcp');
  });

  it('serves the same cacheable, cross-origin document at the root and the path-aware well-known URLs', async () => {
    for (const handler of [getRoot, getMcp]) {
      const response = handler();
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(response.headers.get('cache-control')).toBe('public, max-age=3600, s-maxage=86400');
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
      await expect(response.json()).resolves.toEqual(buildOAuthProtectedResourceMetadata());
    }
    for (const handler of [optionsRoot, optionsMcp]) {
      const response = handler();
      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('access-control-allow-headers')).toContain('Authorization');
    }
  });

  it('answers 404 and nothing cacheable when the deployment is not configured for it', async () => {
    const response = createProtectedResourceMetadataResponse({ siteUrl: '', supabaseUrl: '' });
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toMatchObject({ code: 'MCP_NOT_CONFIGURED' });
  });
});
