import { describe, expect, it, vi } from 'vitest';

import {
  createBackendLogger,
  logBackendError,
  logBackendEvent,
  logBackendInfo,
  setBackendLogSink,
  type BackendLogRecord,
} from '@/lib/backend-logger';
import { withRequestTrace } from '@/lib/request-trace';

function captureLogs(operation: () => void): BackendLogRecord[] {
  const records: BackendLogRecord[] = [];
  const restore = setBackendLogSink((record) => {
    records.push(record);
  });

  try {
    operation();
  } finally {
    restore();
  }

  return records;
}

describe('backend logger', () => {
  it('emits a structured record with level, event name, and timestamp', () => {
    const [record] = captureLogs(() => {
      logBackendInfo('generation_started', { generationId: 'gen-1', model: 'seedance-2' });
    });

    expect(record.level).toBe('info');
    expect(record.msg).toBe('generation_started');
    expect(record.generationId).toBe('gen-1');
    expect(record.model).toBe('seedance-2');
    expect(() => new Date(record.ts).toISOString()).not.toThrow();
  });

  it('adopts the ambient request id without call sites threading it', () => {
    const [record] = captureLogs(() => {
      withRequestTrace({ requestId: 'req-abc' }, () => {
        logBackendInfo('generation_started', { generationId: 'gen-1' });
      });
    });

    expect(record.requestId).toBe('req-abc');
  });

  it('omits the request id outside a request trace', () => {
    const [record] = captureLogs(() => {
      logBackendInfo('cron_tick');
    });

    expect(record).not.toHaveProperty('requestId');
  });

  it('normalizes an Error into name and message fields', () => {
    const [record] = captureLogs(() => {
      logBackendError('generation_failed', { error: new TypeError('bad model id') });
    });

    expect(record.errorName).toBe('TypeError');
    expect(record.errorMessage).toBe('bad model id');
    expect(record).not.toHaveProperty('error');
  });

  it('normalizes non-Error throwables', () => {
    const [stringRecord] = captureLogs(() => {
      logBackendError('generation_failed', { error: 'plain failure' });
    });
    expect(stringRecord.errorMessage).toBe('plain failure');

    const [objectRecord] = captureLogs(() => {
      logBackendError('generation_failed', { error: { message: 'supabase rpc failed' } });
    });
    expect(objectRecord.errorMessage).toBe('supabase rpc failed');
  });

  it('redacts sensitive field names instead of logging their values', () => {
    const [record] = captureLogs(() => {
      logBackendInfo('provider_called', {
        apiKey: 'kie-live-secret',
        authorization: 'Bearer abc.def',
        serviceRoleKey: 'super-secret',
        webhookSignature: 'deadbeef',
        userPassword: 'hunter2',
        model: 'seedance-2',
      });
    });

    expect(record.apiKey).toBe('[redacted]');
    expect(record.authorization).toBe('[redacted]');
    expect(record.serviceRoleKey).toBe('[redacted]');
    expect(record.webhookSignature).toBe('[redacted]');
    expect(record.userPassword).toBe('[redacted]');
    expect(record.model).toBe('seedance-2');
    expect(JSON.stringify(record)).not.toContain('kie-live-secret');
    expect(JSON.stringify(record)).not.toContain('hunter2');
  });

  it('redacts sensitive keys nested inside objects', () => {
    const [record] = captureLogs(() => {
      logBackendInfo('provider_called', {
        request: { model: 'seedance-2', headers: { authorization: 'Bearer leak' } },
      });
    });

    expect(JSON.stringify(record)).not.toContain('Bearer leak');
    expect(JSON.stringify(record)).toContain('[redacted]');
  });

  it('truncates oversized strings so one log line cannot flood the drain', () => {
    const [record] = captureLogs(() => {
      logBackendInfo('prompt_received', { prompt: 'x'.repeat(5_000) });
    });

    expect(String(record.prompt).length).toBeLessThan(1_100);
    expect(String(record.prompt)).toContain('[+4000]');
  });

  it('caps array length', () => {
    const [record] = captureLogs(() => {
      logBackendInfo('batch_processed', { ids: Array.from({ length: 50 }, (_, index) => index) });
    });

    expect(Array.isArray(record.ids)).toBe(true);
    expect((record.ids as unknown[]).length).toBe(21);
    expect((record.ids as unknown[])[20]).toBe('[+30 more]');
  });

  it('drops undefined fields but keeps null', () => {
    const [record] = captureLogs(() => {
      logBackendInfo('generation_started', { missing: undefined, explicitlyEmpty: null });
    });

    expect(record).not.toHaveProperty('missing');
    expect(record.explicitlyEmpty).toBeNull();
  });

  it('rejects an event name that is not stable snake_case', () => {
    const records = captureLogs(() => {
      logBackendEvent('info', 'generation started for user 42');
    });

    expect(records).toHaveLength(1);
    expect(records[0].msg).toBe('backend_log_invalid_event_name');
    expect(records[0].level).toBe('error');
  });

  it('never throws when a field cannot be serialized', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => {
      captureLogs(() => {
        logBackendInfo('generation_started', { circular });
      });
    }).not.toThrow();
  });

  it('binds context on a child logger', () => {
    const records = captureLogs(() => {
      const logger = createBackendLogger({ jobName: 'generation-completions' });
      logger.info('job_started');
      logger.child({ predictionId: 'task-9' }).warn('job_retrying', { attempt: 2 });
    });

    expect(records[0].jobName).toBe('generation-completions');
    expect(records[1].jobName).toBe('generation-completions');
    expect(records[1].predictionId).toBe('task-9');
    expect(records[1].attempt).toBe(2);
    expect(records[1].level).toBe('warn');
  });

  it('routes levels to the matching console method', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      logBackendError('generation_failed');
      logBackendEvent('warn', 'generation_slow');
      logBackendInfo('generation_started');

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(() => JSON.parse(errorSpy.mock.calls[0][0] as string)).not.toThrow();
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
