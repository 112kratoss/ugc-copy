import { describe, expect, it } from 'vitest';

import {
  PRODUCTION_PROJECT_REF,
  validateCertificationMigrationEnvironment,
} from '../../scripts/certification/apply-migrations.mjs';

const branchRef = 'abcdefghijklmnopqrst';

function certificationEnvironment(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    CERT_EXPECTED_PROJECT_REF: branchRef,
    SUPABASE_PROJECT_REF: branchRef,
    CERT_SUPABASE_URL: `https://${branchRef}.supabase.co`,
    ...overrides,
  };
}

describe('certification migration wrapper', () => {
  it('accepts one isolated project ref represented by all three inputs', () => {
    expect(validateCertificationMigrationEnvironment(certificationEnvironment())).toEqual({
      projectRef: branchRef,
      supabaseOrigin: `https://${branchRef}.supabase.co`,
    });
  });

  it.each([
    'CERT_EXPECTED_PROJECT_REF',
    'SUPABASE_PROJECT_REF',
    'CERT_SUPABASE_URL',
  ])('requires %s', (name) => {
    expect(() => validateCertificationMigrationEnvironment(
      certificationEnvironment({ [name]: undefined }),
    )).toThrow(/are required/);
  });

  it('rejects disagreement between the independently entered project refs', () => {
    expect(() => validateCertificationMigrationEnvironment(certificationEnvironment({
      SUPABASE_PROJECT_REF: 'zyxwvutsrqponmlkjihg',
    }))).toThrow(/must exactly match/);
  });

  it.each([
    { CERT_EXPECTED_PROJECT_REF: PRODUCTION_PROJECT_REF },
    { SUPABASE_PROJECT_REF: PRODUCTION_PROJECT_REF },
    { CERT_SUPABASE_URL: `https://${PRODUCTION_PROJECT_REF}.supabase.co` },
  ])('hard-rejects the known production project', (override) => {
    expect(() => validateCertificationMigrationEnvironment(
      certificationEnvironment(override),
    )).toThrow(/known production project/);
  });

  it('requires the Supabase hostname to contain the same project ref', () => {
    expect(() => validateCertificationMigrationEnvironment(certificationEnvironment({
      CERT_SUPABASE_URL: 'https://zyxwvutsrqponmlkjihg.supabase.co',
    }))).toThrow(new RegExp(`${branchRef}\\.supabase\\.co`));
  });

  it('does not accept a lookalike hostname or a non-HTTPS URL', () => {
    expect(() => validateCertificationMigrationEnvironment(certificationEnvironment({
      CERT_SUPABASE_URL: `https://${branchRef}.supabase.co.example.com`,
    }))).toThrow(/hostname must be/);

    expect(() => validateCertificationMigrationEnvironment(certificationEnvironment({
      CERT_SUPABASE_URL: `http://${branchRef}.supabase.co`,
    }))).toThrow(/must use HTTPS/);
  });
});
