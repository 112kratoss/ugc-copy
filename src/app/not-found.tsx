import type { Metadata } from 'next';
import { Home, Link2Off } from 'lucide-react';

import { Button, Surface, Text } from '@/components/DesignSystem';
import { siteConfig } from '@/lib/seo';

const TITLE = 'Page not found';

export const metadata: Metadata = {
  title: TITLE,
};

/**
 * An address with no page, and a page that calls notFound() with no not-found
 * of its own (a post, a blog article, a model). Next's default one set
 * `height: 100vh` inline, so inside the app shell it overflowed the window by
 * the top bar and, below 768px, the bottom navigation's room, and scrolled over
 * nothing. The `.ui-page` root fills what the shell leaves it instead
 * (`.app-shell-content .ui-page` in globals.css).
 */
export default function NotFound() {
  return (
    <>
      {/* `metadata` names only an address with no page. A page that calls
          notFound() is drawn by the browser with that page's own head, so its
          title would stay in the tab; this one, like Next's default, comes first. */}
      <title>{`${TITLE} | ${siteConfig.name}`}</title>
      <div className="ui-page ui-page-ambient px-4 py-8 sm:px-6 sm:py-12">
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
