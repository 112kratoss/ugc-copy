#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';

const options = { input: null, out: null, config: 'config/certification-resource-slos.json' };
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  const value = process.argv[index + 1];
  if (argument === '--in') { options.input = value; index += 1; }
  else if (argument === '--out') { options.out = value; index += 1; }
  else if (argument === '--config') { options.config = value; index += 1; }
}
if (!options.input) {
  console.error('--in resources.jsonl is required.');
  process.exit(1);
}

const [raw, configRaw] = await Promise.all([
  readFile(options.input, 'utf8'),
  readFile(options.config, 'utf8'),
]);
const config = JSON.parse(configRaw);
const samples = raw.split(/\r?\n/).filter(Boolean).map((line, index) => {
  try { return JSON.parse(line); }
  catch { throw new Error(`Invalid JSON on resource sample line ${index + 1}`); }
});

const checks = [];
const add = (name, passed, observed, required) => checks.push({ name, passed, observed, required });
const max = (field) => Math.max(...samples.map((sample) => Number(sample[field] ?? 0)));
const counterDelta = (field) => samples.length < 2
  ? null
  : Math.max(0, Number(samples.at(-1)?.[field] ?? 0) - Number(samples[0]?.[field] ?? 0));

add('minimum_samples', samples.length >= config.minSamples, samples.length, `>= ${config.minSamples}`);
add('sampler_failures', samples.every((sample) => Number(sample.sampleFailures ?? 0) === 0), max('sampleFailures'), '0');
add('sample_gap', samples.slice(1).every((sample) => Number(sample.sampleGapSeconds) <= config.maxSampleGapSeconds), max('sampleGapSeconds'), `<= ${config.maxSampleGapSeconds}s`);
add('track_io_timing', !config.requireTrackIoTiming || samples.every((sample) => sample.trackIoTiming === true), samples.filter((sample) => sample.trackIoTiming !== true).length, 'all samples true');
add('pool_absolute_max', max('poolUsedPct') <= config.maxPoolUsedPct, max('poolUsedPct'), `<= ${config.maxPoolUsedPct}%`);
add('idle_in_transaction', max('idleInTransaction') <= config.maxIdleInTransaction, max('idleInTransaction'), `<= ${config.maxIdleInTransaction}`);
add('lock_waiters', max('lockWaiters') <= config.maxLockWaiters, max('lockWaiters'), `<= ${config.maxLockWaiters}`);
add('ungranted_locks', max('ungrantedLocks') <= config.maxUngrantedLocks, max('ungrantedLocks'), `<= ${config.maxUngrantedLocks}`);
add('deadlocks_delta', (counterDelta('deadlocks') ?? Infinity) <= config.maxDeadlocksDelta, counterDelta('deadlocks'), `<= ${config.maxDeadlocksDelta}`);
add('temp_bytes_delta', (counterDelta('tempBytes') ?? Infinity) <= config.maxTempBytesDelta, counterDelta('tempBytes'), `<= ${config.maxTempBytesDelta}`);

const queueFields = {
  completion: ['completionOldestDueSeconds', 'completionDue'],
  workflow: ['workflowOldestDueSeconds', 'workflowStepsDue'],
  template: ['templateOldestDueSeconds', 'templateDue'],
  outputImport: ['outputImportOldestDueSeconds', 'outputImportDue'],
  rendition: ['renditionOldestSeconds', 'renditionOpen'],
};
for (const [name, [ageField, countField]] of Object.entries(queueFields)) {
  const ageLimit = config.maxQueueAgeSeconds[name];
  add(`${name}_queue_age`, max(ageField) <= ageLimit, max(ageField), `<= ${ageLimit}s`);
  if (config.requireFinalQueueDrain) {
    const baseline = Number(samples[0]?.[countField] ?? 0);
    const final = Number(samples.at(-1)?.[countField] ?? 0);
    add(`${name}_queue_drained`, final <= baseline, `${final} final / ${baseline} baseline`, 'final <= baseline');
  }
}

const retentionAges = samples.flatMap((sample) => (
  Array.isArray(sample.feedRetention)
    ? sample.feedRetention.map((entry) => entry.oldestRowAgeDays).filter(Number.isFinite)
    : []
));
const maxRetentionAge = retentionAges.length > 0 ? Math.max(...retentionAges) : null;
add(
  'feed_retention_lag',
  maxRetentionAge !== null && maxRetentionAge <= config.maxFeedRetentionAgeDays,
  maxRetentionAge,
  `<= ${config.maxFeedRetentionAgeDays} days`,
);

const report = {
  configVersion: config.version,
  input: options.input,
  sampleCount: samples.length,
  passed: checks.every((check) => check.passed),
  counterDeltas: {
    deadlocks: counterDelta('deadlocks'),
    tempBytes: counterDelta('tempBytes'),
    walBytes: counterDelta('walBytes'),
    walRecords: counterDelta('walRecords'),
    checkpoints: counterDelta('checkpoints'),
    databaseBytes: counterDelta('databaseBytes'),
  },
  checks,
};

const rendered = `${JSON.stringify(report, null, 2)}\n`;
if (options.out) await writeFile(options.out, rendered);
process.stdout.write(rendered);
if (!report.passed) process.exitCode = 1;
