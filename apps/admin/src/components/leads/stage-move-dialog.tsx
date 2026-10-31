'use client';

import { useId, useState, type FormEvent } from 'react';
import {
  emailTemplateLabel,
  leadStageLabel,
  type EmailSkipped,
  type LeadDetail,
  type StageGate,
  type UpdateWorkspaceLeadRequest,
  type UpdateWorkspaceLeadResponse,
} from '@gt-sales/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FormField,
  Input,
  Textarea,
} from '@gt-sales/ui';

import { torontoDay } from '../../lib/dates';
import { errorDetailList, errorReason } from '../../lib/use-resource';
import { documentTypeLabel } from '../plans/document-types';

type OrderEdit = NonNullable<UpdateWorkspaceLeadRequest['order']>;
/** The order details a stage's gates ask for. */
type DetailKey =
  | 'courier'
  | 'trackingNumber'
  | 'dispatchedAt'
  | 'activatedAt'
  | 'activationNumber'
  | 'activationAccount';

/** For staff who may not move an order on without its documents (no `order.override`). */
export const APPROVE_DOCUMENTS_FIRST =
  'Approve the documents first, or ask someone with the Orders role.';

/**
 * What staff read when the backend refuses a stage move for a reason of its
 * own (the move from here, or the override), or `undefined` for any other code.
 */
export function stageMoveRefusal(code: string, leadType: string, from: string): string | undefined {
  if (code === 'illegal_stage_move') {
    return `That move is not allowed from ${leadStageLabel(leadType, from)}.`;
  }
  if (code === 'documents_override_not_allowed') return APPROVE_DOCUMENTS_FIRST;
  return undefined;
}

/** `a`, `a and b`, `a, b and c`. */
export function listText(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

/** Why a move's automation did not email the customer, in one line. */
export function emailSkippedText(skipped: EmailSkipped): string {
  const lead = `The ${emailTemplateLabel(skipped.template, skipped.templateName)} email was not sent`;
  switch (skipped.reason) {
    case 'no_sender':
      return `${lead}: this site has no sender yet. Check Settings → Email, and that the deployment's email provider is configured.`;
    case 'no_customer_email':
      return `${lead}: the customer has no email address.`;
    case 'missing_fill_in':
      return `${lead}: it needs the ${listText(skipped.missing ?? [])}.`;
    case 'compose_failed':
      return `${lead}: the email could not be made. Check the template in Settings → Email.`;
  }
}

/** The trimmed value, or `undefined` when blank. */
function filled(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** For staff who see no list of the documents the check found missing. */
const APPROVE_REQUIRED_DOCUMENTS = 'Approve the required documents first.';

/**
 * The move into a stage that asks for details first (`stageGates`): the
 * dispatch details for Delivered (courier, tracking number, dispatch date),
 * the activation details for Activated (date, number, account), each
 * prefilled from the order and dated today in Toronto when it has none. When the
 * documents check refuses the move it lists the documents not approved; staff
 * allowed to (`canOverride`) give a reason and move anyway.
 */
export function StageMoveDialog({
  lead,
  to,
  gates,
  canOverride,
  onMove,
  onDone,
  onCancel,
}: {
  lead: LeadDetail;
  to: string;
  gates: readonly StageGate[];
  canOverride: boolean;
  onMove(body: UpdateWorkspaceLeadRequest): Promise<UpdateWorkspaceLeadResponse>;
  onDone(result: UpdateWorkspaceLeadResponse): void;
  onCancel(): void;
}) {
  const id = useId();
  const order = lead.order;
  const asksDispatch = gates.includes('dispatch');
  const asksActivation = gates.includes('activation');
  const [courier, setCourier] = useState(order?.courier ?? '');
  const [trackingNumber, setTrackingNumber] = useState(order?.trackingNumber ?? '');
  const [dispatchedAt, setDispatchedAt] = useState(() => order?.dispatchedAt ?? torontoDay());
  const [activatedAt, setActivatedAt] = useState(() => order?.activatedAt ?? torontoDay());
  const [activationNumber, setActivationNumber] = useState(order?.activationNumber ?? '');
  const [activationAccount, setActivationAccount] = useState(order?.activationAccount ?? '');
  const [missing, setMissing] = useState<readonly string[]>();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const stageLabel = leadStageLabel(lead.leadType, to);
  const overriding = missing !== undefined && canOverride;

  function details(): OrderEdit | undefined {
    const fields: Array<readonly [DetailKey, string]> = [];
    if (asksDispatch) {
      fields.push(
        ['courier', courier],
        ['trackingNumber', trackingNumber],
        ['dispatchedAt', dispatchedAt],
      );
    }
    if (asksActivation) {
      fields.push(
        ['activatedAt', activatedAt],
        ['activationNumber', activationNumber],
        ['activationAccount', activationAccount],
      );
    }
    // A blank field the order had a value for clears it; one it had none for changes nothing.
    const edit: OrderEdit = {};
    for (const [key, value] of fields) {
      const kept = filled(value);
      if (kept !== undefined) edit[key] = kept;
      else if (order?.[key]) edit[key] = null;
    }
    return Object.keys(edit).length > 0 ? edit : undefined;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (asksDispatch && filled(courier) === undefined) {
      setMessage('Add the courier first.');
      return;
    }
    if (asksActivation && filled(activatedAt) === undefined) {
      setMessage('Add the activation date first.');
      return;
    }
    if (overriding && filled(reason) === undefined) {
      setMessage('Say why the order moves on without them.');
      return;
    }
    const edit = details();
    const overrideReason = overriding ? filled(reason) : undefined;
    const body: UpdateWorkspaceLeadRequest = {
      stage: to,
      ...(edit ? { order: edit } : {}),
      ...(overrideReason ? { documentsOverrideReason: overrideReason } : {}),
    };
    setBusy(true);
    setMessage(undefined);
    try {
      onDone(await onMove(body));
    } catch (error) {
      const code = errorReason(error);
      if (code === 'documents_incomplete') {
        setMissing(errorDetailList(error, 'missing'));
      } else {
        setMessage(
          stageMoveRefusal(code, lead.leadType, lead.stage) ??
            `The lead was not moved. Reason: ${code}.`,
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // A move on its way may already have emailed the customer: it finishes first.
        if (!open && !busy) onCancel();
      }}
    >
      <DialogContent>
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Move to {stageLabel}</DialogTitle>
            <DialogDescription>
              {asksDispatch
                ? 'How the order was sent: the customer’s email and tracking page use these.'
                : asksActivation
                  ? 'The activation as the carrier recorded it.'
                  : 'The order’s documents are checked before it moves.'}
            </DialogDescription>
          </DialogHeader>
          {asksDispatch ? (
            <>
              <FormField id={`${id}-courier`} label="Courier" required>
                <Input
                  value={courier}
                  onChange={(event) => setCourier(event.target.value)}
                  maxLength={120}
                  placeholder="Canada Post"
                  required
                />
              </FormField>
              <FormField id={`${id}-tracking`} label="Tracking number">
                <Input
                  value={trackingNumber}
                  onChange={(event) => setTrackingNumber(event.target.value)}
                  maxLength={120}
                />
              </FormField>
              <FormField id={`${id}-dispatched`} label="Dispatched on">
                <Input
                  type="date"
                  value={dispatchedAt}
                  onChange={(event) => setDispatchedAt(event.target.value)}
                />
              </FormField>
            </>
          ) : null}
          {asksActivation ? (
            <>
              <FormField id={`${id}-activated`} label="Activated on" required>
                <Input
                  type="date"
                  value={activatedAt}
                  onChange={(event) => setActivatedAt(event.target.value)}
                  required
                />
              </FormField>
              <FormField id={`${id}-number`} label="Activation number">
                <Input
                  value={activationNumber}
                  onChange={(event) => setActivationNumber(event.target.value)}
                  maxLength={40}
                />
              </FormField>
              <FormField id={`${id}-account`} label="Activation account">
                <Input
                  value={activationAccount}
                  onChange={(event) => setActivationAccount(event.target.value)}
                  maxLength={80}
                />
              </FormField>
            </>
          ) : null}
          {missing ? (
            <div
              role="status"
              className="flex flex-col gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm"
            >
              <p>
                {missing.length > 0
                  ? `Missing approved documents: ${missing.map(documentTypeLabel).join(', ')}`
                  : APPROVE_REQUIRED_DOCUMENTS}
              </p>
              {canOverride || missing.length === 0 ? null : <p>{APPROVE_DOCUMENTS_FIRST}</p>}
            </div>
          ) : null}
          {overriding ? (
            <FormField id={`${id}-reason`} label="Reason for moving anyway" required>
              <Textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={2000}
                rows={3}
                required
              />
            </FormField>
          ) : null}
          {message ? (
            <p role="alert" className="text-sm text-destructive">
              {message}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Moving…' : overriding ? 'Move anyway' : 'Move'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
