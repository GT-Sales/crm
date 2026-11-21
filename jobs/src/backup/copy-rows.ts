/**
 * Row counts per table, read from the data dump itself, so the manifest records
 * what the archive actually holds and a restore can compare its own counts.
 *
 * pg_dump with `--quote-all-identifiers` opens each table's data with
 * `COPY "schema"."table" (columns) FROM stdin;` and closes it with a `\.` line.
 * In COPY text format an embedded newline is written as `\n`, so every line in
 * between is exactly one row. Anything the counter does not recognise fails
 * loudly instead of producing a wrong count.
 */

const COPY_LINE = /^COPY .* FROM stdin;$/;
const QUOTED_COPY_LINE = /^COPY "((?:[^"]|"")+)"\."((?:[^"]|"")+)"(?: \(.*\))? +FROM stdin;$/;
const TERMINATOR = '\\.';

const unquote = (identifier: string) => identifier.replaceAll('""', '"');

export function countCopyRows(dataSql: string): Record<string, number> {
  const counts: Record<string, number> = {};
  let table: string | undefined;
  for (const line of dataSql.split(/\r?\n/)) {
    if (table !== undefined) {
      if (line === TERMINATOR) table = undefined;
      else counts[table] = (counts[table] ?? 0) + 1;
      continue;
    }
    if (!COPY_LINE.test(line)) continue;
    const match = QUOTED_COPY_LINE.exec(line);
    const schema = match?.[1];
    const name = match?.[2];
    if (schema === undefined || name === undefined) {
      throw new Error(`copy_block_unrecognized:${line}`);
    }
    table = `${unquote(schema)}.${unquote(name)}`;
    counts[table] = counts[table] ?? 0;
  }
  if (table !== undefined) throw new Error(`copy_block_unterminated:${table}`);
  return counts;
}

const COLUMN_LIST = /^COPY "(?:[^"]|"")+"\."(?:[^"]|"")+" \((.*)\) +FROM stdin;$/;
const QUOTED_COLUMN = /^"((?:[^"]|"")+)"$/;

/** One COPY text field: `\N` is null, backslash escapes are decoded (`\t`, `\\`, octal, `\x`). */
function decodeCopyField(field: string): string | null {
  if (field === '\\N') return null;
  if (!field.includes('\\')) return field;
  return field.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/g, (_, escape: string) => {
    if (escape.startsWith('x') && escape.length > 1) {
      return String.fromCharCode(parseInt(escape.slice(1), 16));
    }
    if (/^[0-7]+$/.test(escape)) return String.fromCharCode(parseInt(escape, 8));
    switch (escape) {
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'v':
        return '\v';
      default:
        return escape;
    }
  });
}

/**
 * The rows of one table's COPY block in the data dump, each by its column
 * names, or undefined when the dump holds no block for `schema.table`. A row
 * whose field count does not match the column list fails loudly. The backup
 * reads its document list from here so the list and the dump are one
 * snapshot (#86).
 */
export function readCopyTable(
  dataSql: string,
  table: string,
): Array<Record<string, string | null>> | undefined {
  let columns: string[] | undefined;
  let rows: Array<Record<string, string | null>> | undefined;
  let inside = false;
  for (const line of dataSql.split(/\r?\n/)) {
    if (inside) {
      if (line === TERMINATOR) {
        inside = false;
        columns = undefined;
        continue;
      }
      if (!columns || !rows) continue;
      const fields = line.split('\t');
      if (fields.length !== columns.length) throw new Error(`copy_row_malformed:${table}`);
      const names = columns;
      rows.push(Object.fromEntries(fields.map((field, i) => [names[i], decodeCopyField(field)])));
      continue;
    }
    if (!COPY_LINE.test(line)) continue;
    inside = true;
    const match = QUOTED_COPY_LINE.exec(line);
    if (!match?.[1] || !match[2] || `${unquote(match[1])}.${unquote(match[2])}` !== table) continue;
    const list = COLUMN_LIST.exec(line)?.[1];
    if (list === undefined) throw new Error(`copy_block_unrecognized:${line}`);
    columns = list.split(', ').map((column) => {
      const name = QUOTED_COLUMN.exec(column)?.[1];
      if (name === undefined) throw new Error(`copy_block_unrecognized:${line}`);
      return unquote(name);
    });
    rows = rows ?? [];
  }
  return rows;
}
