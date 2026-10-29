'use client';

import { useState, type JSX, type KeyboardEvent } from 'react';
import {
  PROPERTY_LIMIT,
  defaultPropertyLayout,
  leadTypeCatalog,
  leadTypeLabel,
  renderPropertyLayout,
  type CreateCustomProperty,
  type PropertyLayout,
  type SiteProperty,
  type UpdateProperty,
} from '@gt-sales/contracts';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FormField,
  Input,
  NativeSelect,
} from '@gt-sales/ui';

import {
  BackendError,
  createProperty,
  deleteProperty,
  savePropertyLayout,
  updateProperty,
} from '../../lib/api';
import { errorReason } from '../../lib/use-resource';
import { useStaffSession } from '../staff-session-provider';
import { LayoutEditor } from './layout-editor';
import { PROPERTY_KIND_LABELS, PropertyEditor } from './property-editor';
import { usePropertyModel } from './use-property-model';

const LEAD_TYPES = Object.entries(leadTypeCatalog).map(([key, entry]) => ({
  key,
  label: entry.label,
}));

type Tab = 'properties' | 'layouts';
const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'properties', label: 'Properties' },
  { id: 'layouts', label: 'Layouts' },
];

const leadsText = (count: number) => `${count} ${count === 1 ? 'lead' : 'leads'}`;

function detailCount(error: BackendError): number | undefined {
  const count = error.details?.leadCount;
  return typeof count === 'number' ? count : undefined;
}

/** What went wrong with a write, in words staff can act on. */
function writeError(error: unknown, subject: 'property' | 'layout'): string {
  if (error instanceof BackendError) {
    const count = detailCount(error);
    switch (error.code) {
      case 'version_conflict':
        return `Someone else changed this ${subject}. The latest version is loaded.`;
      case 'property_in_use':
        return count === undefined
          ? 'Leads still hold a value for this property. Clear the value on those leads first.'
          : `Used on ${leadsText(count)}. Clear the value on those leads first.`;
      case 'property_option_in_use': {
        const option = error.details?.optionValue;
        const name = typeof option === 'string' ? option : 'This option';
        return count === undefined
          ? `${name} is used on leads. Hide it instead of removing it.`
          : `Option ${name} is used on ${leadsText(count)}. Hide it instead of removing it.`;
      }
      case 'builtin_property_locked':
        return 'A built-in property can only be renamed or hidden.';
      default:
        break;
    }
  }
  return `The change was not saved. Reason: ${errorReason(error)}.`;
}

function leadTypesText(property: SiteProperty): string {
  return property.leadTypes.length === 0
    ? 'All lead types'
    : property.leadTypes.map(leadTypeLabel).join(', ');
}

/**
 * Settings → Properties: the site's built-in and custom properties, and the
 * record layout per lead type. Every member can read it; the write controls
 * show only when the backend says this member can manage properties.
 */
export function PropertiesSettings({ workspaceSlug }: { workspaceSlug: string }): JSX.Element {
  const staff = useStaffSession();
  const workspaceId = staff.workspaces.find((item) => item.slug === workspaceSlug)?.id;
  const accessToken = staff.accessToken;
  const { model, catalog, reload, error: loadError } = usePropertyModel(workspaceId);

  const [tab, setTab] = useState<Tab>('properties');
  const [leadType, setLeadType] = useState(LEAD_TYPES[0]?.key ?? 'internet');
  const [renaming, setRenaming] = useState<{ key: string; label: string }>();
  const [dialog, setDialog] = useState<{ property?: SiteProperty }>();
  const [deleting, setDeleting] = useState<SiteProperty>();
  const [deleteError, setDeleteError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [pending, setPending] = useState(false);

  const canManage = model?.capabilities.canManage ?? false;
  const builtins = model?.properties.filter((property) => property.origin === 'builtin') ?? [];
  const customs = model?.properties.filter((property) => property.origin === 'custom') ?? [];

  /** One write, then a reload so the inbox and record read the change; the reason it failed, if it did. */
  async function write(
    action: (token: string, id: string) => Promise<unknown>,
    subject: 'property' | 'layout',
  ): Promise<string | undefined> {
    if (!accessToken || !workspaceId) return 'You are signed out. Sign in again to continue.';
    try {
      await action(accessToken, workspaceId);
    } catch (caught) {
      if (caught instanceof BackendError && caught.code === 'version_conflict') await reload();
      return writeError(caught, subject);
    }
    await reload();
    return undefined;
  }

  async function change(property: SiteProperty, body: Omit<UpdateProperty, 'expectedVersion'>) {
    setNotice(undefined);
    setPending(true);
    const reason = await write(
      (token, id) =>
        updateProperty(token, id, property.key, {
          ...body,
          expectedVersion: property.version ?? 1,
        }),
      'property',
    );
    setPending(false);
    setNotice(reason);
    return reason;
  }

  async function saveLabel() {
    if (!renaming) return;
    const property = builtins.find((entry) => entry.key === renaming.key);
    const label = renaming.label.trim();
    if (!property || label === '') {
      setNotice('Enter a label.');
      return;
    }
    if (label === property.label) {
      setRenaming(undefined);
      return;
    }
    const reason = await change(property, { label });
    if (!reason) setRenaming(undefined);
  }

  async function saveEditor(input: CreateCustomProperty | UpdateProperty) {
    const target = dialog?.property;
    const reason = await write(async (token, id) => {
      if ('kind' in input) await createProperty(token, id, input);
      else if (target) await updateProperty(token, id, target.key, input);
    }, 'property');
    if (!reason) setDialog(undefined);
    return reason;
  }

  async function confirmDelete() {
    if (!deleting) return;
    setDeleteError(undefined);
    setPending(true);
    const key = deleting.key;
    const reason = await write((token, id) => deleteProperty(token, id, key), 'property');
    setPending(false);
    if (reason) setDeleteError(reason);
    else setDeleting(undefined);
  }

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = TABS[(index + step + TABS.length) % TABS.length];
    if (!next) return;
    setTab(next.id);
    document.getElementById(`properties-tab-${next.id}`)?.focus();
  }

  if (!model) {
    return loadError ? (
      <p role="alert" className="text-sm text-destructive">
        The properties could not be loaded. Reason: {loadError}.
      </p>
    ) : (
      <p className="text-sm text-muted-foreground" aria-busy="true">
        Loading the properties…
      </p>
    );
  }

  const layoutRow = model.layouts[leadType];
  const seeded = defaultPropertyLayout(leadType, catalog);
  const layoutStart: PropertyLayout =
    layoutRow?.layout ??
    (seeded.sections.length > 0
      ? seeded
      : { sections: [{ id: 'request', label: 'Request', keys: [] }] });

  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" aria-label="Property settings" className="flex gap-1 border-b">
        {TABS.map((entry, index) => (
          <button
            key={entry.id}
            id={`properties-tab-${entry.id}`}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            aria-controls={`properties-panel-${entry.id}`}
            tabIndex={tab === entry.id ? 0 : -1}
            className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted-foreground aria-selected:border-primary aria-selected:text-foreground"
            onClick={() => setTab(entry.id)}
            onKeyDown={(event) => onTabKey(event, index)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === 'properties' ? (
        <div
          role="tabpanel"
          id="properties-panel-properties"
          aria-labelledby="properties-tab-properties"
          className="flex flex-col gap-6"
        >
          {notice ? (
            <p role="alert" className="text-sm text-destructive">
              {notice}
            </p>
          ) : null}

          <section aria-labelledby="builtin-heading" className="flex flex-col gap-2">
            <div>
              <h2 id="builtin-heading" className="text-base font-semibold">
                Built-in properties
              </h2>
              <p className="text-sm text-muted-foreground">
                These come with every site. You can rename one or hide it from records, filters and
                columns.
              </p>
            </div>
            <ul aria-label="Built-in properties" className="divide-y rounded-md border">
              {builtins.map((property) => (
                <li
                  key={property.key}
                  className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2"
                >
                  {renaming?.key === property.key ? (
                    <div className="flex flex-1 flex-wrap items-center gap-2">
                      <Input
                        className="min-w-40 flex-1"
                        aria-label={`Label for ${property.label}`}
                        maxLength={80}
                        value={renaming.label}
                        onChange={(event) =>
                          setRenaming({ key: property.key, label: event.target.value })
                        }
                      />
                      <Button
                        type="button"
                        size="sm"
                        disabled={pending}
                        onClick={() => void saveLabel()}
                      >
                        Save label
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setRenaming(undefined)}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <>
                      <div className="mr-auto min-w-0">
                        <p className="text-sm font-medium">
                          {property.label}
                          {property.hidden ? (
                            <Badge variant="secondary" className="ml-2">
                              Hidden
                            </Badge>
                          ) : null}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {PROPERTY_KIND_LABELS[property.kind]} · {leadTypesText(property)}
                        </p>
                      </div>
                      {canManage ? (
                        <div className="flex gap-1">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={pending}
                            aria-label={`Rename ${property.label}`}
                            onClick={() => {
                              setNotice(undefined);
                              setRenaming({ key: property.key, label: property.label });
                            }}
                          >
                            Rename
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={pending}
                            aria-label={`${property.hidden ? 'Show' : 'Hide'} ${property.label}`}
                            onClick={() => void change(property, { hidden: !property.hidden })}
                          >
                            {property.hidden ? 'Show' : 'Hide'}
                          </Button>
                        </div>
                      ) : null}
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="custom-heading" className="flex flex-col gap-2">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h2 id="custom-heading" className="text-base font-semibold">
                  Custom properties
                </h2>
                <p className="text-sm text-muted-foreground">
                  Extra details this site tracks on its leads.
                </p>
              </div>
              {canManage ? (
                <Button
                  type="button"
                  disabled={customs.length >= PROPERTY_LIMIT}
                  onClick={() => {
                    setNotice(undefined);
                    setDialog({});
                  }}
                >
                  Add property
                </Button>
              ) : null}
            </div>
            {customs.length >= PROPERTY_LIMIT ? (
              <p className="text-sm text-muted-foreground">
                This site has reached the limit of {PROPERTY_LIMIT} custom properties.
              </p>
            ) : null}
            {customs.length === 0 ? (
              <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                No custom properties yet.
              </p>
            ) : (
              <ul aria-label="Custom properties" className="divide-y rounded-md border">
                {customs.map((property) => (
                  <li
                    key={property.key}
                    className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2"
                  >
                    <div className="mr-auto min-w-0">
                      <p className="text-sm font-medium">
                        {property.label}
                        {property.hidden ? (
                          <Badge variant="secondary" className="ml-2">
                            Hidden
                          </Badge>
                        ) : null}
                        {property.staffOnly ? (
                          <Badge variant="outline" className="ml-2">
                            Staff only
                          </Badge>
                        ) : null}
                        {property.sensitive ? (
                          <Badge variant="outline" className="ml-2">
                            Sensitive
                          </Badge>
                        ) : null}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {PROPERTY_KIND_LABELS[property.kind]} · {leadTypesText(property)}
                      </p>
                    </div>
                    {canManage ? (
                      <div className="flex gap-1">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={pending}
                          aria-label={`Edit ${property.label}`}
                          onClick={() => {
                            setNotice(undefined);
                            setDialog({ property });
                          }}
                        >
                          Edit
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={pending}
                          aria-label={`${property.hidden ? 'Show' : 'Hide'} ${property.label}`}
                          onClick={() => void change(property, { hidden: !property.hidden })}
                        >
                          {property.hidden ? 'Show' : 'Hide'}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={pending}
                          aria-label={`Delete ${property.label}`}
                          onClick={() => {
                            setDeleteError(undefined);
                            setDeleting(property);
                          }}
                        >
                          Delete
                        </Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : (
        <div
          role="tabpanel"
          id="properties-panel-layouts"
          aria-labelledby="properties-tab-layouts"
          className="flex max-w-3xl flex-col gap-4"
        >
          <p className="text-sm text-muted-foreground">
            How a lead&rsquo;s details are grouped on its record page, for each lead type.
          </p>
          <div className="max-w-xs">
            <FormField id="layout-lead-type" label="Lead type">
              <NativeSelect value={leadType} onChange={(event) => setLeadType(event.target.value)}>
                {LEAD_TYPES.map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    {entry.label}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
          </div>
          {canManage ? (
            <LayoutEditor
              key={leadType}
              leadType={leadType}
              initial={layoutStart}
              catalog={catalog}
              onSave={(layout) =>
                write(
                  (token, id) =>
                    savePropertyLayout(token, id, leadType, {
                      layout,
                      ...(layoutRow && layoutRow.version > 0
                        ? { expectedVersion: layoutRow.version }
                        : {}),
                    }),
                  'layout',
                )
              }
            />
          ) : (
            <div className="flex flex-col gap-3">
              {renderPropertyLayout(layoutStart, leadType, catalog).map((section) => (
                <section key={section.id} className="rounded-lg border p-3">
                  <h3 className="text-sm font-medium">{section.label}</h3>
                  {section.properties.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Nothing in this section.</p>
                  ) : (
                    <ul className="mt-1 list-disc pl-5 text-sm">
                      {section.properties.map((property) => (
                        <li key={property.key}>{property.label}</li>
                      ))}
                    </ul>
                  )}
                </section>
              ))}
            </div>
          )}
        </div>
      )}

      <Dialog open={dialog !== undefined} onOpenChange={(open) => !open && setDialog(undefined)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{dialog?.property ? 'Edit property' : 'Add property'}</DialogTitle>
            <DialogDescription>
              {dialog?.property
                ? 'Change how this property is labelled and where it applies.'
                : 'A custom property adds a detail staff can fill in on a lead.'}
            </DialogDescription>
          </DialogHeader>
          {dialog ? (
            <PropertyEditor
              key={dialog.property?.key ?? 'new'}
              {...(dialog.property ? { initial: dialog.property } : {})}
              leadTypes={LEAD_TYPES}
              onSave={saveEditor}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleting !== undefined}
        onOpenChange={(open) => !open && setDeleting(undefined)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleting?.label}?</DialogTitle>
            <DialogDescription>
              The property is removed from every record page and layout. It can be deleted only when
              no lead holds a value for it; hide it to keep the values.
            </DialogDescription>
          </DialogHeader>
          {deleteError ? (
            <p role="alert" className="text-sm text-destructive">
              {deleteError}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleting(undefined)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() => void confirmDelete()}
            >
              Delete property
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
