'use client';

import { useState, type FormEvent } from 'react';
import type { SavedView } from '@gt-sales/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Popover,
  PopoverTrigger,
} from '@gt-sales/ui';
import { ChevronDownIcon, PencilIcon, Trash2Icon } from 'lucide-react';

import { BarButton, MenuItem, MenuLabel, MenuPanel, MenuSeparator } from '../crm/menu';

/**
 * Every callback that can fail resolves to the message to show (the inbox
 * turns the backend's error into words) or to `undefined` on success.
 */
export interface SavedViewSwitcherProps {
  views: readonly SavedView[];
  /** The view the list was opened from; `undefined` is "All leads", the unsaved default. */
  activeViewId: string | undefined;
  /** The list differs from the saved view (or, on All leads, from the default). */
  dirty: boolean;
  /** How many leads the view matches, when that is known. */
  total: number | undefined;
  onSelect(viewId: string | undefined): void;
  onSave(): Promise<string | undefined>;
  onSaveAs(name: string): Promise<string | undefined>;
  onRename(view: SavedView, name: string): Promise<string | undefined>;
  onDelete(view: SavedView): Promise<string | undefined>;
}

type DialogState =
  { kind: 'saveAs' } | { kind: 'rename'; view: SavedView } | { kind: 'delete'; view: SavedView };

/** A small dialog with one labelled name field; stays open and shows the message when refused. */
function NameDialog({
  title,
  description,
  submitLabel,
  initialName,
  onSubmit,
  onClose,
}: {
  title: string;
  description: string;
  submitLabel: string;
  initialName: string;
  onSubmit(name: string): Promise<string | undefined>;
  onClose(): void;
}) {
  const [name, setName] = useState(initialName);
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trimmed || busy) return;
    setBusy(true);
    setMessage(undefined);
    const failure = await onSubmit(trimmed);
    setBusy(false);
    if (failure === undefined) onClose();
    else setMessage(failure);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <label className="flex flex-col gap-1 text-sm font-medium">
            View name
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={60}
              autoComplete="off"
              autoFocus
            />
          </label>
          {message ? (
            <p role="alert" className="text-sm text-destructive">
              {message}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!trimmed || busy}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  view,
  onDelete,
  onClose,
}: {
  view: SavedView;
  onDelete(view: SavedView): Promise<string | undefined>;
  onClose(): void;
}) {
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    setMessage(undefined);
    const failure = await onDelete(view);
    setBusy(false);
    if (failure === undefined) onClose();
    else setMessage(failure);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete view</DialogTitle>
          <DialogDescription>
            “{view.name}” will be removed from your saved views. The leads are not affected.
          </DialogDescription>
        </DialogHeader>
        {message ? (
          <p role="alert" className="text-sm text-destructive">
            {message}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" disabled={busy} onClick={confirm}>
            Delete view
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The view bar's left side: the active saved view (or "All leads") as a menu
 * of the viewer's own views, and, while the list differs from the saved view,
 * a dirty dot with "Save" (the view itself) and "Save as new view".
 */
export function SavedViewSwitcher({
  views,
  activeViewId,
  dirty,
  total,
  onSelect,
  onSave,
  onSaveAs,
  onRename,
  onDelete,
}: SavedViewSwitcherProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogState>();
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();
  const active = views.find((view) => view.id === activeViewId);

  function choose(viewId: string | undefined) {
    setMenuOpen(false);
    setMessage(undefined);
    onSelect(viewId);
  }

  function openDialog(next: DialogState) {
    setMenuOpen(false);
    setDialog(next);
  }

  async function save() {
    setSaving(true);
    setMessage(undefined);
    const failure = await onSave();
    setSaving(false);
    setMessage(failure);
  }

  return (
    <div className="flex items-center gap-1">
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <BarButton className="text-foreground">
            <span className="max-w-48 truncate">{active?.name ?? 'All leads'}</span>
            {dirty ? (
              <>
                <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
                <span className="sr-only">Unsaved changes</span>
              </>
            ) : null}
            {total !== undefined ? (
              <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">
                {total}
              </span>
            ) : null}
            <ChevronDownIcon aria-hidden="true" />
          </BarButton>
        </PopoverTrigger>
        <MenuPanel className="max-h-96 w-64 overflow-y-auto">
          <MenuItem selected={active === undefined} onClick={() => choose(undefined)}>
            All leads
          </MenuItem>
          {views.length > 0 ? (
            <>
              <MenuSeparator />
              <MenuLabel>Saved views</MenuLabel>
            </>
          ) : null}
          {views.map((view) => (
            <div key={view.id} className="flex items-center gap-0.5">
              <MenuItem
                selected={view.id === active?.id}
                className="min-w-0 flex-1"
                onClick={() => choose(view.id)}
              >
                <span className="truncate">{view.name}</span>
              </MenuItem>
              <button
                type="button"
                aria-label={`Rename ${view.name}`}
                className="grid size-7 shrink-0 place-items-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => openDialog({ kind: 'rename', view })}
              >
                <PencilIcon aria-hidden="true" className="size-3.5" />
              </button>
              <button
                type="button"
                aria-label={`Delete ${view.name}`}
                className="grid size-7 shrink-0 place-items-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => openDialog({ kind: 'delete', view })}
              >
                <Trash2Icon aria-hidden="true" className="size-3.5" />
              </button>
            </div>
          ))}
        </MenuPanel>
      </Popover>

      {dirty ? (
        <>
          {active ? (
            <BarButton disabled={saving} onClick={save}>
              Save
            </BarButton>
          ) : null}
          <BarButton onClick={() => openDialog({ kind: 'saveAs' })}>Save as new view</BarButton>
        </>
      ) : null}
      {message ? (
        <span role="alert" className="text-[12px] text-destructive">
          {message}
        </span>
      ) : null}

      {dialog?.kind === 'saveAs' ? (
        <NameDialog
          title="Save as new view"
          description="Saves the current filters, sort and columns. Only you can see your views."
          submitLabel="Save view"
          initialName=""
          onSubmit={onSaveAs}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
      {dialog?.kind === 'rename' ? (
        <NameDialog
          title="Rename view"
          description="Only the name changes; the view’s filters stay as saved."
          submitLabel="Rename"
          initialName={dialog.view.name}
          onSubmit={(name) => onRename(dialog.view, name)}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
      {dialog?.kind === 'delete' ? (
        <DeleteDialog view={dialog.view} onDelete={onDelete} onClose={() => setDialog(undefined)} />
      ) : null}
    </div>
  );
}
