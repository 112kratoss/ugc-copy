import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { jobErrorMessage } from '@/lib/job-error-message';

const STATEMENT_TIMEOUT = {
  code: '57014',
  details: null,
  hint: null,
  message: 'canceling statement due to statement timeout',
};

describe('what a failed job leaves in last_error', () => {
  it('keeps an Error message as it is', () => {
    expect(jobErrorMessage(new Error('node exploded'))).toBe('node exploded');
    // An Error is stored as it always was, with or without a code of its own.
    expect(jobErrorMessage(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })))
      .toBe('socket hang up');
  });

  it('reads the message of a database error and keeps its code beside it', () => {
    expect(jobErrorMessage(STATEMENT_TIMEOUT))
      .toBe('canceling statement due to statement timeout (code 57014)');
  });

  it('leaves the message alone when there is no code to add', () => {
    // A request that never got an answer comes back with an empty code.
    expect(jobErrorMessage({ message: 'TypeError: fetch failed', details: '', hint: '', code: '' }))
      .toBe('TypeError: fetch failed');
    expect(jobErrorMessage({ message: '<html><title>502 Bad Gateway</title></html>' }))
      .toBe('<html><title>502 Bad Gateway</title></html>');
    // Only a string code is a database code.
    expect(jobErrorMessage({ message: 'upstream refused', code: 502 })).toBe('upstream refused');
  });

  it('shows an object with no message to read as JSON, never as "[object Object]"', () => {
    expect(jobErrorMessage({ error: 'upstream timed out', status: 500 }))
      .toBe('{"error":"upstream timed out","status":500}');
    // An error answer with an empty body arrives as an empty message. Stored
    // as it is, the failed job would show no reason at all.
    expect(jobErrorMessage({ message: '' })).toBe('{"message":""}');
    expect(jobErrorMessage({ message: '   ', code: '57014' })).toBe('{"message":"   ","code":"57014"}');
    expect(jobErrorMessage({ message: { nested: true } })).toBe('{"message":{"nested":true}}');
  });

  it('still answers for an object that cannot be written as JSON', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(jobErrorMessage(circular)).toBe('[object Object]');
  });

  it('keeps a thrown value that is not an object as its own text', () => {
    expect(jobErrorMessage('boom')).toBe('boom');
    expect(jobErrorMessage(undefined)).toBe('undefined');
    expect(jobErrorMessage(null)).toBe('null');
    expect(jobErrorMessage(503)).toBe('503');
  });
});

describe('errors as the installed supabase-js reports them', () => {
  // A client built the way `createServiceClient` builds the workers' one, with
  // its requests answered by whatever a test puts in `answer`. The errors it
  // hands back are therefore the library's own, not objects typed out by hand.
  let answer: () => Response = () => new Response(null, { status: 204 });
  const supabase = createClient('http://supabase.invalid', 'not-a-real-key', {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: { fetch: async () => answer() },
  });

  function answerWith(status: number, body: string, contentType = 'application/json') {
    answer = () => new Response(body, { status, headers: { 'content-type': contentType } });
  }

  it('reads a write the database refused', async () => {
    answerWith(500, JSON.stringify(STATEMENT_TIMEOUT));

    // The call updateRunStep makes in the workflow runner.
    const { error } = await supabase
      .from('workflow_canvas_run_steps')
      .update({ status: 'processing' })
      .eq('id', 'step-1')
      .eq('run_id', 'run-1');

    expect(jobErrorMessage(error)).toBe('canceling statement due to statement timeout (code 57014)');
  });

  it('reads a read the database refused', async () => {
    answerWith(500, JSON.stringify(STATEMENT_TIMEOUT));

    // The call loadGeneration makes in the output import worker.
    const { error } = await supabase
      .from('generations')
      .select('id, status')
      .eq('id', 'generation-1')
      .single();

    expect(jobErrorMessage(error)).toBe('canceling statement due to statement timeout (code 57014)');
  });

  it('reads a queue call the database refused', async () => {
    answerWith(400, JSON.stringify({
      code: 'P0001',
      details: null,
      hint: null,
      message: 'locked_by is required',
    }));

    // The call the queue clients make for a heartbeat, a deferral and a finish.
    const { error } = await supabase.rpc('heartbeat_workflow_run_step_job', {
      p_id: 'job-1',
      p_locked_by: '',
    });

    expect(jobErrorMessage(error)).toBe('locked_by is required (code P0001)');
  });

  it('reads an answer that is not JSON', async () => {
    answerWith(502, '<html><title>502 Bad Gateway</title></html>', 'text/html');

    const { error } = await supabase.rpc('finish_workflow_run_step_job', { p_id: 'job-1' });

    expect(jobErrorMessage(error)).toBe('<html><title>502 Bad Gateway</title></html>');
  });

  it('reads an error answer with an empty body', async () => {
    answerWith(500, '', 'text/plain');

    const { error } = await supabase.rpc('finish_workflow_run_step_job', { p_id: 'job-1' });

    expect(jobErrorMessage(error)).toBe('{"message":""}');
  });

  it('reads a request that never got an answer', async () => {
    answer = () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      });
    };

    const { error } = await supabase.rpc('finish_workflow_run_step_job', { p_id: 'job-1' });

    expect(jobErrorMessage(error)).toBe('TypeError: fetch failed');
  });
});
