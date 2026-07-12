'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, LogIn, Play, RefreshCw } from 'lucide-react';

import { useAuth } from '@/app/components/AuthProvider';
import { Button, StatusCallout, Surface, Text } from '@/app/components/DesignSystem';

import { createClientIdempotencyKey, createTemplateRun, getTemplate } from './api';
import { TemplatePageShell } from './TemplatePrimitives';

export default function CreateTemplateRunClient({ slug }: { slug: string }) {
  const router = useRouter();
  const { session, isLoading: isAuthLoading } = useAuth();
  const [idempotencyKey] = useState(() => createClientIdempotencyKey('template-run'));
  const [retryNonce, setRetryNonce] = useState(0);
  const [templateName, setTemplateName] = useState('your template');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isAuthLoading || !session?.access_token) return;
    let active = true;
    void getTemplate(slug, session.access_token)
      .then((template) => {
        if (active) setTemplateName(template.name);
        return createTemplateRun(template.id, session.access_token, idempotencyKey);
      })
      .then((run) => {
        if (active) router.replace(`/template-runs/${run.id}`);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Could not start this template.');
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
              <StatusCallout tone="danger" title="Could not start template" body={error} />
              <div className="mt-5 flex flex-wrap justify-center gap-3">
                <Button href={`/templates/${slug}`} variant="ghost" icon={ArrowLeft} iconPosition="start">
                  Back
                </Button>
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
