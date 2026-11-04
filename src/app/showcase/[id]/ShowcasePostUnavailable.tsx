import { Home, Link2Off } from 'lucide-react';

import { Button, Surface, Text } from '@/components/DesignSystem';
import { siteConfig } from '@/lib/seo';

const TITLE = 'Page not found';

/**
 * What the post page draws in place of a post that a block hides from this
 * viewer: the app's not-found page (`src/app/not-found.tsx`), word for word.
 * The server answered such a viewer with that page until the post page was
 * cached for everyone (2026-11-04); the block is now read in the browser, so
 * the page says the same thing from there.
 */
export default function ShowcasePostUnavailable() {
  return (
    <>
      <title>{`${TITLE} | ${siteConfig.name}`}</title>
      <div data-testid="showcase-post-unavailable" className="ui-page ui-page-ambient px-4 py-8 sm:px-6 sm:py-12">
        <Surface as="section" variant="panel" padding="lg" className="mx-auto max-w-2xl text-center sm:p-8">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--ui-surface-2)] text-[var(--ui-text-muted)]">
            <Link2Off className="h-5 w-5" aria-hidden />
          </span>
          <Text as="h1" variant="sectionTitle" className="mt-5">
            {TITLE}
          </Text>
          <Text variant="bodySm" className="mx-auto mt-2 max-w-xl text-balance">
            There is no page at this address. The link may be out of date, or the page may have been removed.
          </Text>
          <Button href="/" prefetch={false} variant="primary" icon={Home} iconPosition="start" className="mt-6">
            Go to Home
          </Button>
        </Surface>
      </div>
    </>
  );
}
