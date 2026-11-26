import { NextResponse } from 'next/server';

import {
  AGENT_OAUTH_AUTHORIZE_PATH,
  AGENT_OAUTH_REVOKE_PATH,
  AGENT_OAUTH_SCOPE,
  AGENT_OAUTH_TOKEN_PATH,
} from '@/lib/agent-oauth-request';
import { MCP_DEVELOPERS_PAGE_PATH } from '@/lib/mcp-client-directory';
import { protectedResourceCorsHeaders, resolveMcpSiteOrigin } from '@/lib/oauth-protected-resource-metadata';

/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414) for the app's own authorization server
 * (`docs/archive/agent-token-broker-plan-2026-11-26.md`).
 *
 * The issuer is the site's origin, so the document is at the origin's root well-known URL, where
 * an MCP client looks after reading `authorization_servers` from the protected-resource metadata
 * (`oauth-protected-resource-metadata.ts`). It says what the server does and nothing it does not:
 * the code flow with PKCE S256 only, no dynamic registration (there is no
 * `registration_endpoint`: clients are registered by an operator), and no `iss` in the
 * authorization response (not advertised, so a client that picks its redirect by that flag sends
 * the one it is registered with).
 */

export const OAUTH_AUTHORIZATION_SERVER_WELL_KNOWN_PATH = '/.well-known/oauth-authorization-server';

export type OAuthAuthorizationServerMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
  response_types_supported: ['code'];
  response_modes_supported: ['query'];
  grant_types_supported: ['authorization_code', 'refresh_token'];
  code_challenge_methods_supported: ['S256'];
  token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'];
  revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'];
  scopes_supported: [typeof AGENT_OAUTH_SCOPE];
  service_documentation: string;
};

/** The document, or null where the site URL is not configured. */
export function buildOAuthAuthorizationServerMetadata(
  options: { siteUrl?: string } = {},
): OAuthAuthorizationServerMetadata | null {
  const issuer = resolveMcpSiteOrigin(options.siteUrl ?? process.env.NEXT_PUBLIC_SITE_URL);
  if (!issuer) return null;
  return {
    issuer,
    authorization_endpoint: `${issuer}${AGENT_OAUTH_AUTHORIZE_PATH}`,
    token_endpoint: `${issuer}${AGENT_OAUTH_TOKEN_PATH}`,
    revocation_endpoint: `${issuer}${AGENT_OAUTH_REVOKE_PATH}`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: [AGENT_OAUTH_SCOPE],
    service_documentation: `${issuer}${MCP_DEVELOPERS_PAGE_PATH}`,
  };
}

/** Cached for five minutes, as the protected-resource document is. */
const METADATA_CACHE_CONTROL = 'public, max-age=300, s-maxage=300';

export function createAuthorizationServerMetadataResponse(
  options: { siteUrl?: string } = {},
): NextResponse {
  const metadata = buildOAuthAuthorizationServerMetadata(options);
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

export function createAuthorizationServerMetadataOptionsResponse(): NextResponse {
  return new NextResponse(null, { status: 204, headers: protectedResourceCorsHeaders() });
}
