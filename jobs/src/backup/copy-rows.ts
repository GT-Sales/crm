/**
 * Row counts per table, read from the data dump itself, so the manifest records
 * what the archive actually holds and a restore can compare its own counts.
 *
 * pg_dump with `--quote-all-identifier` opens each table's data with
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
  for (const line of dataSql.split('\n')) {
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
