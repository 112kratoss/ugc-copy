import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const config = readFileSync(join(process.cwd(), 'supabase', 'config.toml'), 'utf8');

function section(name: string) {
  const marker = `[${name}]\n`;
  const start = config.indexOf(marker);
  expect(start, `Missing [${name}] section`).toBeGreaterThanOrEqual(0);

  const contentStart = start + marker.length;
  const nextSection = config.indexOf('\n[', contentStart);
  return config.slice(contentStart, nextSection === -1 ? config.length : nextSection);
}

function stringValue(configSection: string, key: string) {
  const match = configSection.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'));
  return match?.[1];
}

function booleanValue(configSection: string, key: string) {
  const match = configSection.match(new RegExp(`^${key}\\s*=\\s*(true|false)`, 'm'));
  return match?.[1] === 'true';
}

function numberValue(configSection: string, key: string) {
  const match = configSection.match(new RegExp(`^${key}\\s*=\\s*(\\d+)`, 'm'));
  return Number(match?.[1]);
}

describe('Supabase Auth production baseline config', () => {
  it('keeps local Auth password policy aligned with the production security baseline', () => {
    const auth = section('auth');
    const email = section('auth.email');

    expect(numberValue(auth, 'minimum_password_length')).toBeGreaterThanOrEqual(8);
    expect(stringValue(auth, 'password_requirements')).toBe('lower_upper_letters_digits_symbols');
    expect(booleanValue(email, 'secure_password_change')).toBe(true);
  });
});
