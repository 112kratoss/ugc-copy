import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260819060000_contact_message_triage.sql',
), 'utf8');

describe('contact message triage migration', () => {
  it('records who handled an enquiry and when', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS handled_at timestamptz');
    expect(migration).toContain('handled_by uuid REFERENCES auth.users(id)');
  });

  /** A support record is evidence; a mistaken triage has to be recoverable. */
  it('is a reversible toggle rather than a delete', () => {
    expect(migration).toContain('SET handled_at = NULL');
    expect(migration).not.toContain('DELETE FROM public.contact_messages');
  });

  it('does not move the handled timestamp when the state is re-asserted', () => {
    expect(migration).toContain('handled_at = coalesce(v_message.handled_at, v_now)');
  });

  it('indexes the open queue, which is the hot read', () => {
    expect(migration).toContain('WHERE handled_at IS NULL');
  });

  it('locks the row so two operators cannot interleave a handle and a reopen', () => {
    expect(migration).toContain('FROM public.contact_messages\n  WHERE id = p_message_id\n  FOR UPDATE');
  });

  it('grants execution only to service_role', () => {
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.set_contact_message_handled(uuid, uuid, boolean, text)\n  FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.set_contact_message_handled(uuid, uuid, boolean, text)\n  TO service_role');
  });
});
