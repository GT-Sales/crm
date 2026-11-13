import writeXlsxFile, {
  type Feature,
  type Image,
  type Row,
  type Sheet,
} from 'write-excel-file/node';
import { findElement, getCellAddress, getSelfClosingTagMarkup } from 'write-excel-file/utility';

import type { ExportCell } from './cells.js';

/**
 * The export's workbook: one sheet per lead type, each with a bold header row
 * that stays in view (frozen) and filters (auto-filter), column widths that
 * fit what the columns hold, and every cell written as its own type. Built
 * with `write-excel-file` (MIT, one dependency, `fflate`); the auto-filter is
 * the one thing it does not write itself, so `autoFilter` adds the element.
 */

/** What the Node build of the writer takes as a file (an image's bytes); these sheets hold none. */
type FileContent = Image['content'];

export interface ExportColumn {
  label: string;
}

export interface ExportSheet {
  /** The sheet's tab: the lead type's label. */
  name: string;
  columns: readonly ExportColumn[];
  rows: readonly (readonly ExportCell[])[];
}

/** Dates and money as Excel shows them; `yyyy-mm-dd` reads the same in every locale. */
const DATE_FORMAT = 'yyyy-mm-dd';
const DATE_TIME_FORMAT = 'yyyy-mm-dd hh:mm';
const MONEY_FORMAT = '#,##0.00';

const MIN_WIDTH = 10;
const MAX_WIDTH = 50;
/** Rows read for a column's width: enough to be right, not the whole sheet. */
const WIDTH_SAMPLE_ROWS = 500;

/** A sheet name Excel accepts: at most 31 characters, none of `[]:*?/\`, not blank, unique. */
export function sheetNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    const base =
      name
        .replace(/[[\]:*?/\\]/g, ' ')
        .replace(/^'+|'+$/g, '')
        .trim()
        .slice(0, 31) || 'Leads';
    let candidate = base;
    for (let suffix = 2; used.has(candidate.toLowerCase()); suffix += 1) {
      const tail = ` (${suffix})`;
      candidate = `${base.slice(0, 31 - tail.length)}${tail}`;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

function cellWidth(cell: ExportCell): number {
  if (cell === null) return 0;
  switch (cell.type) {
    case 'text':
      // The longest line of a multi-line value (an address).
      return Math.max(...cell.value.split('\n').map((line) => line.length));
    case 'number':
      return String(cell.value).length;
    case 'money':
      return cell.value.toFixed(2).length + 2;
    case 'date':
      return DATE_FORMAT.length;
    case 'dateTime':
      return DATE_TIME_FORMAT.length;
  }
}

function columnWidths(sheet: ExportSheet): { width: number }[] {
  return sheet.columns.map((column, index) => {
    let widest = column.label.length + 3;
    for (const row of sheet.rows.slice(0, WIDTH_SAMPLE_ROWS)) {
      widest = Math.max(widest, cellWidth(row[index] ?? null) + 2);
    }
    return { width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, widest)) };
  });
}

function toRow(cells: readonly ExportCell[]): Row {
  return cells.map((cell) => {
    if (cell === null) return null;
    switch (cell.type) {
      // `type: String` is what keeps `0012` and `+1 604…` text: never a number, never a formula.
      case 'text':
        return {
          value: cell.value,
          type: String,
          ...(cell.value.includes('\n') ? { wrap: true } : {}),
        };
      case 'number':
        return { value: cell.value, type: Number };
      case 'money':
        return { value: cell.value, type: Number, format: MONEY_FORMAT };
      case 'date':
        return { value: cell.value, type: Date, format: DATE_FORMAT };
      case 'dateTime':
        return { value: cell.value, type: Date, format: DATE_TIME_FORMAT };
    }
  });
}

/**
 * `<autoFilter ref="A1:…"/>` on every sheet, over the header and its rows.
 * The element must follow `</sheetData>` directly (the schema's order:
 * sheetData, sheetProtection, autoFilter, mergeCells, …; this writer emits
 * neither sheet protection nor merged cells for these sheets).
 */
function autoFilter(sheets: readonly ExportSheet[]): Feature<FileContent> {
  return {
    files: {
      transform: {
        'xl/worksheets/sheet{id}.xml': {
          transform(xml, _options, { sheetIndex }) {
            const sheet = sheets[sheetIndex];
            if (!sheet || sheet.columns.length === 0) return xml;
            if (findElement(xml, 'autoFilter')) return xml;
            const close = '</sheetData>';
            const at = xml.indexOf(close);
            if (at === -1) return xml;
            const ref = `A1:${getCellAddress(sheet.rows.length, sheet.columns.length - 1)}`;
            const end = at + close.length;
            return `${xml.slice(0, end)}${getSelfClosingTagMarkup('autoFilter', { ref })}${xml.slice(end)}`;
          },
        },
      },
    },
  };
}

/** The `.xlsx` bytes of the given sheets (at least one). */
export async function buildLeadWorkbook(sheets: readonly ExportSheet[]): Promise<Buffer> {
  if (sheets.length === 0) throw new Error('a workbook needs a sheet');
  const names = sheetNames(sheets.map((sheet) => sheet.name));
  const data: Sheet<FileContent>[] = sheets.map((sheet, index) => ({
    sheet: names[index] ?? `Sheet ${index + 1}`,
    data: [
      sheet.columns.map((column) => ({
        value: column.label,
        type: String,
        fontWeight: 'bold' as const,
      })),
      ...sheet.rows.map(toRow),
    ],
    columns: columnWidths(sheet),
    stickyRowsCount: 1,
  }));
  return writeXlsxFile(data, { features: [autoFilter(sheets)] }).toBuffer();
}
