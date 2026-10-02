import type { SupabaseClient } from '@supabase/supabase-js';

type Row = Record<string, unknown>;
type Call = (args: Row) => unknown;

/** The filter the owner library route sends, word for word. Any other `or` is refused. */
const LIBRARY_FILTER = 'and(template_run_id.is.null,template_run_step_id.is.null),studio_visible.eq.true';

/**
 * Rows the real code can read the way it reads Postgres.
 *
 * A read answers with the columns it asked for and no others, so code that
 * needs a column has to select it. Asking for a column the table does not
 * have is refused, as PostgREST refuses it. Filters are applied, not just
 * recorded: a row a query would not return is not returned here.
 *
 * It covers the filters the generation jobs, the notifier and the owner
 * library route use, and nothing else. A filter it does not know throws, so
 * a query that changes shape is noticed rather than answered wrongly.
 */
export function createStoredRows(tables: Record<string, Row[]>, calls: Record<string, Call> = {}) {
  /** Every read, in order: the table and the columns it asked for. */
  const reads: Array<{ table: string; columns: string[] }> = [];
  /** Every database call, in order, by name. */
  const called: string[] = [];

  function rowsOf(table: string) {
    const rows = tables[table];
    if (!rows) throw new Error(`Unexpected table: ${table}`);
    return rows;
  }

  function filtered(table: string) {
    const tests: Array<(row: Row) => boolean> = [];
    let window: [number, number] | null = null;

    const filters = {
      eq(column: string, value: unknown) {
        tests.push((row) => row[column] === value);
        return this;
      },
      neq(column: string, value: unknown) {
        tests.push((row) => row[column] !== value);
        return this;
      },
      in(column: string, values: unknown[]) {
        tests.push((row) => values.includes(row[column]));
        return this;
      },
      is(column: string, value: null) {
        if (value !== null) throw new Error(`Unexpected is(${column}, ${String(value)})`);
        tests.push((row) => (row[column] ?? null) === null);
        return this;
      },
      not(column: string, operator: string, value: unknown) {
        if (operator !== 'is' || value !== null) throw new Error(`Unexpected not(${column}, ${operator})`);
        tests.push((row) => (row[column] ?? null) !== null);
        return this;
      },
      lt(column: string, value: string) {
        tests.push((row) => String(row[column]) < value);
        return this;
      },
      lte(column: string, value: string) {
        tests.push((row) => String(row[column]) <= value);
        return this;
      },
      or(expression: string) {
        if (expression !== LIBRARY_FILTER) throw new Error(`Unexpected filter: ${expression}`);
        tests.push((row) => (
          ((row.template_run_id ?? null) === null && (row.template_run_step_id ?? null) === null)
          || row.studio_visible === true
        ));
        return this;
      },
      order() {
        return this;
      },
      limit(count: number) {
        window = [0, count - 1];
        return this;
      },
      range(from: number, to: number) {
        window = [from, to];
        return this;
      },
    };

    function matching() {
      const matched = rowsOf(table).filter((row) => tests.every((test) => test(row)));
      return window ? matched.slice(window[0], window[1] + 1) : matched;
    }

    return { filters, matching };
  }

  function select(table: string, columns: string) {
    const asked = columns.split(',').map((column) => column.trim()).filter(Boolean);
    const known = rowsOf(table)[0];
    const unknown = known ? asked.filter((column) => column !== '*' && !(column in known)) : [];
    if (unknown.length) throw new Error(`column ${table}.${unknown[0]} does not exist`);
    reads.push({ table, columns: asked });

    const { filters, matching } = filtered(table);
    const answer = () => matching().map((row) => (
      asked.includes('*') ? { ...row } : Object.fromEntries(asked.map((column) => [column, row[column]]))
    ));

    return Object.assign(filters, {
      async single() {
        const found = answer();
        return found.length === 1
          ? { data: found[0], error: null }
          : { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
      },
      async maybeSingle() {
        return { data: answer()[0] ?? null, error: null };
      },
      then<T>(resolve: (value: { data: Row[]; error: null }) => T, reject?: (reason: unknown) => T) {
        return Promise.resolve({ data: answer(), error: null }).then(resolve, reject);
      },
    });
  }

  function update(table: string, values: Row) {
    const { filters, matching } = filtered(table);
    return Object.assign(filters, {
      then<T>(resolve: (value: { data: null; error: null }) => T, reject?: (reason: unknown) => T) {
        for (const row of matching()) Object.assign(row, values);
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      },
    });
  }

  const client = {
    from(table: string) {
      return {
        select: (columns: string) => select(table, columns),
        update: (values: Row) => update(table, values),
      };
    },
    async rpc(name: string, args: Row = {}) {
      const call = calls[name];
      if (!call) throw new Error(`Unexpected call: ${name}`);
      called.push(name);
      return { data: await call(args), error: null };
    },
  };

  return { client: client as unknown as SupabaseClient, reads, called };
}
