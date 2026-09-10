import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { activeGenerationsQueryKey, invalidateActiveGenerations } from '../lib/active-generations';

const root = join(__dirname, '..');
const read = (relative: string) => readFileSync(join(root, relative), 'utf8');

describe('active-generations invalidation', () => {
  it('invalidates exactly the viewer’s own key', () => {
    const queryClient = { invalidateQueries: vi.fn() };

    invalidateActiveGenerations(queryClient as never, 'user-1');

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: activeGenerationsQueryKey('user-1'),
    });
  });

  it('keys guests separately from a registered account', () => {
    // The count is per identity, and a guest holds a real backend identity, so
    // a shared key would show one person's runs to the next session.
    expect(activeGenerationsQueryKey('guest-1')).not.toEqual(activeGenerationsQueryKey('user-1'));
  });

  it('still issues the call with no identity rather than silently skipping', () => {
    // Guarding here would hide the case; the query itself is disabled without
    // an id, so an invalidation for a null key is harmless and keeps the
    // caller free of a condition it would have to repeat at every start site.
    const queryClient = { invalidateQueries: vi.fn() };

    invalidateActiveGenerations(queryClient as never, null);

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: activeGenerationsQueryKey(null),
    });
  });
});

describe('every path that starts a run tells the ring', () => {
  // Source assertions, matching how hig-alerts-screen.test.ts pins the badge
  // invalidation in the root layout. The alternative is booting the whole
  // creation screen, which drags the native chain in for one function call.
  //
  // This is the regression guard for a defect found in review: the ring's poll
  // interval is a function of its own answer, so at zero it is off entirely and
  // nothing would ever discover a newly started run. The bar never unmounts, so
  // there is no refetch-on-mount either — without these calls the ring stayed
  // dark until the app next came back to the foreground.
  it('the create screen invalidates after a start succeeds', () => {
    const source = read('components/media-creation-screen.tsx');

    expect(source).toContain("import { invalidateActiveGenerations } from '@/lib/active-generations'");
    expect(source).toContain('invalidateActiveGenerations(queryClient, identityUserId)');
  });

  it('the workflow run screen invalidates when a run starts', () => {
    const source = read('components/media-template-screens.tsx');

    expect(source).toContain("import { invalidateActiveGenerations } from '@/lib/active-generations'");
    expect(source).toContain('invalidateActiveGenerations(queryClient, identityUserId)');
  });

  it('keeps the key out of the hook file, so callers never boot Expo to invalidate', () => {
    // The whole reason for the split. If the key moves back beside the hook,
    // importing it drags useAuth and react-native in, and this suite dies at
    // parse time rather than failing on an assertion.
    const pure = read('lib/active-generations.ts');

    expect(pure).not.toContain("from '@/lib/auth'");
    expect(pure).not.toContain("from 'react-native'");
  });

  it('the count query still stops polling once nothing is running', () => {
    // The fix must not turn into an always-on poll: the whole point of
    // invalidating is that an idle app never has to ask.
    const source = read('lib/use-active-generations.ts');

    expect(source).toContain('refetchInterval');
    expect(source).toMatch(/>\s*0\s*\?[^:]+:\s*false/);
  });
});
