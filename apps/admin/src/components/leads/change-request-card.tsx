'use client';

import { useEffect, useRef, useState, type JSX } from 'react';
import {
  CUSTOMER_EMAIL_TEMPLATE_LABELS,
  codePropertyCatalog,
  formatPropertyValue,
  type ChangeDecisionEmailSkipped,
  type LeadDetail,
  type PropertyCatalog,
  type ResolveChangeRequestResponse,
  type SiteProperty,
  type StaffChangeRequest,
} from '@gt-sales/contracts';
import {
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@gt-sales/ui';
import { EyeIcon, FileTextIcon } from 'lucide-react';

import { dateTimeLabel, relativeTime } from '../../lib/dates';
import { describeError } from '../../lib/error-text';
import { errorReason } from '../../lib/use-resource';
import { documentLabel } from './lead-documents';
import { listText } from './stage-move-dialog';

/** The fields a customer may ask to change, in the order the table lists them. */
const FIELD_ORDER = [
  'fullName',
  'phone',
  'planId',
  'delivery',
  'arrivalDate',
  'permitType',
  'canadaAddress',
  'shippingAddress',
  'flightBooked',
] as const;
type FieldKey = (typeof FIELD_ORDER)[number];

/** The catalogue property a request key reads from (the order's plan is `plan`, not `planId`). */
const PROPERTY_KEY: Partial<Record<FieldKey, string>> = {
  planId: 'plan',
  delivery: 'delivery',
  arrivalDate: 'arrivalDate',
  permitType: 'permitType',
  canadaAddress: 'canadaAddress',
  shippingAddress: 'shippingAddress',
  flightBooked: 'flightBooked',
};

const ABSENT = '—';

function propertyFor(
  catalog: PropertyCatalog,
  leadType: string,
  key: string,
): SiteProperty | undefined {
  return (
    catalog.forType(leadType).find((entry) => entry.key === key) ??
    catalog.get(key) ??
    codePropertyCatalog.get(key)
  );
}

/** A stored or asked-for value as staff read it: plan by name, options by label, dates as dates. */
function valueText(property: SiteProperty | undefined, value: unknown): string {
  if (value === null || value === undefined || value === '') return ABSENT;
  if (property) {
    const text = formatPropertyValue(property, value);
    if (text !== '') return text;
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

/** What the lead holds now for a request key. */
function currentValue(lead: LeadDetail, key: FieldKey): unknown {
  switch (key) {
    case 'fullName':
      return lead.contact.fullName;
    case 'phone':
      return lead.contact.phone;
    case 'planId':
      return lead.order?.planId ?? undefined;
    default:
      return lead.form?.payload[key];
  }
}

interface Row {
  key: FieldKey;
  label: string;
  now: string;
  asked: string;
}

function rowsFor(
  lead: LeadDetail,
  fields: StaffChangeRequest['fields'],
  catalog: PropertyCatalog,
): Row[] {
  const rows: Row[] = [];
  for (const key of FIELD_ORDER) {
    if (!(key in fields)) continue;
    const propertyKey = PROPERTY_KEY[key];
    const property = propertyKey ? propertyFor(catalog, lead.leadType, propertyKey) : undefined;
    const label =
      key === 'fullName' ? 'Name' : key === 'phone' ? 'Phone' : (property?.label ?? key);
    const asked = fields[key];
    let now = valueText(property, currentValue(lead, key));
    // A plan the catalogue no longer lists still reads by the name frozen on the order.
    if (key === 'planId' && now === String(lead.order?.planId)) {
      now = lead.order?.plan?.name ?? now;
    }
    rows.push({
      key,
      label,
      now,
      // An address asked to be cleared.
      asked: asked === null ? 'Cleared' : valueText(property, asked),
    });
  }
  return rows;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** When the customer asked, inside the sentence: "5m ago", or "on Oct 12" once it is a date. */
function askedWhen(iso: string, now: number = Date.now()): string {
  const text = relativeTime(iso, now);
  return now - Date.parse(iso) < WEEK_MS ? text : `on ${text}`;
}

/** Why the Change approved / Change rejected email was not queued, in one line. */
export function changeEmailSkippedText(skipped: ChangeDecisionEmailSkipped): string {
  const lead = `The ${CUSTOMER_EMAIL_TEMPLATE_LABELS[skipped.template]} email was not sent`;
  switch (skipped.reason) {
    case 'no_sender':
      return `${lead}: this site has no sender yet (Settings → Email).`;
    case 'no_customer_email':
      return `${lead}: the customer has no email address.`;
    case 'missing_fill_in':
      return `${lead}: it needs the ${listText(skipped.missing ?? [])}.`;
  }
}

type Outcome = { decision: 'approve' | 'reject'; skipped?: ChangeDecisionEmailSkipped };

function outcomeText(
  outcome: Outcome,
  changeRequest: StaffChangeRequest,
): { text: string; skipped?: ChangeDecisionEmailSkipped } {
  const base =
    outcome.decision === 'approve'
      ? changeRequest.documents.length > 0
        ? 'Approved. The documents now wait for an Orders review.'
        : 'Approved.'
      : outcome.skipped
        ? 'Rejected.'
        : 'Rejected. The customer will be told by email.';
  return outcome.skipped ? { text: base, skipped: outcome.skipped } : { text: base };
}

/** The refusal a decision met, in words; `reload` when the request has to be read again. */
function refusal(error: unknown): { text: string; reload: boolean } {
  const code = errorReason(error);
  if (code === 'version_conflict') {
    return { text: 'The customer changed this request. Reload to see the latest.', reload: true };
  }
  if (code === 'change_request_resolved') {
    return {
      text: 'Someone already decided this request. Reload to see the latest.',
      reload: true,
    };
  }
  return { text: describeError(error, 'save the decision'), reload: false };
}

/**
 * The customer's pending change request, as staff decide it: what each field
 * is now and what the customer asked for, the documents that came with it
 * (opened with View for staff who may download) and Approve changes / Reject.
 * A decision carries the version the card was loaded at, so staff never
 * approve values they did not see (`version_conflict` says the customer
 * changed it). After a decision the card keeps saying what happened, including
 * an email that was not sent, and the focus moves to that outcome (the button
 * that was pressed is gone); `onDone` hands the backend's answer to the page.
 * `canDecide` is the right to decide (the Leads role); an archived lead is
 * restored first.
 */
export function ChangeRequestCard({
  lead,
  changeRequest,
  catalog,
  canDecide,
  canDownload,
  onDecide,
  onDone,
  openDocument,
  previewDocument,
  onReload,
}: {
  lead: LeadDetail;
  changeRequest: StaffChangeRequest;
  catalog: PropertyCatalog;
  canDecide: boolean;
  canDownload: boolean;
  onDecide(
    decision: 'approve' | 'reject',
    expectedVersion: number,
  ): Promise<ResolveChangeRequestResponse>;
  onDone(result: ResolveChangeRequestResponse): void;
  openDocument(fileId: string): Promise<void>;
  /**
   * A short-lived inline link for a document's thumbnail on the card. Without
   * it (or when it fails) the card shows View only.
   */
  previewDocument?(fileId: string): Promise<string>;
  /** Reads the lead again (offered when the request moved under the decision). */
  onReload?(): void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();
  const [failure, setFailure] = useState<{ text: string; reload: boolean }>();
  const [documentFailure, setDocumentFailure] = useState<string>();
  const outcomeRef = useRef<HTMLParagraphElement>(null);
  const rows = rowsFor(lead, changeRequest.fields, catalog);
  const headingId = `change-request-${changeRequest.requestNo}`;
  const archived = lead.deletedAt !== null;

  // The pressed button unmounts with the decision: keep the focus on what happened.
  useEffect(() => {
    if (outcome) outcomeRef.current?.focus();
  }, [outcome]);

  async function decide(decision: 'approve' | 'reject') {
    if (busy) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const result = await onDecide(decision, changeRequest.version);
      setOutcome(result.emailSkipped ? { decision, skipped: result.emailSkipped } : { decision });
      onDone(result);
    } catch (error) {
      setFailure(refusal(error));
    } finally {
      setBusy(false);
    }
  }

  async function view(fileId: string) {
    setDocumentFailure(undefined);
    try {
      await openDocument(fileId);
    } catch (error) {
      setDocumentFailure(
        error instanceof Error && error.message !== ''
          ? error.message
          : 'The document could not be opened. Try again.',
      );
    }
  }

  const done = outcome ? outcomeText(outcome, changeRequest) : undefined;

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <section aria-labelledby={headingId} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 id={headingId} className="text-base font-semibold">
              Change request #{changeRequest.requestNo}
            </h2>
            <p className="text-sm text-muted-foreground">
              The customer asked for these changes{' '}
              <time
                dateTime={changeRequest.updatedAt}
                title={dateTimeLabel(changeRequest.updatedAt)}
              >
                {askedWhen(changeRequest.updatedAt)}
              </time>
              .
            </p>
          </div>

          {rows.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th scope="col" className="py-1 pr-3 font-medium">
                      Field
                    </th>
                    <th scope="col" className="py-1 pr-3 font-medium">
                      Now
                    </th>
                    <th scope="col" className="py-1 font-medium">
                      Asked for
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((row) => (
                    <tr key={row.key} className="align-top">
                      <th scope="row" className="py-1.5 pr-3 text-left font-normal">
                        {row.label}
                      </th>
                      <td className="py-1.5 pr-3 break-words text-muted-foreground">{row.now}</td>
                      <td className="py-1.5 font-medium break-words">{row.asked}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {changeRequest.documents.length > 0 ? (
            <div className="flex flex-col gap-1 text-sm">
              <p>Documents sent with it:</p>
              <ul className="flex flex-col gap-2">
                {changeRequest.documents.map((document) => {
                  const label = documentLabel(document.documentType);
                  return (
                    <li
                      key={document.fileId}
                      aria-label={label}
                      className="flex items-center gap-3"
                    >
                      {canDownload && previewDocument ? (
                        <DocumentThumb
                          fileId={document.fileId}
                          label={label}
                          load={previewDocument}
                        />
                      ) : null}
                      <span>{label}</span>
                      {canDownload ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-label={`View ${label}`}
                          onClick={() => void view(document.fileId)}
                        >
                          <EyeIcon className="size-4" aria-hidden="true" /> View
                        </Button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              {documentFailure ? (
                <p role="alert" className="text-sm text-destructive">
                  {documentFailure}
                </p>
              ) : null}
            </div>
          ) : null}

          {done ? (
            <div className="flex flex-col gap-2">
              <p ref={outcomeRef} role="status" tabIndex={-1} className="text-sm outline-none">
                {done.text}
              </p>
              {done.skipped ? (
                <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">
                  {changeEmailSkippedText(done.skipped)}
                </p>
              ) : null}
            </div>
          ) : canDecide && !archived ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => void decide('approve')}
                >
                  Approve changes
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void decide('reject')}
                >
                  Reject
                </Button>
              </div>
              {failure ? (
                <div className="flex flex-wrap items-center gap-2">
                  <p role="alert" className="text-sm text-destructive">
                    {failure.text}
                  </p>
                  {failure.reload && onReload ? (
                    <Button type="button" size="sm" variant="ghost" onClick={onReload}>
                      Reload
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {canDecide
                ? 'Restore this lead to decide this request.'
                : 'Only someone with the Leads role can decide this.'}
            </p>
          )}
        </section>
      </CardContent>
    </Card>
  );
}

/**
 * A document's picture on the card, so staff see the passport or letter
 * without opening a tab. A short-lived signed link to a private object: next/image would
 * proxy and cache it, so a plain <img> is the right element here. Anything that
 * is not an image (a PDF) shows a file tile; View still opens it.
 */
function DocumentThumb({
  fileId,
  label,
  load,
}: {
  fileId: string;
  label: string;
  load(fileId: string): Promise<string>;
}): JSX.Element {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  // The parent may pass a new function each render; the link is fetched once per file.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);
  useEffect(() => {
    let live = true;
    loadRef.current(fileId).then(
      (next) => {
        if (live) setUrl(next);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [fileId]);

  if (failed || url === undefined)
    return (
      <span
        aria-hidden="true"
        className={`grid size-16 shrink-0 place-items-center rounded-md border bg-muted text-muted-foreground ${url === undefined && !failed ? 'animate-pulse' : ''}`}
      >
        <FileTextIcon className="size-5" />
      </span>
    );
  return (
    <>
      <button
        type="button"
        aria-label={`Preview ${label}`}
        className="size-16 shrink-0 overflow-hidden rounded-md border bg-muted outline-none hover:ring-2 hover:ring-ring/40 focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setOpen(true)}
      >
        <img src={url} alt="" onError={() => setFailed(true)} className="size-full object-cover" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
            <DialogDescription>Sent with the customer’s change request.</DialogDescription>
          </DialogHeader>
          <img
            src={url}
            alt={label}
            className="max-h-[75vh] w-full rounded-md bg-muted object-contain"
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
