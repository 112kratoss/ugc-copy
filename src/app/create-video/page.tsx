import { RequestHintedOptionalAuth, RequireAuth } from '@/components/RouteAuthBoundary';
import { loadCreatorStartPostsForRequest, loadVisitorWelcomeCredits, readCreatorReturn } from '@/lib/creator-page-server';

import CreateVideoClient, { type CreateVideoPrefill } from './CreateVideoClient';

type CreateVideoPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function getFirstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function CreateVideoPage({
  searchParams,
}: CreateVideoPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const prefill: CreateVideoPrefill = {
    remixId: getFirstValue(resolvedSearchParams.remix),
    remixPostId: getFirstValue(resolvedSearchParams.remixPost),
    prompt: getFirstValue(resolvedSearchParams.prompt),
    model: getFirstValue(resolvedSearchParams.model),
    aspectRatio: getFirstValue(resolvedSearchParams.aspectRatio),
    duration: getFirstValue(resolvedSearchParams.duration),
  };
  const returnParams = new URLSearchParams();
  if (prefill.remixId) returnParams.set('remix', prefill.remixId);
  if (prefill.remixPostId) returnParams.set('remixPost', prefill.remixPostId);
  if (prefill.prompt) returnParams.set('prompt', prefill.prompt);
  if (prefill.model) returnParams.set('model', prefill.model);
  if (prefill.aspectRatio) returnParams.set('aspectRatio', prefill.aspectRatio);
  if (prefill.duration) returnParams.set('duration', prefill.duration);
  const returnTo = returnParams.size > 0
    ? `/create-video?${returnParams.toString()}`
    : '/create-video';
  const { welcome, handoverNonce } = readCreatorReturn(resolvedSearchParams);
  // The shelf's posts, for the empty canvas (owner, 2026-10-28): left unawaited, so the
  // creator draws without waiting on them. A remix opens on its own post instead.
  const startPosts = prefill.remixId ? null : loadCreatorStartPostsForRequest();
  const client = (visitorWelcomeCredits: number | null) => (
    <CreateVideoClient
      // A Remix from this page lands on the same route, which keeps the client: a
      // new remix starts a new one, so it loads as a remix opened anywhere else does.
      key={`${prefill.remixId ?? ''}|${prefill.remixPostId ?? ''}`}
      prefill={prefill}
      welcome={welcome}
      handoverNonce={handoverNonce}
      visitorWelcomeCredits={visitorWelcomeCredits}
      startPosts={startPosts}
    />
  );

  // Remixing someone's post takes an account (the remix source answers no one
  // else), so a signed-out remix signs in first and comes back to it. Everything
  // else works signed out up to Generate, which asks for an account.
  return prefill.remixId
    ? <RequireAuth returnTo={returnTo}>{client(null)}</RequireAuth>
    : <RequestHintedOptionalAuth>{client(await loadVisitorWelcomeCredits())}</RequestHintedOptionalAuth>;
}
