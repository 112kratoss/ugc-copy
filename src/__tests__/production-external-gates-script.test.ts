import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const scriptPath = path.join(process.cwd(), 'scripts', 'production-external-gates.mjs');

describe('production external gates helper', () => {
  it('self-tests advisor parsing and the narrow Supabase Auth patch payload', () => {
    const output = execFileSync(process.execPath, [scriptPath, '--self-test'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(output).toContain('production-external-gates self-test passed');
  });
});
