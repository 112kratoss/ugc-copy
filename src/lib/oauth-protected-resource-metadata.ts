import { NextResponse } from 'next/server';

import { MCP_ROUTE_PATH } from '@/lib/agent-token';
import { MCP_DEVELOPERS_PAGE_PATH } from '@/lib/mcp-client-directory';

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728) for the MCP server.
 *
 * An MCP client that is answered 401 reads the `resource_metadata` URL from the
 * `WWW-Authenticate` header (`mcp-route-adapter-service.ts`), fetches this document, and takes
 * the authorization server from it: Supabase Auth's OAuth 2.1 server, whose issuer is the
 * project's `/auth/v1`. The same document is served at the path-aware well-known URL for the
 * MCP route and at the origin's root well-known URL, because clients differ in which one they
 * try first, and both name the MCP route as the resource.
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

/** The MCP server's resource identifier: the site's origin plus the route path. */
export function mcpResourceUrl(siteOrigin: string): string {
  return `${siteOrigin}${MCP_ROUTE_PATH}`;
}

/** Where a 401 sends a client for this document: the path-aware well-known URL. */
export function protectedResourceMetadataUrl(siteOrigin: string): string {
  return `${siteOrigin}${OAUTH_PROTECTED_RESOURCE_WELL_KNOWN_PATH}${MCP_ROUTE_PATH}`;
}

/**
 * The document, or null when the site URL or the Supabase URL is not configured (a checkout
 * with neither set cannot name an authorization server, and must not invent one).
 */
export function buildOAuthProtectedResourceMetadata({
  siteUrl = process.env.NEXT_PUBLIC_SITE_URL,
  supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL,
}: OAuthProtectedResourceEnvironment = {}): OAuthProtectedResourceMetadata | null {
  const siteOrigin = origin(siteUrl);
  const supabaseOrigin = origin(supabaseUrl);
  if (!siteOrigin || !supabaseOrigin) return null;
  return {
    resource: mcpResourceUrl(siteOrigin),
    // Supabase Auth's OAuth server issuer. Its RFC 8414 metadata is served under the issuer
    // path, which the client resolves from this value.
    authorization_servers: [`${supabaseOrigin}/auth/v1`],
    bearer_methods_supported: ['header'],
    resource_name: 'Magicbooklet MCP server',
    resource_documentation: `${siteOrigin}${MCP_DEVELOPERS_PAGE_PATH}`,
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
