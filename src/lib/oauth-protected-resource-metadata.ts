import { NextResponse } from 'next/server';

import { MCP_DEVELOPERS_PAGE_PATH, MCP_POSTS_PAGE_PATH } from '@/lib/mcp-client-directory';
import { MCP_SURFACE_ROUTE_PATHS, type McpSurface } from '@/lib/mcp-surfaces';

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728) for the MCP server.
 *
 * An MCP client that is answered 401 reads the `resource_metadata` URL from the
 * `WWW-Authenticate` header (`mcp-route-adapter-service.ts`), fetches this document, and takes
 * the authorization server from it: Supabase Auth's OAuth 2.1 server, whose issuer is the
 * project's `/auth/v1`. The same document is served at the path-aware well-known URL for the
 * MCP route and at the origin's root well-known URL, because clients differ in which one they
 * try first, and both name the MCP route as the resource.
 *
 * The posting-only server (`mcp-surfaces.ts`) is a resource of its own: Claude takes a document
 * only when its `resource` equals the URL the person connected, path included, so
 * `/api/mcp/posts` has its own path-aware document, which its 401 names. The root document
 * stays the full server's.
 */

export const OAUTH_PROTECTED_RESOURCE_WELL_KNOWN_PATH = '/.well-known/oauth-protected-resource';

export type OAuthProtectedResourceMetadata = {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: ['header'];
  resource_name: string;
  /** The setup page on the same origin (`/developers/mcp`), for a person reading the document. */
  resource_documentation: string;
};

export type OAuthProtectedResourceEnvironment = {
  siteUrl?: string;
  supabaseUrl?: string;
  /** Which server the document describes; the full one unless said. */
  surface?: McpSurface;
};

const RESOURCE_NAMES: Readonly<Record<McpSurface, string>> = {
  full: 'Magicbooklet MCP server',
  posts: 'Magicbooklet posting server',
};

const RESOURCE_DOCUMENTATION_PATHS: Readonly<Record<McpSurface, string>> = {
  full: MCP_DEVELOPERS_PAGE_PATH,
  posts: MCP_POSTS_PAGE_PATH,
};

function origin(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** The site's origin, from `NEXT_PUBLIC_SITE_URL` unless another value is given. */
export function resolveMcpSiteOrigin(siteUrl = process.env.NEXT_PUBLIC_SITE_URL): string | null {
  return origin(siteUrl);
}

/** A server's resource identifier: the site's origin plus its route path. */
export function mcpResourceUrl(siteOrigin: string, surface: McpSurface = 'full'): string {
  return `${siteOrigin}${MCP_SURFACE_ROUTE_PATHS[surface]}`;
}

/** Where a 401 sends a client for a server's document: its path-aware well-known URL. */
export function protectedResourceMetadataUrl(siteOrigin: string, surface: McpSurface = 'full'): string {
  return `${siteOrigin}${OAUTH_PROTECTED_RESOURCE_WELL_KNOWN_PATH}${MCP_SURFACE_ROUTE_PATHS[surface]}`;
}

/**
 * The document, or null when the site URL or the Supabase URL is not configured (a checkout
 * with neither set cannot name an authorization server, and must not invent one).
 */
export function buildOAuthProtectedResourceMetadata({
  siteUrl = process.env.NEXT_PUBLIC_SITE_URL,
  supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL,
  surface = 'full',
}: OAuthProtectedResourceEnvironment = {}): OAuthProtectedResourceMetadata | null {
  const siteOrigin = origin(siteUrl);
  const supabaseOrigin = origin(supabaseUrl);
  if (!siteOrigin || !supabaseOrigin) return null;
  return {
    resource: mcpResourceUrl(siteOrigin, surface),
    // Supabase Auth's OAuth server issuer. Its RFC 8414 metadata is served under the issuer
    // path, which the client resolves from this value.
    authorization_servers: [`${supabaseOrigin}/auth/v1`],
    bearer_methods_supported: ['header'],
    resource_name: RESOURCE_NAMES[surface],
    resource_documentation: `${siteOrigin}${RESOURCE_DOCUMENTATION_PATHS[surface]}`,
  };
}

/** Public and cacheable: the document holds no secret and changes only with a deploy. */
const METADATA_CACHE_CONTROL = 'public, max-age=3600, s-maxage=86400';

/**
 * Browser-based MCP clients read the document cross-origin, so it is served to any origin.
 * `Authorization` is allowed only because some clients send their preflight with it; the
 * document itself needs no token.
 */
export function protectedResourceCorsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version',
    'Access-Control-Max-Age': '86400',
  };
}

export function createProtectedResourceMetadataResponse(
  environment: OAuthProtectedResourceEnvironment = {},
): NextResponse {
  const metadata = buildOAuthProtectedResourceMetadata(environment);
  if (!metadata) {
    return NextResponse.json(
      { error: 'The MCP server is not configured on this deployment.', code: 'MCP_NOT_CONFIGURED' },
      { status: 404, headers: { ...protectedResourceCorsHeaders(), 'Cache-Control': 'no-store' } },
    );
  }
  return NextResponse.json(metadata, {
    headers: {
      ...protectedResourceCorsHeaders(),
      'Cache-Control': METADATA_CACHE_CONTROL,
      'Content-Type': 'application/json',
    },
  });
}

export function createProtectedResourceMetadataOptionsResponse(): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: { ...protectedResourceCorsHeaders(), 'Cache-Control': METADATA_CACHE_CONTROL },
  });
}
