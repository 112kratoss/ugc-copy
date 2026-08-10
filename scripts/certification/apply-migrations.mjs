#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRODUCTION_PROJECT_REF = 'ildfmhozpibwiopeavfg';

const MIGRATOR_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../.github/scripts/apply-supabase-migrations.mjs',
);

/**
 * Fail closed before the release migrator can contact Supabase.
 *
 * `CERT_EXPECTED_PROJECT_REF` must be copied independently from the isolated
 * certification branch details. Requiring it to agree with both the migrator
 * target and the branch URL prevents a stale shell variable from redirecting
 * the migration step to another project. Production is rejected even if all
 * three values agree.
 */
export function validateCertificationMigrationEnvironment(environment = process.env) {
  const expectedProjectRef = environment.CERT_EXPECTED_PROJECT_REF?.trim();
  const projectRef = environment.SUPABASE_PROJECT_REF?.trim();
  const supabaseUrlValue = environment.CERT_SUPABASE_URL?.trim();

  if (!expectedProjectRef || !projectRef || !supabaseUrlValue) {
    throw new Error(
      'CERT_EXPECTED_PROJECT_REF, SUPABASE_PROJECT_REF and CERT_SUPABASE_URL are required.',
    );
  }

  let supabaseUrl;
  try {
    supabaseUrl = new URL(supabaseUrlValue);
  } catch {
    throw new Error('CERT_SUPABASE_URL must be a valid absolute URL.');
  }

  const hostname = supabaseUrl.hostname.toLowerCase();
  const hostnameProjectRef = hostname.endsWith('.supabase.co')
    ? hostname.slice(0, -'.supabase.co'.length)
    : null;

  if (
    expectedProjectRef === PRODUCTION_PROJECT_REF
    || projectRef === PRODUCTION_PROJECT_REF
    || hostnameProjectRef === PRODUCTION_PROJECT_REF
  ) {
    throw new Error(`Refusing to migrate known production project ${PRODUCTION_PROJECT_REF}.`);
  }

  if (expectedProjectRef !== projectRef) {
    throw new Error('CERT_EXPECTED_PROJECT_REF must exactly match SUPABASE_PROJECT_REF.');
  }

  if (supabaseUrl.protocol !== 'https:') {
    throw new Error('CERT_SUPABASE_URL must use HTTPS.');
  }

  const expectedHostname = `${expectedProjectRef}.supabase.co`;
  if (hostname !== expectedHostname) {
    throw new Error(
      `CERT_SUPABASE_URL hostname must be ${expectedHostname}; received ${hostname || '(empty)'}.`,
    );
  }

  return {
    projectRef,
    supabaseOrigin: supabaseUrl.origin,
  };
}

export async function runExistingMigrator(environment = process.env) {
  validateCertificationMigrationEnvironment(environment);

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MIGRATOR_PATH], {
      env: environment,
      stdio: 'inherit',
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        signal
          ? `Supabase migrator terminated by signal ${signal}.`
          : `Supabase migrator exited with status ${code}.`,
      ));
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runExistingMigrator();
}
