import { LogIn } from 'lucide-react';
import { redirect } from 'next/navigation';

import { Button, Kicker, Surface, Text } from '@/components/DesignSystem';
import { gateConsentRequest } from '@/lib/oauth-consent-service';
import { getServerAuthState } from '@/lib/supabase-server';

import ConsentClient from './ConsentClient';

interface ConsentPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * `/oauth/consent?authorization_id=…`: where Supabase Auth's OAuth server sends the person when
 * an agent asks to act as them (`docs/plans/agent-mcp-server-plan-2026-11-09.md`). The session
 * decides who answers: a signed-out visitor signs in and comes back, a guest is shown the wall
 * (GoTrue itself would let a guest approve), and an account decides in `ConsentClient`.
 */
export default async function OAuthConsentPage({ searchParams }: ConsentPageProps) {
  const params = searchParams ? await searchParams : {};
  const auth = await getServerAuthState();
  const gate = gateConsentRequest({
    authorizationId: firstParam(params.authorization_id),
    user: auth.session?.user ?? null,
  });
  if (gate.kind === 'sign_in') redirect(gate.href);

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
        ) : (
          <ConsentClient authorizationId={gate.authorizationId} email={gate.email} />
        )}
      </div>
    </main>
  );
}
