import { describe, expect, it } from 'vitest';

import { getUserInitials } from '@/lib/user-initials';

describe('getUserInitials', () => {
  it('takes the first letter of the first two words', () => {
    expect(getUserInitials('maya rao singh')).toBe('MR');
    expect(getUserInitials('  fluffy ')).toBe('F');
    expect(getUserInitials('')).toBe('U');
  });

  // Half a surrogate pair was encoded as U+FFFD on the server and kept as
  // itself in the browser, so a server-drawn avatar failed hydration.
  it('keeps an emoji whole rather than taking half of it', () => {
    const initials = getUserInitials('🔥Arjun 🎨Studio');

    expect(initials).toBe('🔥🎨');
    expect(initials).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});
