import { RequestHintedOptionalAuth, RequireAuth } from '@/components/RouteAuthBoundary';
import { loadVisitorWelcomeCredits, readCreatorWelcome } from '@/lib/creator-page-server';

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
  const welcome = readCreatorWelcome(resolvedSearchParams);

  // Remixing someone's post takes an account (the remix source answers no one
  // else), so a signed-out remix signs in first and comes back to it.
  if (prefill.remixId) {
    return (
      <RequireAuth returnTo={returnTo}>
        <CreateVideoClient prefill={prefill} welcome={welcome} visitorWelcomeCredits={null} />
      </RequireAuth>
    );
  }

  // Signed out, the creator works up to Generate, which asks for an account.
  return (
    <RequestHintedOptionalAuth>
      <CreateVideoClient prefill={prefill} welcome={welcome} visitorWelcomeCredits={await loadVisitorWelcomeCredits()} />
    </RequestHintedOptionalAuth>
  );
}
