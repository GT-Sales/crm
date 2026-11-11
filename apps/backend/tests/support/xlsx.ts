import { strFromU8, unzipSync } from 'fflate';

/**
 * A small reader for the workbooks the export writes, so a test can open the
 * file it was given rather than trust the writer: the sheets by name, each
 * cell with its stored type, its number format and whether it is bold, and
 * the sheet's frozen pane, auto-filter and column widths. It reads the parts
 * a spreadsheet application reads (`xl/workbook.xml`, the shared strings, the
 * styles and each worksheet), independently of `write-excel-file`.
 */

export interface ReadCell {
  /** `s` a shared string, `str`/`inlineStr` a string, `n` a number (dates included), `b` a boolean. */
  type: string;
  /** The text of a string cell, or the stored number as text. */
  raw: string;
  /** The number format code (`General` when none): a date cell carries a date format. */
  format: string;
  bold: boolean;
  /** Whether the stored XML marks the cell as a formula; the export never writes one. */
  formula: boolean;
}

export interface ReadSheet {
  name: string;
  /** Rows by position; a missing cell is `undefined`. */
  rows: (ReadCell | undefined)[][];
  /** `ySplit` of a frozen pane, 0 when none. */
  frozenRows: number;
  autoFilter: string | undefined;
  widths: number[];
}

const decode = (value: string) =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');

const attribute = (tag: string, name: string): string | undefined =>
  new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag)?.[1];

function columnIndex(reference: string): number {
  const letters = /^[A-Z]+/.exec(reference)?.[0] ?? 'A';
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

const BUILT_IN_FORMATS: Record<number, string> = {
  0: 'General',
  14: 'mm-dd-yy',
  22: 'm/d/yy h:mm',
};

export function readXlsx(file: Uint8Array): ReadSheet[] {
  const parts = unzipSync(file);
  const part = (path: string): string => {
    const bytes = parts[path];
    if (!bytes) throw new Error(`the workbook has no ${path}`);
    return strFromU8(bytes);
  };

  const shared = parts['xl/sharedStrings.xml']
    ? [...part('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((entry) =>
        [...(entry[1] ?? '').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
          .map((text) => decode(text[1] ?? ''))
          .join(''),
      )
    : [];

  const styles = part('xl/styles.xml');
  const formats = new Map<number, string>(
    [...styles.matchAll(/<numFmt\s[^>]*>/g)].map((tag) => [
      Number(attribute(tag[0], 'numFmtId')),
      decode(attribute(tag[0], 'formatCode') ?? ''),
    ]),
  );
  const fonts = [
    ...(/<fonts[^>]*>([\s\S]*?)<\/fonts>/.exec(styles)?.[1] ?? '').matchAll(
      /<font>([\s\S]*?)<\/font>|<font\/>/g,
    ),
  ].map((font) => /<b\/>|<b\s/.test(font[1] ?? ''));
  const cellStyles = [
    ...(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '').matchAll(/<xf\s?[^>]*>/g),
  ].map((tag) => {
    const formatId = Number(attribute(tag[0], 'numFmtId') ?? 0);
    return {
      format: formats.get(formatId) ?? BUILT_IN_FORMATS[formatId] ?? 'General',
      bold: fonts[Number(attribute(tag[0], 'fontId') ?? 0)] ?? false,
    };
  });

  const workbook = part('xl/workbook.xml');
  const relationships = part('xl/_rels/workbook.xml.rels');
  const targets = new Map(
    [...relationships.matchAll(/<Relationship\s[^>]*>/g)].map((tag) => [
      attribute(tag[0], 'Id') ?? '',
      attribute(tag[0], 'Target') ?? '',
    ]),
  );

  return [...workbook.matchAll(/<sheet\s[^>]*>/g)].map((tag) => {
    const name = decode(attribute(tag[0], 'name') ?? '');
    const target = targets.get(attribute(tag[0], 'r:id') ?? '') ?? '';
    const xml = part(`xl/${target.replace(/^\//, '')}`);
    const rows: (ReadCell | undefined)[][] = [];
    for (const row of xml.matchAll(/<row\s[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: (ReadCell | undefined)[] = [];
      for (const cell of (row[1] ?? '').matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attributes = cell[1] ?? '';
        const body = cell[2] ?? '';
        const type = attribute(attributes, 't') ?? 'n';
        const stored = decode(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
        const inline = decode(
          /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/.exec(body)?.[1] ?? '',
        );
        const style = cellStyles[Number(attribute(attributes, 's') ?? 0)];
        cells[columnIndex(attribute(attributes, 'r') ?? 'A1')] = {
          type,
          raw:
            type === 's' ? (shared[Number(stored)] ?? '') : type === 'inlineStr' ? inline : stored,
          format: style?.format ?? 'General',
          bold: style?.bold ?? false,
          formula: /<f[\s>/]/.test(body),
        };
      }
      rows.push(cells);
    }
    const pane = /<pane\s[^>]*>/.exec(xml)?.[0];
    const filter = /<autoFilter\s[^>]*>/.exec(xml)?.[0];
    return {
      name,
      rows,
      frozenRows:
        pane && attribute(pane, 'state') === 'frozen' ? Number(attribute(pane, 'ySplit') ?? 0) : 0,
      autoFilter: filter ? attribute(filter, 'ref') : undefined,
      widths: [...xml.matchAll(/<col\s[^>]*>/g)].map((col) => Number(attribute(col[0], 'width'))),
    };
  });
}

/** A sheet's header row as text. */
export function headersOf(sheet: ReadSheet): string[] {
  return (sheet.rows[0] ?? []).map((cell) => cell?.raw ?? '');
}

/** One data row as `{ header: cell }`. */
export function rowByHeader(sheet: ReadSheet, index: number): Record<string, ReadCell | undefined> {
  const headers = headersOf(sheet);
  const row = sheet.rows[index + 1] ?? [];
  return Object.fromEntries(headers.map((header, column) => [header, row[column]]));
}

/** An Excel serial number as the UTC instant it stands for. */
export function serialToDate(serial: string | number): Date {
  return new Date(Math.round((Number(serial) - 25569) * 86_400_000));
}
