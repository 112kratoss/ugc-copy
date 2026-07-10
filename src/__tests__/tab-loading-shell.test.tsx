import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import TabLoadingShell from '@/app/components/TabLoadingShell';

describe('TabLoadingShell', () => {
  it('renders a stable loading region with the tab title', () => {
    const html = renderToString(
      <TabLoadingShell
        title="Studio"
        eyebrow="Workspace"
        accent="coral"
      />
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('Loading Studio');
    expect(html).toContain('Workspace');
    expect(html).toContain('animate-[skeleton-shimmer_1.5s_linear_infinite]');
  });
});
