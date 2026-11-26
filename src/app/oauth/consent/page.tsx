import { LogIn } from 'lucide-react';
import { redirect } from 'next/navigation';

import { Button, Kicker, StatusCallout, Surface, Text } from '@/components/DesignSystem';
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
 * The request a signed-in account is shown, read here, on the server, for this account. Reading
 * binds the request to the account and mints the consent token the answer must carry
 * (`loadAgentConsent`), so the page a different account opens later cannot answer it. Null for
 * anything that is not a live request of the app's own server (`mbar_…`).
 */
async function readRequest(authorizationId: string, userId: string): Promise<LoadedAgentConsent | null> {
  if (!isAgentAuthorizationId(authorizationId)) return null;
  try {
    return await loadAgentConsent({ authorizationId, userId }, { admin: createServiceClient() });
  } catch (error) {
    logBackendError('agent_oauth_consent_load_failed', { userId, error });
    return null;
  }
}

/**
 * `/oauth/consent?authorization_id=…`: where the app's own `/oauth/authorize` sends the person
 * when an agent asks to act as them (`docs/archive/agent-token-broker-plan-2026-11-26.md`). The
 * session decides who answers: a signed-out visitor signs in and comes back, a guest is shown the
 * wall, and an account decides in `ConsentClient`.
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
        ) : gate.kind === 'account' && read ? (
          <ConsentClient
            authorizationId={gate.authorizationId}
            email={gate.email}
            request={{ details: read.details, consentToken: read.consentToken }}
          />
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
