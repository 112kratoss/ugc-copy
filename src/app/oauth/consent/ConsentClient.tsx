'use client';

import { Check, ExternalLink, ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button, Kicker, StatusCallout, Surface, Text } from '@/components/DesignSystem';
import {
  CONSENT_DECISION_FAILED_MESSAGE,
  CONSENT_UNAVAILABLE_MESSAGE,
  decideConsent,
  loadConsentView,
  sendAgentConsentAnswer,
  type ConsentDecision,
  type ConsentDetails,
} from '@/lib/oauth-consent-service';
import { supabase } from '@/lib/supabase';

type State =
  | { kind: 'loading' }
  | { kind: 'redirecting' }
  | { kind: 'consent'; details: ConsentDetails; deciding: ConsentDecision | null }
  | { kind: 'error'; message: string };

/** A full load of the client's redirect URL: a code in its query, for the app that asked. */
function leaveFor(redirectUrl: string) {
  window.location.assign(redirectUrl);
}

/**
 * A request of the app's own authorization server, as the page read it on the server for this
 * account: what to show, and the one-time token the answer carries (`loadAgentConsent`).
 */
export type AppConsentRequest = { details: ConsentDetails; consentToken: string };

/**
 * The account's half of the consent screen: who is asking, what an agent may do, where the
 * browser goes back to, and the two answers.
 *
 * For a request of the app's own authorization server (`appRequest`) the page arrives with the
 * request already read, and the answer goes to `/api/oauth/consent` with the web session's token.
 * For one of Supabase Auth's, until its server is off, the browser's session reads the request
 * and answers GoTrue, following its redirect when this client was already approved.
 */
export default function ConsentClient({
  authorizationId,
  email,
  appRequest,
}: {
  authorizationId: string;
  email: string | null;
  appRequest?: AppConsentRequest;
}) {
  const [state, setState] = useState<State>(() => (
    appRequest ? { kind: 'consent', details: appRequest.details, deciding: null } : { kind: 'loading' }
  ));

  useEffect(() => {
    if (appRequest) return undefined;
    let cancelled = false;
    loadConsentView(supabase.auth.oauth, authorizationId)
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setState({ kind: 'error', message: result.message });
        } else if (result.view.kind === 'redirect') {
          setState({ kind: 'redirecting' });
          leaveFor(result.view.redirectUrl);
        } else {
          setState({ kind: 'consent', details: result.view.details, deciding: null });
        }
      })
      // A thrown failure (the network, a client without the OAuth API) would otherwise leave the
      // page reading the request for ever.
      .catch(() => {
        if (!cancelled) setState({ kind: 'error', message: CONSENT_UNAVAILABLE_MESSAGE });
      });
    return () => {
      cancelled = true;
    };
    // The request is the page's for its whole life: it is read once, or arrives read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorizationId]);

  async function decide(decision: ConsentDecision) {
    if (state.kind !== 'consent' || state.deciding) return;
    setState({ ...state, deciding: decision });
    let result: Awaited<ReturnType<typeof decideConsent>>;
    try {
      if (appRequest) {
        const { data } = await supabase.auth.getSession();
        result = await sendAgentConsentAnswer(
          { authorizationId, decision, consentToken: appRequest.consentToken },
          { accessToken: data.session?.access_token },
        );
      } else {
        result = await decideConsent(supabase.auth.oauth, authorizationId, decision);
      }
    } catch {
      result = { ok: false, message: CONSENT_DECISION_FAILED_MESSAGE };
    }
    if (!result.ok) {
      setState({ kind: 'error', message: result.message });
      return;
    }
    setState({ kind: 'redirecting' });
    leaveFor(result.redirectUrl);
  }

  if (state.kind === 'loading' || state.kind === 'redirecting') {
    return (
      <Surface as="section" padding="lg" className="space-y-4" role="status" ariaLive="polite" data-consent-state={state.kind}>
        <Kicker>Connect an app</Kicker>
        <Text as="h1" variant="sectionTitle">
          {state.kind === 'loading' ? 'Reading the request…' : 'Taking you back to the app…'}
        </Text>
      </Surface>
    );
  }

  if (state.kind === 'error') {
    return (
      <Surface as="section" padding="lg" className="space-y-4" data-consent-state="error">
        <Kicker>Connect an app</Kicker>
        <Text as="h1" variant="sectionTitle">This connection could not be made</Text>
        <StatusCallout tone="danger" title="Nothing was connected" body={state.message} />
      </Surface>
    );
  }

  const { details, deciding } = state;
  return (
    <Surface as="section" padding="lg" className="space-y-5" data-consent-state="consent">
      <div className="space-y-3">
        <Kicker>Connect an app</Kicker>
        <Text as="h1" variant="sectionTitle" id="consent-title">
          Allow <span className="text-[var(--ui-primary)]">{details.clientName}</span> to use your Magicbooklet account?
        </Text>
        {details.clientUri ? (
          <a
            className="ui-focus-ring inline-flex items-center gap-1 rounded-lg text-sm text-[var(--ui-text-muted)] underline-offset-4 hover:underline"
            href={details.clientUri}
            rel="noreferrer noopener"
            target="_blank"
          >
            {new URL(details.clientUri).host}
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </a>
        ) : null}
        {email ? (
          <Text variant="bodySm">
            Signed in as <span className="font-semibold text-[var(--ui-text-secondary)]">{email}</span>
          </Text>
        ) : null}
      </div>

      <div>
        <Text as="h2" variant="label" id="consent-access">It will be able to</Text>
        <ul className="mt-2 space-y-3" aria-labelledby="consent-access">
          {details.access.map((item) => (
            <li key={item.title} className="flex gap-3">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--ui-primary-soft)] text-[var(--ui-primary)]">
                <Check className="h-3.5 w-3.5" aria-hidden />
              </span>
              <div>
                <Text as="p" variant="body" className="font-semibold text-[var(--ui-text-primary)]">{item.title}</Text>
                <Text as="p" variant="bodySm">{item.detail}</Text>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {details.redirect ? (
        details.redirect.loopback ? (
          <StatusCallout
            tone="warning"
            icon={ShieldAlert}
            title={`Returns to ${details.redirect.host}, a program on your computer`}
            body="Any program on this computer could have asked for this. Allow it only if you started the connection yourself, just now."
          />
        ) : (
          <Text variant="bodySm">
            Afterwards you return to <span className="font-mono text-[var(--ui-text-secondary)]">{details.redirect.host}</span>.
          </Text>
        )
      ) : null}

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button variant="secondary" onClick={() => decide('deny')} disabled={deciding !== null} pending={deciding === 'deny'}>
          {deciding === 'deny' ? 'Declining…' : 'Deny'}
        </Button>
        <Button variant="primary" onClick={() => decide('approve')} disabled={deciding !== null} pending={deciding === 'approve'}>
          {deciding === 'approve' ? 'Connecting…' : 'Allow'}
        </Button>
      </div>
      <Text variant="caption">The app never sees your password. It acts as you until it is disconnected or you sign out everywhere.</Text>
    </Surface>
  );
}
