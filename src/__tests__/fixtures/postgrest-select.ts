/**
 * What PostgREST answers a `select` with, for a test's stand-in table: each named column,
 * `alias:column` under its alias, and a JSON path (`column->key->0->>key`) read step by step,
 * `->` keeping the value and `->>` giving it as text, under its alias or else its last key.
 * The stand-ins answered every select with whole rows, so a read that narrows to JSON paths
 * passed whatever paths it named; this answers it as the database would.
 */
function readPath(value: unknown, expression: string): unknown {
  const steps = expression.split(/(->>|->)/).filter(Boolean);
  let current: unknown = value;
  let asText = false;
  for (let index = 0; index < steps.length; index += 2) {
    const arrow = steps[index];
    const key = steps[index + 1];
    if (!key) break;
    asText = arrow === '->>';
    if (current === null || current === undefined || typeof current !== 'object') return null;
    current = Array.isArray(current) && /^\d+$/.test(key)
      ? current[Number(key)]
      : (current as Record<string, unknown>)[key];
  }
  if (current === undefined || current === null) return null;
  if (!asText) return current;
  return typeof current === 'string' ? current : JSON.stringify(current);
}

export function postgrestSelect(row: Record<string, unknown>, select: string): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of select.split(',').map((part) => part.trim()).filter(Boolean)) {
    if (field === '*') return { ...row };
    const colon = field.indexOf(':');
    const alias = colon >= 0 ? field.slice(0, colon) : null;
    const expression = colon >= 0 ? field.slice(colon + 1) : field;
    const arrow = expression.indexOf('->');
    if (arrow < 0) {
      projected[alias ?? expression] = row[expression] ?? null;
      continue;
    }
    const column = expression.slice(0, arrow);
    const keys = expression.slice(arrow).split(/->>|->/).filter(Boolean);
    projected[alias ?? keys[keys.length - 1]] = readPath(row[column], expression.slice(arrow));
  }
  return projected;
}
