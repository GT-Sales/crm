'use client';

import { useState, type JSX } from 'react';
import {
  PLAN_LIMIT,
  leadTypeLabel,
  type CreatePlanRequest,
  type Plan,
  type UpdatePlanRequest,
} from '@gt-sales/contracts';
import { orderLeadTypes } from '@gt-sales/types';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@gt-sales/ui';

import { BackendError, createPlan, updatePlan } from '../../lib/api';
import { errorReason } from '../../lib/use-resource';
import { usePropertyModel } from '../properties/use-property-model';
import { useStaffSession } from '../staff-session-provider';
import { PLAN_DOCUMENT_TYPES } from './document-types';
import { BILLING_PERIOD_LABELS, PlanEditor, commissionLabel } from './plan-editor';
import { usePlans } from './use-plans';
import { LoadingSkeleton } from '../crm/loading-skeleton';

const price = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });

/** Roles whose members hold `order.manage`; the backend checks it again on every write. */
const ORDER_MANAGER_ROLES = ['owner', 'orders'];

/** What went wrong with a write, in words staff can act on. */
function planError(error: unknown): string {
  if (error instanceof BackendError) {
    switch (error.code) {
      case 'plan_name_taken':
        return 'A plan with that name already exists for this type.';
      case 'plan_limit':
        return `This site already has ${PLAN_LIMIT} plans.`;
      case 'version_conflict':
        return 'This plan changed elsewhere. Reload and try again.';
      default:
        break;
    }
  }
  return `The change was not saved. Reason: ${errorReason(error)}.`;
}

/** Active plans first, the inactive ones after them; each group keeps the backend's order. */
function activeFirst(plans: readonly Plan[]): Plan[] {
  return [...plans.filter((plan) => plan.active), ...plans.filter((plan) => !plan.active)];
}

/**
 * Settings → Plans: the plans the site sells, one list per order lead type.
 * Every member can read it; adding, editing and the Active switch show only to
 * members with `order.manage` (the owner and orders roles), which the backend
 * checks again on every write.
 */
export function PlansSettings({ workspaceSlug }: { workspaceSlug: string }): JSX.Element {
  const staff = useStaffSession();
  const workspace = staff.workspaces.find((item) => item.slug === workspaceSlug);
  const workspaceId = workspace?.id;
  const accessToken = staff.accessToken;
  const canWrite = workspace?.roles.some((role) => ORDER_MANAGER_ROLES.includes(role)) ?? false;
  // Money is the owner's alone (`revenue.view`); the backend leaves it out for anyone else.
  const isOwner = workspace?.roles.includes('owner') ?? false;

  const {
    plans,
    loaded,
    reload,
    error: loadError,
  } = usePlans(workspaceId, {
    includeInactive: true,
  });
  const { catalog } = usePropertyModel(workspaceId, 'plan');

  const [dialog, setDialog] = useState<{ leadType: string; plan?: Plan }>();
  const [dialogNotice, setDialogNotice] = useState<string>();
  // A save refused because someone else got there first: the editor is rebuilt from the reloaded plan
  // (its epoch changes), so the draft is replaced by the latest saved version and a retry sends its version.
  const [dialogEpoch, setDialogEpoch] = useState(0);
  const [notice, setNotice] = useState<string>();
  const [pending, setPending] = useState(false);

  const atLimit = plans.length >= PLAN_LIMIT;

  /**
   * One write, then a reload so the list reads the change. Says why it failed, if it did;
   * `conflict` means someone else changed the plan first and the list has been reloaded.
   */
  async function write(
    action: (token: string, id: string) => Promise<unknown>,
  ): Promise<{ reason?: string; conflict: boolean }> {
    if (!accessToken || !workspaceId) {
      return { reason: 'You are signed out. Sign in again to continue.', conflict: false };
    }
    try {
      await action(accessToken, workspaceId);
    } catch (caught) {
      const conflict = caught instanceof BackendError && caught.code === 'version_conflict';
      if (conflict) await reload();
      return { reason: planError(caught), conflict };
    }
    await reload();
    return { conflict: false };
  }

  async function setActive(plan: Plan, active: boolean) {
    setNotice(undefined);
    setPending(true);
    const { reason } = await write((token, id) =>
      updatePlan(token, id, plan.id, { expectedVersion: plan.version, active }),
    );
    setPending(false);
    setNotice(reason);
  }

  async function saveEditor(input: CreatePlanRequest | UpdatePlanRequest) {
    const target = dialog?.plan;
    setDialogNotice(undefined);
    const { reason, conflict } = await write(async (token, id) => {
      if ('leadType' in input) await createPlan(token, id, input);
      else if (target) await updatePlan(token, id, target.id, input);
    });
    if (conflict) {
      setDialogNotice(reason);
      setDialogEpoch((epoch) => epoch + 1);
      return undefined;
    }
    if (!reason) setDialog(undefined);
    return reason;
  }

  if (!loaded) {
    return loadError ? (
      <p role="alert" className="text-sm text-destructive">
        The plans could not be loaded. Reason: {loadError}.
      </p>
    ) : (
      <LoadingSkeleton label="Loading the plans…" variant="list" />
    );
  }

  // The dialog edits the plan as the list has it now, not as it was when the dialog opened.
  const editing = dialog?.plan
    ? (plans.find((entry) => entry.id === dialog.plan?.id) ?? dialog.plan)
    : undefined;

  // A type with plans gets its own section. Once the site sells something,
  // the types it has no plans for fold into one short list, so a SIM-only
  // site is not shown two empty Internet and Mobility sections; a site with
  // no plans at all still sees every type.
  const typesWithPlans = orderLeadTypes.filter((leadType) =>
    plans.some((plan) => plan.leadType === leadType),
  );
  const shownTypes = typesWithPlans.length === 0 ? orderLeadTypes : typesWithPlans;
  const otherTypes = orderLeadTypes.filter((leadType) => !shownTypes.includes(leadType));
  const openNew = (leadType: (typeof orderLeadTypes)[number]) => {
    setNotice(undefined);
    setDialogNotice(undefined);
    setDialog({ leadType });
  };

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        A change to a plan never rewrites an order already taken.
      </p>
      {loadError ? (
        <p role="alert" className="text-sm text-destructive">
          The plans could not be refreshed. Reason: {loadError}.
        </p>
      ) : null}
      {notice ? (
        <p role="alert" className="text-sm text-destructive">
          {notice}
        </p>
      ) : null}
      {atLimit ? (
        <p className="text-sm text-muted-foreground">This site already has {PLAN_LIMIT} plans.</p>
      ) : null}

      {shownTypes.map((leadType) => {
        const label = leadTypeLabel(leadType);
        const ofType = activeFirst(plans.filter((plan) => plan.leadType === leadType));
        const activeCount = ofType.filter((plan) => plan.active).length;
        return (
          <section
            key={leadType}
            aria-labelledby={`plans-heading-${leadType}`}
            className="overflow-hidden rounded-xl border border-border/80 bg-card/30"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-5 py-3.5">
              <div className="flex items-center gap-2">
                <h2
                  id={`plans-heading-${leadType}`}
                  className="text-sm font-medium text-foreground"
                >
                  {label}
                </h2>
                <Badge variant="secondary" className="text-xs font-normal">
                  {activeCount} active
                </Badge>
              </div>
              {canWrite ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={atLimit}
                  aria-label={`Add ${label} plan`}
                  onClick={() => openNew(leadType)}
                >
                  Add plan
                </Button>
              ) : null}
            </div>
            {ofType.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-muted-foreground">No plans yet.</p>
            ) : (
              <ul aria-label={`${label} plans`} className="divide-y divide-border/70">
                {ofType.map((plan) => (
                  <li
                    key={plan.id}
                    className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3.5 transition-colors hover:bg-muted/20 ${
                      plan.active ? '' : 'bg-muted/40 text-muted-foreground opacity-70'
                    }`}
                  >
                    <div className="mr-auto min-w-0">
                      <p className="text-sm font-medium text-foreground">
                        {plan.name}
                        {plan.active ? null : (
                          <Badge variant="secondary" className="ml-2 text-[11px] font-normal">
                            Inactive
                          </Badge>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {price.format(plan.priceMinor / 100)} ·{' '}
                        {BILLING_PERIOD_LABELS[plan.billingPeriod]}
                        {plan.paymentRequired ? ' · Payment required' : ''}
                        {plan.commission ? ` · ${commissionLabel(plan.commission)}` : ''}
                      </p>
                    </div>
                    {canWrite ? (
                      <div className="flex items-center gap-3">
                        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground hover:text-foreground">
                          <Checkbox
                            aria-label={`Active ${plan.name}`}
                            checked={plan.active}
                            disabled={pending}
                            onCheckedChange={(checked) => void setActive(plan, checked === true)}
                          />
                          Active
                        </label>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={pending}
                          aria-label={`Edit ${plan.name}`}
                          onClick={() => {
                            setNotice(undefined);
                            setDialogNotice(undefined);
                            setDialog({ leadType, plan });
                          }}
                        >
                          Edit
                        </Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}

      {otherTypes.length > 0 ? (
        <section
          aria-labelledby="plans-heading-other"
          className="overflow-hidden rounded-xl border border-dashed border-border/80"
        >
          <h2
            id="plans-heading-other"
            className="border-b border-border/70 px-5 py-3 text-sm font-medium text-muted-foreground"
          >
            Other order types
          </h2>
          <ul aria-label="Order types without plans" className="divide-y divide-border/70">
            {otherTypes.map((leadType) => {
              const label = leadTypeLabel(leadType);
              return (
                <li key={leadType} className="flex items-center justify-between gap-3 px-5 py-3">
                  <span className="text-sm text-foreground">
                    {label}
                    <span className="ml-2 text-xs text-muted-foreground">No plans</span>
                  </span>
                  {canWrite ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={atLimit}
                      aria-label={`Add ${label} plan`}
                      onClick={() => openNew(leadType)}
                    >
                      Add plan
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <Dialog open={dialog !== undefined} onOpenChange={(open) => !open && setDialog(undefined)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{dialog?.plan ? 'Edit plan' : 'Add plan'}</DialogTitle>
            <DialogDescription>
              {dialog
                ? `A plan for ${leadTypeLabel(dialog.leadType)} orders.`
                : 'A plan the site sells.'}
            </DialogDescription>
          </DialogHeader>
          {dialogNotice ? (
            <p role="alert" className="text-sm text-destructive">
              {dialogNotice}
            </p>
          ) : null}
          {dialog ? (
            <PlanEditor
              key={`${dialog.plan?.id ?? `new-${dialog.leadType}`}:${dialogEpoch}`}
              leadType={dialog.leadType}
              {...(editing ? { initial: editing } : {})}
              catalog={catalog}
              documentTypes={PLAN_DOCUMENT_TYPES}
              canSetCommission={isOwner}
              onSave={saveEditor}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
