#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';

const options = {
  config: 'config/certification-capacity-model.json',
  sustainableRps: null,
  providerGenerationsPerDay: null,
  mediaGenerationsPerDay: null,
  factsPerSession: null,
  anonymousExcluded: false,
  out: null,
};
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  const value = process.argv[index + 1];
  if (argument === '--config') { options.config = value; index += 1; }
  else if (argument === '--sustainable-rps') { options.sustainableRps = Number(value); index += 1; }
  else if (argument === '--provider-generations-per-day') { options.providerGenerationsPerDay = Number(value); index += 1; }
  else if (argument === '--media-generations-per-day') { options.mediaGenerationsPerDay = Number(value); index += 1; }
  else if (argument === '--facts-per-session') { options.factsPerSession = Number(value); index += 1; }
  else if (argument === '--anonymous-excluded') options.anonymousExcluded = true;
  else if (argument === '--out') { options.out = value; index += 1; }
}

for (const [name, value] of Object.entries({
  sustainableRps: options.sustainableRps,
  providerGenerationsPerDay: options.providerGenerationsPerDay,
  mediaGenerationsPerDay: options.mediaGenerationsPerDay,
  factsPerSession: options.factsPerSession,
})) {
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} must be a positive measured value.`);
    process.exit(1);
  }
}

const config = JSON.parse(await readFile(options.config, 'utf8'));
const headroomMultiplier = 1 - config.headroomFraction;
const sustainableRpsAfterHeadroom = options.sustainableRps * headroomMultiplier;
const providerDailyAfterHeadroom = options.providerGenerationsPerDay * headroomMultiplier;
const mediaDailyAfterHeadroom = options.mediaGenerationsPerDay * headroomMultiplier;
const retentionRowsAfterHeadroom = config.feedFactPruneRowsPerDay * headroomMultiplier;

const scenarios = Object.fromEntries(Object.entries(config.scenarios).map(([name, scenario]) => {
  const computeMau = sustainableRpsAfterHeadroom * 86400
    / (scenario.peakToAverageFactor * scenario.dauMauRatio * scenario.authenticatedOperationsPerDau);
  const retentionMau = retentionRowsAfterHeadroom
    / (scenario.dauMauRatio * scenario.feedSessionsPerDau * options.factsPerSession);
  const providerMau = providerDailyAfterHeadroom * 30 / config.generationsPerMauPerMonth;
  const mediaMau = mediaDailyAfterHeadroom * 30 / config.generationsPerMauPerMonth;
  const ceilings = { computeMau, retentionMau, providerMau, mediaMau };
  return [name, {
    assumptions: scenario,
    ceilings: Object.fromEntries(Object.entries(ceilings).map(([key, value]) => [key, Math.floor(value)])),
    conservativeMau: Math.floor(Math.min(...Object.values(ceilings))),
    limitingDimension: Object.entries(ceilings).sort((left, right) => left[1] - right[1])[0][0],
  }];
}));

const report = {
  modelVersion: config.version,
  claimable: true,
  scope: options.anonymousExcluded ? 'authenticated product mix only' : 'declared full traffic mix',
  anonymousExcluded: options.anonymousExcluded,
  certifiedOperationShare: options.anonymousExcluded
    ? Number((1 - config.productionAnonymousOperationShare).toFixed(4))
    : 1,
  warning: options.anonymousExcluded
    ? 'Anonymous capacity was not measured and is excluded from the MAU claim; no upward normalization was inferred.'
    : null,
  measuredInputs: {
    sustainableRps: options.sustainableRps,
    providerGenerationsPerDay: options.providerGenerationsPerDay,
    mediaGenerationsPerDay: options.mediaGenerationsPerDay,
    factsPerSession: options.factsPerSession,
  },
  headroomFraction: config.headroomFraction,
  afterHeadroom: {
    sustainableRps: Number(sustainableRpsAfterHeadroom.toFixed(3)),
    providerGenerationsPerDay: Number(providerDailyAfterHeadroom.toFixed(2)),
    mediaGenerationsPerDay: Number(mediaDailyAfterHeadroom.toFixed(2)),
    feedFactPruneRowsPerDay: Math.floor(retentionRowsAfterHeadroom),
  },
  scenarios,
};

const rendered = `${JSON.stringify(report, null, 2)}\n`;
if (options.out) await writeFile(options.out, rendered);
process.stdout.write(rendered);
