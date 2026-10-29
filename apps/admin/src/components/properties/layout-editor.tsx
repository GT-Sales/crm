'use client';

import { useMemo, useState, type JSX } from 'react';
import {
  LAYOUT_MAX_SECTIONS,
  propertyLayoutSchema,
  type PropertyCatalog,
  type PropertyLayout,
} from '@gt-sales/contracts';
import { Button, Input, NativeSelect } from '@gt-sales/ui';

const KEY_TYPE = 'application/x-property-key';
const SECTION_TYPE = 'application/x-layout-section';

const newSectionId = () => `section_${crypto.randomUUID().replaceAll('-', '')}`;

/**
 * The record layout for one lead type: named sections of property keys.
 * Properties move up and down with buttons, between sections with the section
 * selector, or by dragging; the same holds for sections. A property the
 * layout does not place sits under "Not in the layout" with an Add button per
 * section (the record page shows such properties in a final "Other" section
 * until it is placed). `onSave` answers the reason a save was refused, or
 * nothing when it worked.
 */
export function LayoutEditor({
  leadType,
  initial,
  catalog,
  onSave,
}: {
  leadType: string;
  initial: PropertyLayout;
  catalog: PropertyCatalog;
  onSave(layout: PropertyLayout): Promise<string | undefined>;
}): JSX.Element {
  const visible = useMemo(() => catalog.forType(leadType), [catalog, leadType]);
  const visibleByKey = useMemo(
    () => new Map(visible.map((property) => [property.key, property])),
    [visible],
  );
  const labelOf = (key: string) => visibleByKey.get(key)?.label ?? catalog.get(key)?.label ?? key;

  // Keys of properties that no longer exist are dropped; a hidden one stays so the layout keeps its place for it.
  const [layout, setLayout] = useState<PropertyLayout>(() => {
    const seen = new Set<string>();
    return {
      sections: initial.sections.map((section) => ({
        ...section,
        keys: section.keys.filter((key) => {
          if (seen.has(key) || catalog.get(key) === undefined) return false;
          seen.add(key);
          return true;
        }),
      })),
    };
  });
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const placed = new Set(layout.sections.flatMap((section) => section.keys));
  const unplaced = visible.filter((property) => !placed.has(property.key));

  const change = (update: (sections: PropertyLayout['sections']) => PropertyLayout['sections']) => {
    setLayout((current) => ({ sections: update(current.sections) }));
    setError(undefined);
  };

  /** Puts `key` in a section before `before`, or at its end; it leaves wherever it was. */
  const place = (key: string, sectionId: string, before?: string) => {
    change((sections) =>
      sections.map((section) => {
        const keys = section.keys.filter((entry) => entry !== key);
        if (section.id === sectionId) {
          const at = before === undefined ? -1 : keys.indexOf(before);
          keys.splice(at < 0 ? keys.length : at, 0, key);
        }
        return { ...section, keys };
      }),
    );
    setStatus(`Moved ${labelOf(key)}. Save the layout to keep the change.`);
  };

  const unplace = (key: string) => {
    change((sections) =>
      sections.map((section) => ({
        ...section,
        keys: section.keys.filter((entry) => entry !== key),
      })),
    );
    setStatus(`Removed ${labelOf(key)} from the layout. Save the layout to keep the change.`);
  };

  const moveSection = (index: number, offset: number) =>
    change((sections) => {
      const next = [...sections];
      const [section] = next.splice(index, 1);
      if (section) next.splice(index + offset, 0, section);
      return next;
    });

  async function save() {
    setStatus('');
    if (layout.sections.some((section) => section.label.trim() === '')) {
      setError('Give every section a name.');
      return;
    }
    const parsed = propertyLayoutSchema.safeParse(layout);
    if (!parsed.success) {
      setError('This layout cannot be saved. Check the section names and try again.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const reason = await onSave(parsed.data);
      if (reason) setError(reason);
      else setStatus('Layout saved.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Drag a property into a section, or use the move buttons and the section selector.
      </p>

      {layout.sections.map((section, sectionIndex) => (
        <section
          key={section.id}
          aria-label={`${section.label} section`}
          className="rounded-lg border p-4"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const sourceSection = event.dataTransfer.getData(SECTION_TYPE);
            const from = layout.sections.findIndex((entry) => entry.id === sourceSection);
            if (from >= 0 && from !== sectionIndex) moveSection(from, sectionIndex - from);
            const key = event.dataTransfer.getData(KEY_TYPE);
            if (key !== '') place(key, section.id);
          }}
        >
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              draggable
              aria-label={`Drag ${section.label} section`}
              onDragStart={(event) => event.dataTransfer.setData(SECTION_TYPE, section.id)}
            >
              ↕
            </Button>
            <Input
              className="min-w-40 flex-1"
              aria-label={`Section ${sectionIndex + 1} name`}
              maxLength={80}
              value={section.label}
              onChange={(event) =>
                change((sections) =>
                  sections.map((entry) =>
                    entry.id === section.id ? { ...entry, label: event.target.value } : entry,
                  ),
                )
              }
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Move ${section.label} section up`}
              disabled={sectionIndex === 0}
              onClick={() => moveSection(sectionIndex, -1)}
            >
              Up
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Move ${section.label} section down`}
              disabled={sectionIndex === layout.sections.length - 1}
              onClick={() => moveSection(sectionIndex, 1)}
            >
              Down
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Remove ${section.label} section`}
              disabled={section.keys.length > 0 || layout.sections.length === 1}
              onClick={() =>
                change((sections) => sections.filter((entry) => entry.id !== section.id))
              }
            >
              Remove
            </Button>
          </div>

          {section.keys.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">
              Nothing here yet. Drop a property here, or add one from Not in the layout.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {section.keys.map((key, index) => {
                const label = labelOf(key);
                return (
                  <li
                    key={key}
                    draggable
                    onDragStart={(event) => event.dataTransfer.setData(KEY_TYPE, key)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      const dragged = event.dataTransfer.getData(KEY_TYPE);
                      if (dragged !== '' && dragged !== key) place(dragged, section.id, key);
                    }}
                    className="flex flex-wrap items-center gap-2 rounded border bg-muted/20 p-2"
                  >
                    <span className="mr-auto text-sm">
                      {label}
                      {visibleByKey.has(key) ? null : (
                        <span className="ml-2 text-xs text-muted-foreground">Not shown</span>
                      )}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Move ${label} up`}
                      disabled={index === 0}
                      onClick={() => place(key, section.id, section.keys[index - 1])}
                    >
                      ↑
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Move ${label} down`}
                      disabled={index === section.keys.length - 1}
                      onClick={() => place(key, section.id, section.keys[index + 2])}
                    >
                      ↓
                    </Button>
                    <NativeSelect
                      className="w-auto"
                      aria-label={`Section for ${label}`}
                      value={section.id}
                      onChange={(event) => place(key, event.target.value)}
                    >
                      {layout.sections.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.label}
                        </option>
                      ))}
                    </NativeSelect>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove ${label} from layout`}
                      onClick={() => unplace(key)}
                    >
                      Remove
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ))}

      <section aria-labelledby="layout-unplaced" className="rounded-lg border border-dashed p-4">
        <h3 id="layout-unplaced" className="mb-2 text-sm font-medium">
          Not in the layout
        </h3>
        {unplaced.length === 0 ? (
          <p className="text-sm text-muted-foreground">Every property is in a section.</p>
        ) : (
          <ul aria-labelledby="layout-unplaced" className="flex flex-col gap-2">
            {unplaced.map((property) => (
              <li
                key={property.key}
                className="flex flex-wrap items-center gap-2 rounded border bg-muted/20 p-2"
              >
                <span className="mr-auto text-sm">{property.label}</span>
                {layout.sections.map((section) => (
                  <Button
                    key={section.id}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => place(property.key, section.id)}
                  >
                    Add {property.label} to {section.label}
                  </Button>
                ))}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={layout.sections.length >= LAYOUT_MAX_SECTIONS}
          onClick={() =>
            change((sections) => [
              ...sections,
              { id: newSectionId(), label: 'New section', keys: [] },
            ])
          }
        >
          Add section
        </Button>
        <Button type="button" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save layout'}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <p role="status" aria-live="polite" className="text-sm">
        {status}
      </p>
    </div>
  );
}
