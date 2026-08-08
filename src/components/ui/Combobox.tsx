import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';

export type ComboboxOption = {
  value: string;
  primary: string;
  secondary?: string;
  meta?: string;
  searchText?: string;
  disabled?: boolean;
};

type ComboboxState = 'idle' | 'loading' | 'error' | 'empty';

type ComboboxProps = {
  value: string;
  options: ComboboxOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  state?: ComboboxState;
  errorMessage?: string;
  emptyMessage?: string;
  loadingMessage?: string;
  noResultsMessage?: string;
  ariaLabel?: string;
  id?: string;
  renderSelected?: (option: ComboboxOption | null) => ReactNode;
};

export function Combobox({
  value,
  options,
  onChange,
  placeholder = 'Изберете…',
  searchPlaceholder = 'Търсене…',
  disabled = false,
  state = 'idle',
  errorMessage = 'Категориите не можаха да се заредят.',
  emptyMessage = 'Няма налични категории.',
  loadingMessage = 'Зареждане…',
  noResultsMessage = 'Няма съвпадения.',
  ariaLabel,
  id,
  renderSelected,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const autoId = useId();
  const listId = `${id || autoId}-listbox`;

  const isDisabled = disabled || state === 'loading' || state === 'error' || state === 'empty';
  const selected = options.find((option) => option.value === value) || null;

  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    if (!q) return options;
    return options.filter((option) => {
      const hay = (option.searchText || `${option.primary} ${option.secondary || ''}`).toLocaleLowerCase();
      return hay.includes(q);
    });
  }, [options, query]);

  const closeMenu = useCallback(() => {
    setOpen(false);
    setQuery('');
    setActiveIndex(-1);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closeMenu();
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open, closeMenu]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (!filtered.length) {
      setActiveIndex(-1);
      return;
    }
    const idx = filtered.findIndex((option) => option.value === value);
    setActiveIndex(idx >= 0 ? idx : 0);
  }, [open, filtered, value]);

  useEffect(() => {
    if (!open || activeIndex < 0 || !listRef.current) return;
    const el = listRef.current.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  function pickIndex(index: number) {
    const option = filtered[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    closeMenu();
  }

  function handleTriggerKey(event: React.KeyboardEvent) {
    if (isDisabled) return;
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen(true);
    }
  }

  function handleInputKey(event: React.KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => Math.min(filtered.length - 1, current + 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => Math.max(0, current - 1));
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(filtered.length - 1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (activeIndex >= 0) pickIndex(activeIndex);
    }
  }

  const triggerContent = renderSelected ? (
    renderSelected(selected)
  ) : selected ? (
    <span className="mc-combo-selected">
      <span className="mc-combo-selected-primary">{selected.primary}</span>
      {selected.secondary ? <span className="mc-combo-selected-secondary">{selected.secondary}</span> : null}
    </span>
  ) : (
    <span className="mc-combo-placeholder">
      {state === 'loading' ? loadingMessage : state === 'error' ? errorMessage : state === 'empty' ? emptyMessage : placeholder}
    </span>
  );

  return (
    <div ref={rootRef} className={`mc-combo${open ? ' is-open' : ''}${isDisabled ? ' is-disabled' : ''}`}>
      <button
        type="button"
        id={id}
        className="mc-combo-trigger"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listId}
        aria-label={ariaLabel}
        disabled={isDisabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleTriggerKey}
      >
        {triggerContent}
        <span className="mc-combo-caret" aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div className="mc-combo-panel" role="dialog">
          <div className="mc-combo-search">
            <input
              ref={inputRef}
              type="text"
              value={query}
              placeholder={searchPlaceholder}
              aria-controls={listId}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleInputKey}
            />
          </div>
          <ul ref={listRef} id={listId} role="listbox" className="mc-combo-menu">
            {filtered.length ? (
              filtered.map((option, index) => {
                const isActive = index === activeIndex;
                const isSelected = option.value === value;
                return (
                  <li
                    key={option.value}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={option.disabled || undefined}
                    className={`mc-option${isActive ? ' is-active' : ''}${isSelected ? ' is-selected' : ''}${option.disabled ? ' is-disabled' : ''}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      pickIndex(index);
                    }}
                  >
                    <div className="mc-option-body">
                      <span className="mc-option-label">{option.primary}</span>
                      {option.secondary ? <span className="mc-option-sub">{option.secondary}</span> : null}
                    </div>
                    {option.meta ? <span className="mc-option-meta">{option.meta}</span> : null}
                  </li>
                );
              })
            ) : (
              <li className="mc-combo-empty">{query ? noResultsMessage : emptyMessage}</li>
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
