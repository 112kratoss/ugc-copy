import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const progressPath = path.join(process.cwd(), 'docs', 'backend-idealization-progress.md');
const progress = fs.readFileSync(progressPath, 'utf8');

function getSection(heading: string, nextHeading: string) {
  const start = progress.indexOf(`## ${heading}`);
  const end = progress.indexOf(`## ${nextHeading}`, start + 1);

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return progress.slice(start, end);
}

function countChecklistItems(section: string, marker: 'x' | ' ') {
  return section.match(new RegExp(`^- \\[${marker}\\]`, 'gm'))?.length ?? 0;
}

describe('backend idealization progress tracker', () => {
  it('keeps the displayed completion percentage synchronized with the checklist', () => {
    const completedCount = countChecklistItems(
      getSection('Completed Locally', 'In Progress'),
      'x',
    );
    const activeWorkstreamCount = countChecklistItems(
      getSection('In Progress', 'Remaining Before We Can Call This Ideal'),
      ' ',
    );
    const openGateCount = countChecklistItems(
      getSection('Remaining Before We Can Call This Ideal', 'Change History'),
      ' ',
    );
    const expectedPercentage = Number(
      ((completedCount / (completedCount + openGateCount)) * 100).toFixed(1),
    );

    const displayedPercentage = progress.match(/\*\*Total completion: ([0-9]+(?:\.[0-9]+)?)%\*\*/);
    const displayedCompleted = progress.match(/Completed milestones: \*\*(\d+)\*\*/);
    const displayedOpen = progress.match(/Open completion gates: \*\*(\d+)\*\*/);
    const displayedActive = progress.match(/Active workstreams: \*\*(\d+)\*\*/);

    expect(Number(displayedPercentage?.[1])).toBe(expectedPercentage);
    expect(Number(displayedCompleted?.[1])).toBe(completedCount);
    expect(Number(displayedOpen?.[1])).toBe(openGateCount);
    expect(Number(displayedActive?.[1])).toBe(activeWorkstreamCount);
  });
});
