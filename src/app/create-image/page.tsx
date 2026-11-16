import { RequestHintedOptionalAuth, RequireAuth } from '@/components/RouteAuthBoundary';
import type { CreatorOpening } from '@/lib/creator-opening';
import { loadCreatorOpening, loadCreatorStartPostsForRequest, loadTemplatesLive, loadVisitorWelcomeCredits, readCreatorReturn } from '@/lib/creator-page-server';

import CreateImageClient, { type CreateImagePrefill } from './CreateImageClient';

type CreateImagePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function getFirstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function CreateImagePage({
  searchParams,
}: CreateImagePageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const prefill: CreateImagePrefill = {
    remixId: getFirstValue(resolvedSearchParams.remix),
    remixPostId: getFirstValue(resolvedSearchParams.remixPost),
    prompt: getFirstValue(resolvedSearchParams.prompt),
    model: getFirstValue(resolvedSearchParams.model),
    aspectRatio: getFirstValue(resolvedSearchParams.aspectRatio),
  };
  const returnParams = new URLSearchParams();
  if (prefill.remixId) returnParams.set('remix', prefill.remixId);
  if (prefill.remixPostId) returnParams.set('remixPost', prefill.remixPostId);
  if (prefill.prompt) returnParams.set('prompt', prefill.prompt);
  if (prefill.model) returnParams.set('model', prefill.model);
  if (prefill.aspectRatio) returnParams.set('aspectRatio', prefill.aspectRatio);
  const returnTo = returnParams.size > 0
    ? `/create-image?${returnParams.toString()}`
    : '/create-image';
  const { welcome, handoverNonce } = readCreatorReturn(resolvedSearchParams);
  // The shelf's posts, for the empty canvas (owner, 2026-10-28): left unawaited, so the
  // creator draws without waiting on them. A remix opens on its own post instead.
  const startPosts = prefill.remixId ? null : loadCreatorStartPostsForRequest();
  // Whether /templates lists anything, from the creators' shared cache: the ways into it are drawn
  // only then, so a reader is never sent to an empty catalog.
  const templatesLiveRead = loadTemplatesLive();
  const client = (visitorWelcomeCredits: number | null, opening: CreatorOpening | null, templatesLive: boolean) => (
    <CreateImageClient
      // A Remix from this page lands on the same route, which keeps the client: a
      // new remix starts a new one, so it loads as a remix opened anywhere else does.
      key={`${prefill.remixId ?? ''}|${prefill.remixPostId ?? ''}`}
      prefill={prefill}
      welcome={welcome}
      handoverNonce={handoverNonce}
      visitorWelcomeCredits={visitorWelcomeCredits}
      opening={opening}
      startPosts={startPosts}
      templatesLive={templatesLive}
    />
  );

  // Remixing someone's post takes an account (the remix source answers no one
  // else), so a signed-out remix signs in first and comes back to it. Everything
  // else works signed out up to Generate, which asks for an account. A remix
  // opens on its own run, which the page reads once it is in.
  if (prefill.remixId) return <RequireAuth returnTo={returnTo}>{client(null, null, await templatesLiveRead)}</RequireAuth>;
  const [visitorWelcomeCredits, opening, templatesLive] = await Promise.all([
    loadVisitorWelcomeCredits(),
    loadCreatorOpening('image', prefill),
    templatesLiveRead,
  ]);
  return <RequestHintedOptionalAuth>{client(visitorWelcomeCredits, opening, templatesLive)}</RequestHintedOptionalAuth>;
}
