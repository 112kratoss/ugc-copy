'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, LogIn, Play, RefreshCw } from 'lucide-react';

import { useAuth } from '@/components/AuthProvider';
import { Button, StatusCallout, Surface, Text } from '@/components/DesignSystem';

import { createClientIdempotencyKey, createTemplateRun, TemplateApiError } from './api';
import { TemplatePageShell } from './TemplatePrimitives';

type StartFailure = {
  message: string;
  /**
   * The template is the caller's own draft or disabled one. Its page says so
   * and offers the canvas (by the template's id, which this refusal does not
   * carry), so that is where this one leads.
   */
  notActive: boolean;
  /** A 404 answers the same on every retry, so Try again is not offered. */
  retryable: boolean;
};

function toStartFailure(reason: unknown): StartFailure {
  const apiError = reason instanceof TemplateApiError ? reason : null;
  const notActive = apiError?.code === 'TEMPLATE_NOT_ACTIVE';
  return {
    message: reason instanceof Error ? reason.message : 'Could not start this template.',
    notActive,
    retryable: !notActive && apiError?.status !== 404,
  };
}

export default function CreateTemplateRunClient({ slug }: { slug: string }) {
  const router = useRouter();
  const { session, isLoading: isAuthLoading } = useAuth();
  const [idempotencyKey] = useState(() => createClientIdempotencyKey('template-run'));
  const [retryNonce, setRetryNonce] = useState(0);
  const [templateName, setTemplateName] = useState('your template');
  const [error, setError] = useState<StartFailure | null>(null);

  useEffect(() => {
    if (isAuthLoading || !session?.access_token) return;
    let active = true;
    // The run request resolves the slug itself and answers with the title;
    // a separate GET for the name was one more round trip before the run.
    void createTemplateRun(slug, session.access_token, idempotencyKey)
      .then((run) => {
        if (!active) return;
        setTemplateName(run.templateTitle);
        router.replace(`/template-runs/${run.id}`);
      })
      .catch((reason: unknown) => {
        if (active) setError(toStartFailure(reason));
      });

    return () => {
      active = false;
    };
  }, [idempotencyKey, isAuthLoading, retryNonce, router, session?.access_token, slug]);

  if (!isAuthLoading && !session?.access_token) {
    return (
      <TemplatePageShell>
        <Surface variant="panel" padding="lg" className="mx-auto mt-16 max-w-lg text-center">
          <LogIn className="mx-auto h-9 w-9 text-rose-200" aria-hidden />
          <Text as="h1" variant="cardTitle" className="mt-4">Sign in to use this template</Text>
          <Text variant="bodySm" className="mt-2">Your uploads and progress stay attached to your account.</Text>
          <Button href={`/login?returnUrl=${encodeURIComponent(`/templates/${slug}/create`)}`} variant="primary" className="mt-6">
            Sign in
          </Button>
        </Surface>
      </TemplatePageShell>
    );
  }

  return (
    <TemplatePageShell>
      <div className="mx-auto flex min-h-[68vh] max-w-xl items-center justify-center">
        <Surface variant="panel" padding="lg" className="w-full text-center">
          {error ? (
            <>
              {error.notActive ? (
                <StatusCallout
                  tone="warning"
                  title="This template isn't live"
                  body="It is a draft or disabled, so a run can't start. Its page says which."
                />
              ) : (
                <StatusCallout tone="danger" title="Could not start template" body={error.message} />
              )}
              <div className="mt-5 flex flex-wrap justify-center gap-3">
                <Button
                  href={`/templates/${slug}`}
                  variant={error.notActive ? 'primary' : 'ghost'}
                  icon={ArrowLeft}
                  iconPosition="start"
                >
                  {error.notActive ? 'Back to template' : 'Back'}
                </Button>
                {error.retryable ? (
                  <Button
                    variant="primary"
                    icon={RefreshCw}
                    onClick={() => {
                      setError(null);
                      setRetryNonce((value) => value + 1);
                    }}
                  >
                    Try again
                  </Button>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-rose-300/20 bg-rose-400/10 text-rose-100">
                <Play className="h-5 w-5" aria-hidden />
              </div>
              <Text as="h1" variant="cardTitle" className="mt-5">Starting {templateName}</Text>
              <Text variant="bodySm" className="mt-2">
                Preparing your private workspace and restoring the template’s public input manifest.
              </Text>
              <Loader2 className="mx-auto mt-6 h-6 w-6 animate-spin text-rose-200" aria-hidden />
              <span className="sr-only" role="status">Creating template run</span>
            </>
          )}
        </Surface>
      </div>
    </TemplatePageShell>
  );
}
