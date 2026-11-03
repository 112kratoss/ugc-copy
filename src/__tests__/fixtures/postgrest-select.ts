/**
 * What PostgREST answers a `select` with, for a test's stand-in table: each named column,
 * `alias:column` under its alias, and a JSON path (`column->key->0->>key`) read step by step,
 * `->` keeping the value and `->>` giving it as text, under its alias or else its last key.
 * An embedded table (`alias:table!hint(columns)`) answers the stand-in row's own list under the
 * table's name, each entry narrowed to those columns, and `[]` where it has none, as a
 * one-to-many embed does. The stand-ins answered every select with whole rows, so a read that
 * narrows to JSON paths passed whatever paths it named; this answers it as the database would.
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

/** The select's fields, split at the commas outside an embed's parentheses. */
export function selectFields(select: string): string[] {
  const fields: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of select) {
    if (character === ',' && depth === 0) {
      fields.push(current);
      current = '';
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    current += character;
  }
  fields.push(current);
  return fields.map((field) => field.trim()).filter(Boolean);
}

/** An embedded table's field (`table!hint(columns)`): the table and the columns it selects. */
export function embeddedTable(expression: string): { table: string; columns: string } | null {
  const embed = /^([A-Za-z_][\w]*)(?:![\w]+)?\(([\s\S]*)\)$/.exec(expression);
  return embed ? { table: embed[1]!, columns: embed[2]! } : null;
}

export function postgrestSelect(row: Record<string, unknown>, select: string): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of selectFields(select)) {
    if (field === '*') return { ...row };
    const colon = field.indexOf(':');
    const alias = colon >= 0 && colon < field.search(/[(]|$/) ? field.slice(0, colon) : null;
    const expression = alias !== null ? field.slice(colon + 1) : field;
    const embed = embeddedTable(expression);
    if (embed) {
      const children = Array.isArray(row[embed.table]) ? row[embed.table] as Record<string, unknown>[] : [];
      projected[alias ?? embed.table] = children.map((child) => postgrestSelect(child, embed.columns));
      continue;
    }
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
