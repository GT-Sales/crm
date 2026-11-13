'use client';

import { useId, useMemo, useState } from 'react';
import {
  LEAD_EXPORT_MAX_IDS,
  LEAD_EXPORT_MAX_ROWS,
  leadExportFileName,
  leadExportGroups,
  type ExportLeadsRequest,
  type LeadExportAccess,
  type LeadExportField,
  type LeadExportFilter,
  type PropertyCatalog,
} from '@gt-sales/contracts';
import {
  Button,
  Checkbox,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@gt-sales/ui';
import { DownloadIcon, LoaderCircleIcon } from 'lucide-react';

import { BackendError, exportLeads } from '../../lib/api';
import { todayDay } from '../../lib/dates';
import { saveBlob } from '../../lib/download';
import { describeError } from '../../lib/error-text';
import { errorReason } from '../../lib/use-resource';

const count = new Intl.NumberFormat('en-CA');

/** Where this browser keeps the fields last exported, per site and lead type. */
export function exportFieldsStorageKey(workspaceId: string, leadType: string | undefined): string {
  return `gt-export-fields:${workspaceId}:${leadType ?? 'all'}`;
}

/** The remembered choice, or `undefined` when there is none (or storage cannot be read). */
function readRememberedFields(key: string): string[] | undefined {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return undefined;
    const saved: unknown = JSON.parse(raw);
    return Array.isArray(saved)
      ? saved.filter((entry): entry is string => typeof entry === 'string')
      : undefined;
  } catch {
    return undefined;
  }
}

function rememberFields(key: string, fields: readonly string[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(fields));
  } catch {
    // Not remembered; the export itself is unaffected.
  }
}

/** What a refused or failed export says to the person who asked for it. */
function exportFailure(error: unknown): string {
  const reason = errorReason(error);
  if (reason === 'export_too_large') {
    const total = error instanceof BackendError ? error.details?.['total'] : undefined;
    const lead =
      typeof total === 'number'
        ? `That is ${count.format(total)} leads.`
        : 'That is too many leads.';
    return `${lead} One export holds at most ${count.format(LEAD_EXPORT_MAX_ROWS)}: narrow the filters or tick fewer leads.`;
  }
  if (reason === 'rate_limited') return 'Too many exports just now. Try again in a few minutes.';
  if (reason === 'permission_denied') {
    return "You don't have permission to export leads. Ask the owner to give your role access.";
  }
  if (reason === 'lead_not_found') {
    return 'Some ticked leads are no longer available. Reload the list and try again.';
  }
  return describeError(error, 'export the leads');
}

interface PickerGroup {
  key: string;
  label: string;
  hint?: string;
  fields: readonly LeadExportField[];
}

export interface LeadExportDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  workspaceId: string;
  workspaceSlug: string;
  accessToken: string;
  catalog: PropertyCatalog;
  /** The open tab's lead type; undefined on "All leads" and in the archive. */
  leadType: string | undefined;
  /** The lead types the export may hold: the tab's, or every type the site has. */
  leadTypes: readonly string[];
  access: LeadExportAccess;
  /** The ticked leads, none when nothing is ticked. */
  selectedIds: readonly string[];
  /** The list's own filters, for "all leads matching". */
  filter: LeadExportFilter;
  /** How many leads match the filters, when the list has said. */
  matchingTotal: number | undefined;
  /** The export fields of the columns the table shows now: pre-ticked. */
  tableFields: readonly string[];
  onExported?(result: { rowCount: number | undefined; fileName: string }): void;
}

/**
 * Export leads to Excel: which leads (the ticked ones, or every lead matching
 * the list's filters, all pages) and which fields. The main fields are always
 * in the file; the rest are ticked group by group, the columns the table
 * shows first and already ticked. The last choice is remembered in this
 * browser per site and lead type. The file is made by the backend, which
 * leaves out anything the viewer's role may not see.
 */
export function LeadExportDialog(props: LeadExportDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="flex max-h-[calc(100svh-2rem)] flex-col gap-0 p-0 sm:max-w-2xl">
        {/* Mounted with the dialog, so each opening starts from the defaults or the remembered choice. */}
        {props.open ? <ExportForm {...props} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function ExportForm({
  onOpenChange,
  workspaceId,
  workspaceSlug,
  accessToken,
  catalog,
  leadType,
  leadTypes,
  access,
  selectedIds,
  filter,
  matchingTotal,
  tableFields,
  onExported,
}: LeadExportDialogProps) {
  const id = useId();
  const storageKey = exportFieldsStorageKey(workspaceId, leadType);

  const { main, groups, optionalKeys } = useMemo(() => {
    const all = leadExportGroups({ catalog, leadTypes, access });
    const mainFields = all.find((group) => group.key === 'main')?.fields ?? [];
    const optional = all.filter((group) => group.key !== 'main');
    const inTable = new Set(tableFields);
    const shown = optional
      .flatMap((group) => group.fields)
      .filter((field) => inTable.has(field.key));
    const picker: PickerGroup[] = [
      ...(shown.length > 0
        ? [{ key: 'table', label: 'Columns shown in the table', fields: shown }]
        : []),
      ...optional.flatMap((group) => {
        const fields = group.fields.filter((field) => !inTable.has(field.key));
        if (fields.length === 0) return [];
        return [
          {
            key: group.key,
            label: group.label,
            ...(group.key === 'form' && leadTypes.length > 1
              ? { hint: 'Each lead type gets its own sheet, with the fields it has.' }
              : {}),
            fields,
          },
        ];
      }),
    ];
    return {
      main: mainFields,
      groups: picker,
      optionalKeys: picker.flatMap((group) => group.fields.map((field) => field.key)),
    };
  }, [catalog, leadTypes, access, tableFields]);

  const defaults = useMemo(
    () => groups.find((group) => group.key === 'table')?.fields.map((field) => field.key) ?? [],
    [groups],
  );
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => {
    const remembered = readRememberedFields(storageKey);
    const offered = new Set(optionalKeys);
    return new Set(remembered ? remembered.filter((key) => offered.has(key)) : defaults);
  });
  const hasSelection = selectedIds.length > 0;
  const [scope, setScope] = useState<'selected' | 'matching'>(
    hasSelection ? 'selected' : 'matching',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const total = scope === 'selected' ? selectedIds.length : matchingTotal;
  const problem =
    scope === 'selected' && selectedIds.length > LEAD_EXPORT_MAX_IDS
      ? `You can export up to ${count.format(LEAD_EXPORT_MAX_IDS)} ticked leads at a time. Choose all leads matching the filters instead.`
      : total !== undefined && total > LEAD_EXPORT_MAX_ROWS
        ? `One export holds at most ${count.format(LEAD_EXPORT_MAX_ROWS)} leads. Narrow the filters first.`
        : total === 0
          ? 'There are no leads to export.'
          : undefined;

  function toggle(key: string, on: boolean) {
    setTicked((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }
  function setGroup(group: PickerGroup, on: boolean) {
    setTicked((current) => {
      const next = new Set(current);
      for (const field of group.fields) {
        if (on) next.add(field.key);
        else next.delete(field.key);
      }
      return next;
    });
  }

  async function runExport() {
    if (busy || problem) return;
    const fields = optionalKeys.filter((key) => ticked.has(key));
    const body: ExportLeadsRequest = {
      scope:
        scope === 'selected' ? { kind: 'ids', ids: [...selectedIds] } : { kind: 'filter', filter },
      fields,
    };
    rememberFields(storageKey, fields);
    setBusy(true);
    setError(undefined);
    try {
      const file = await exportLeads(accessToken, workspaceId, body);
      const fileName =
        file.fileName ??
        leadExportFileName({
          siteSlug: workspaceSlug,
          leadType: leadTypes.length === 1 ? leadTypes[0] : undefined,
          day: todayDay(),
        });
      saveBlob(file.blob, fileName);
      onExported?.({ rowCount: file.rowCount, fileName });
      onOpenChange(false);
    } catch (caught) {
      setError(exportFailure(caught));
    } finally {
      setBusy(false);
    }
  }

  const matchingLabel = `All leads matching the current filters${
    matchingTotal === undefined ? '' : ` (${count.format(matchingTotal)})`
  }`;

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        void runExport();
      }}
    >
      <DialogHeader className="border-b px-5 py-4 pr-12 text-left">
        <DialogTitle>Export leads to Excel</DialogTitle>
        <DialogDescription>
          Choose which leads and which fields go into the .xlsx file.
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Leads</legend>
          {hasSelection ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  ['selected', `Selected leads (${count.format(selectedIds.length)})`],
                  ['matching', matchingLabel],
                ] as const
              ).map(([value, label]) => (
                <label
                  key={value}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
                    scope === value ? 'border-primary bg-primary/5' : 'hover:bg-muted/60',
                  )}
                >
                  <input
                    type="radio"
                    name={`${id}-scope`}
                    value={value}
                    checked={scope === value}
                    disabled={busy}
                    onChange={() => setScope(value)}
                    className="size-4 accent-primary"
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          ) : (
            <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm">{matchingLabel}</p>
          )}
          <p className="text-xs text-muted-foreground">
            Every page of the list is included, not only the one on screen.
          </p>
        </fieldset>

        <section aria-labelledby={`${id}-main`} className="space-y-2">
          <div className="flex items-baseline justify-between gap-3">
            <h3 id={`${id}-main`} className="text-sm font-medium">
              Main fields
            </h3>
            <span className="text-xs text-muted-foreground">Always included</span>
          </div>
          <ul className="flex flex-wrap gap-1.5">
            {main.map((field) => (
              <li
                key={field.key}
                className="rounded-full border bg-muted/50 px-2.5 py-1 text-xs text-muted-foreground"
              >
                {field.label}
              </li>
            ))}
          </ul>
        </section>

        {groups.map((group) => {
          const on = group.fields.filter((field) => ticked.has(field.key)).length;
          const heading = `${id}-${group.key}`;
          return (
            <section key={group.key} aria-labelledby={heading} className="space-y-2 border-t pt-4">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h3 id={heading} className="text-sm font-medium">
                  {group.label}
                </h3>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {on} of {group.fields.length}
                </span>
                <span className="ml-auto flex items-center gap-1 text-xs">
                  <button
                    type="button"
                    aria-label={`Select all: ${group.label}`}
                    disabled={busy || on === group.fields.length}
                    onClick={() => setGroup(group, true)}
                    className="rounded px-1.5 py-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    Select all
                  </button>
                  <span aria-hidden="true" className="text-border">
                    /
                  </span>
                  <button
                    type="button"
                    aria-label={`Select none: ${group.label}`}
                    disabled={busy || on === 0}
                    onClick={() => setGroup(group, false)}
                    className="rounded px-1.5 py-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    None
                  </button>
                </span>
              </div>
              {group.hint ? <p className="text-xs text-muted-foreground">{group.hint}</p> : null}
              <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
                {group.fields.map((field) => (
                  <label
                    key={field.key}
                    className="flex min-w-0 cursor-pointer items-center gap-2 py-0.5 text-sm"
                  >
                    <Checkbox
                      checked={ticked.has(field.key)}
                      disabled={busy}
                      onCheckedChange={(checked) => toggle(field.key, checked === true)}
                    />
                    <span className="truncate">{field.label}</span>
                  </label>
                ))}
              </div>
            </section>
          );
        })}
      </div>

      <DialogFooter className="gap-3 border-t px-5 py-3 sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 text-center text-sm sm:text-left">
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : problem ? (
            <p role="status" className="text-muted-foreground">
              {problem}
            </p>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => setTicked(new Set(defaults))}
              className="text-xs text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              Reset to the table’s columns
            </button>
          )}
        </div>
        <div className="flex w-full shrink-0 flex-col-reverse gap-2 sm:w-auto sm:flex-row">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={busy || problem !== undefined}>
            {busy ? (
              <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
            ) : (
              <DownloadIcon aria-hidden="true" />
            )}
            {busy ? 'Preparing file…' : 'Export'}
          </Button>
        </div>
      </DialogFooter>
    </form>
  );
}
