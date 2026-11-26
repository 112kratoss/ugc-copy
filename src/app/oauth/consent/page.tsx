import { LogIn } from 'lucide-react';
import { redirect } from 'next/navigation';

import { Button, Kicker, StatusCallout, Surface, Text } from '@/components/DesignSystem';
import { areSupabaseAgentTokensAccepted, isAppAuthorizationServerEnabled } from '@/lib/agent-oauth-mode';
import { isAgentAuthorizationId, loadAgentConsent, type LoadedAgentConsent } from '@/lib/agent-oauth-server-service';
import { logBackendError } from '@/lib/backend-logger';
import { CONSENT_UNAVAILABLE_MESSAGE, gateConsentRequest } from '@/lib/oauth-consent-service';
import { createServiceClient } from '@/lib/server-helpers';
import { getServerAuthState } from '@/lib/supabase-server';

import ConsentClient from './ConsentClient';

interface ConsentPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * What the page shows a signed-in account for a request, by whose request it is
 * (`MCP_AUTHORIZATION_SERVER`, `agent-oauth-mode.ts`):
 *
 * - the app's own (`mbar_…`): read here, on the server, for this account. Reading binds the
 *   request to the account and mints the consent token the answer must carry
 *   (`loadAgentConsent`), so the page a different account opens later cannot answer it;
 * - Supabase Auth's (any other id), until its server is off: read by the browser's session in
 *   `ConsentClient`, as before.
 */
async function readRequest(authorizationId: string, userId: string): Promise<
  | { kind: 'app'; request: LoadedAgentConsent }
  | { kind: 'supabase' }
  | { kind: 'unavailable' }
> {
  if (!isAgentAuthorizationId(authorizationId)) {
    return areSupabaseAgentTokensAccepted() ? { kind: 'supabase' } : { kind: 'unavailable' };
  }
  if (!isAppAuthorizationServerEnabled()) return { kind: 'unavailable' };
  try {
    const request = await loadAgentConsent({ authorizationId, userId }, { admin: createServiceClient() });
    return request ? { kind: 'app', request } : { kind: 'unavailable' };
  } catch (error) {
    logBackendError('agent_oauth_consent_load_failed', { userId, error });
    return { kind: 'unavailable' };
  }
}

/**
 * `/oauth/consent?authorization_id=…`: where an authorization server sends the person when an
 * agent asks to act as them: the app's own `/oauth/authorize`
 * (`docs/plans/agent-token-broker-plan-2026-11-26.md`) or, until the cutover, Supabase Auth's
 * (`docs/plans/agent-mcp-server-plan-2026-11-09.md`). The session decides who answers: a
 * signed-out visitor signs in and comes back, a guest is shown the wall, and an account decides
 * in `ConsentClient`.
 */
export default async function OAuthConsentPage({ searchParams }: ConsentPageProps) {
  const params = searchParams ? await searchParams : {};
  const auth = await getServerAuthState();
  const gate = gateConsentRequest({
    authorizationId: firstParam(params.authorization_id),
    user: auth.session?.user ?? null,
  });
  if (gate.kind === 'sign_in') redirect(gate.href);
  const userId = auth.session?.user?.id;
  const read = gate.kind === 'account' && userId ? await readRequest(gate.authorizationId, userId) : null;

  return (
    <main className="ui-page flex items-start justify-center px-4 py-10 sm:items-center">
      <div className="w-full max-w-md">
        {gate.kind === 'missing' ? (
          <Surface as="section" padding="lg" className="space-y-4" role="alert">
            <Kicker>Connect an app</Kicker>
            <Text as="h1" variant="sectionTitle">This link is incomplete</Text>
            <Text>
              An app connects to Magicbooklet by sending you here with its request. Go back to the
              app and start the connection again.
            </Text>
          </Surface>
        ) : gate.kind === 'guest' ? (
          <Surface as="section" padding="lg" className="space-y-4">
            <Kicker>Connect an app</Kicker>
            <Text as="h1" variant="sectionTitle">Sign in to connect an app</Text>
            <Text>
              You are browsing as a guest. An app acts as an account, with what that account has made
              and posted, so connecting one needs you to sign in or create an account first. You come
              straight back here afterwards.
            </Text>
            <Button href={gate.href} variant="primary" icon={LogIn}>Sign in or create an account</Button>
          </Surface>
        ) : read?.kind === 'app' ? (
          <ConsentClient
            authorizationId={gate.authorizationId}
            email={gate.email}
            appRequest={{ details: read.request.details, consentToken: read.request.consentToken }}
          />
        ) : read?.kind === 'supabase' ? (
          <ConsentClient authorizationId={gate.authorizationId} email={gate.email} />
        ) : (
          <Surface as="section" padding="lg" className="space-y-4" data-consent-state="error">
            <Kicker>Connect an app</Kicker>
            <Text as="h1" variant="sectionTitle">This connection could not be made</Text>
            <StatusCallout tone="danger" title="Nothing was connected" body={CONSENT_UNAVAILABLE_MESSAGE} />
          </Surface>
        )}
      </div>
    </main>
  );
}
