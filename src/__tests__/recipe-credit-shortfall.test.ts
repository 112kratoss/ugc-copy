import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RECIPE_UNSPENDABLE_CREDITS_NOTE, formatRecipeCreditShortfall } from '@/lib/recipe-credit-shortfall';

describe('formatRecipeCreditShortfall', () => {
  it("tells a new account with only welcome credits what it needs, and why the welcome credits don't count", () => {
    expect(formatRecipeCreditShortfall(0, 50, { holdsUnspendableCredits: true }))
      .toBe("You need 50 more credits. Welcome and referral credits can't be spent on recipes.");
  });

  it('says only the shortfall when the whole balance can buy recipes', () => {
    expect(formatRecipeCreditShortfall(120, 900, { holdsUnspendableCredits: false })).toBe('You need 780 more credits.');
  });

  it('counts one credit as one and groups thousands', () => {
    expect(formatRecipeCreditShortfall(49, 50, { holdsUnspendableCredits: false })).toBe('You need 1 more credit.');
    expect(formatRecipeCreditShortfall(0, 1500, { holdsUnspendableCredits: false })).toBe('You need 1,500 more credits.');
  });

  it('claims nothing while the spendable figure is unknown, or when it covers the price', () => {
    expect(formatRecipeCreditShortfall(null, 50, { holdsUnspendableCredits: true })).toBeNull();
    expect(formatRecipeCreditShortfall(50, 50, { holdsUnspendableCredits: true })).toBeNull();
    expect(formatRecipeCreditShortfall(80, 50, { holdsUnspendableCredits: false })).toBeNull();
  });

  it('reads a negative spendable figure (a debt) as nothing to spend', () => {
    expect(formatRecipeCreditShortfall(-20, 50, { holdsUnspendableCredits: false })).toBe('You need 50 more credits.');
  });

  // The web says what the app says under its held unlock. The app's hook loads
  // expo-router and the app's own aliases, so its source is read instead, by its
  // words only: a renamed variable there is no reason to fail here.
  it("says it in the app's words", () => {
    const appHook = readFileSync(path.join(process.cwd(), 'ugc-mobile/lib/use-bundle-unlock.ts'), 'utf8');
    expect(appHook).toContain(`"${RECIPE_UNSPENDABLE_CREDITS_NOTE}"`);
    expect(appHook).toMatch(/`You need \$\{[^}]+\} more \$\{[^}]+=== 1 \? 'credit' : 'credits'\}\.`/);
  });
});
