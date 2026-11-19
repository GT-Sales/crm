'use client';

import * as React from 'react';
import { CheckIcon, SearchIcon } from 'lucide-react';

import { cn } from '../lib/utils';

/**
 * A searchable list for a popover (the shadcn Command pattern, without the
 * extra dependency): a search box that owns the keyboard (Up and Down move the
 * highlight, Home and End jump, Enter chooses, Escape is left to the popover)
 * over a listbox, announced to screen readers as a combobox with the
 * highlighted option as its active descendant.
 *
 * It filters the options itself by default. A caller that searches elsewhere
 * (a server) sets `shouldFilter={false}` and listens to `onQueryChange`.
 */

export interface CommandOption {
  value: string;
  label: string;
  /** A muted second line (a reference, a role). */
  description?: string;
  icon?: React.ReactNode;
  /** More words the search matches. */
  keywords?: string;
}

export interface CommandProps {
  /** The accessible name of the search box and the list. */
  label: string;
  placeholder?: string;
  options: readonly CommandOption[];
  /** The option already chosen: it carries a tick. */
  selected?: string;
  onSelect(value: string): void;
  shouldFilter?: boolean;
  onQueryChange?(query: string): void;
  emptyText?: string;
  loading?: boolean;
  className?: string;
}

function matches(option: CommandOption, query: string): boolean {
  const haystack =
    `${option.label} ${option.description ?? ''} ${option.keywords ?? ''}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

function Command({
  label,
  placeholder,
  options,
  selected,
  onSelect,
  shouldFilter = true,
  onQueryChange,
  emptyText = 'No results.',
  loading = false,
  className,
}: CommandProps) {
  const [query, setQuery] = React.useState('');
  const [active, setActive] = React.useState(0);
  const listId = React.useId();
  const listRef = React.useRef<HTMLUListElement>(null);
  const visible = React.useMemo(
    () => (shouldFilter && query.trim() ? options.filter((o) => matches(o, query)) : options),
    [options, query, shouldFilter],
  );
  const current = Math.min(active, Math.max(visible.length - 1, 0));
  const optionId = (index: number) => `${listId}-${index}`;

  React.useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[id="${optionId(current)}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, visible]);

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (visible.length === 0) return;
    const last = visible.length - 1;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActive(current >= last ? 0 : current + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActive(current <= 0 ? last : current - 1);
        break;
      case 'Home':
        event.preventDefault();
        setActive(0);
        break;
      case 'End':
        event.preventDefault();
        setActive(last);
        break;
      case 'Enter': {
        // Results still on screen belong to the previous search; choosing one
        // now would pick something the person did not see for this query.
        if (loading) {
          event.preventDefault();
          break;
        }
        const option = visible[current];
        if (!option) break;
        event.preventDefault();
        onSelect(option.value);
        break;
      }
    }
  }

  return (
    <div data-slot="command" className={cn('flex min-w-0 flex-col', className)}>
      <div className="flex items-center gap-2 border-b px-3">
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input
          type="text"
          role="combobox"
          aria-label={label}
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={visible.length > 0 ? optionId(current) : undefined}
          autoComplete="off"
          spellCheck={false}
          value={query}
          placeholder={placeholder}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            onQueryChange?.(event.target.value);
          }}
          onKeyDown={onKeyDown}
          className="h-10 w-full min-w-0 bg-transparent text-base outline-none placeholder:text-muted-foreground md:text-sm"
        />
      </div>
      <ul
        id={listId}
        ref={listRef}
        role="listbox"
        aria-label={label}
        className="max-h-64 overflow-y-auto overscroll-contain p-1"
      >
        {visible.map((option, index) => (
          <li
            key={option.value}
            id={optionId(index)}
            role="option"
            aria-selected={index === current}
            data-active={index === current ? '' : undefined}
            // Keep focus in the search box while the pointer works the list.
            onMouseDown={(event) => event.preventDefault()}
            onMouseMove={() => setActive(index)}
            onClick={() => onSelect(option.value)}
            className="flex min-h-9 cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm data-[active]:bg-accent data-[active]:text-accent-foreground"
          >
            {option.icon}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{option.label}</span>
              {option.description ? (
                <span className="truncate text-xs text-muted-foreground">{option.description}</span>
              ) : null}
            </span>
            {option.value === selected ? (
              <>
                <CheckIcon className="size-4 shrink-0" aria-hidden="true" />
                <span className="sr-only">(current)</span>
              </>
            ) : null}
          </li>
        ))}
      </ul>
      <p
        role="status"
        className={cn(
          'px-3 py-3 text-center text-sm text-muted-foreground',
          (visible.length > 0 || loading) && 'sr-only',
        )}
      >
        {loading ? 'Searching…' : visible.length === 0 ? emptyText : `${visible.length} results`}
      </p>
    </div>
  );
}

export { Command };
