import { useCallback, useEffect, useId, useRef, useState } from 'react';

export type SelectOption<T extends string = string> = {
  value: T;
  label: string;
  description?: string;
  disabled?: boolean;
};

type SelectProps<T extends string = string> = {
  value: T | '';
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  placeholder?: string;
  disabled?: boolean;
  loading?: boolean;
  ariaLabel?: string;
  id?: string;
};

export function Select<T extends string = string>({
  value,
  options,
  onChange,
  placeholder = 'Изберете…',
  disabled = false,
  loading = false,
  ariaLabel,
  id,
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const autoId = useId();
  const listId = `${id || autoId}-listbox`;

  const selected = options.find((option) => option.value === value) || null;
  const isDisabled = disabled || loading || !options.length;

  const closeMenu = useCallback(() => {
    setOpen(false);
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
    if (!open) return;
    const idx = options.findIndex((option) => option.value === value);
    setActiveIndex(idx >= 0 ? idx : 0);
  }, [open, options, value]);

  useEffect(() => {
    if (!open || activeIndex < 0 || !listRef.current) return;
    const el = listRef.current.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  function pickIndex(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    closeMenu();
  }

  function handleKey(event: React.KeyboardEvent) {
    if (isDisabled) return;
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => Math.min(options.length - 1, current + 1));
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
      setActiveIndex(options.length - 1);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (activeIndex >= 0) pickIndex(activeIndex);
    }
  }

  return (
    <div ref={rootRef} className={`mc-select${open ? ' is-open' : ''}${isDisabled ? ' is-disabled' : ''}`}>
      <button
        type="button"
        id={id}
        className="mc-select-trigger"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listId}
        aria-label={ariaLabel}
        disabled={isDisabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleKey}
      >
        <span className={`mc-select-value${selected ? '' : ' is-placeholder'}`}>
          {loading ? 'Зареждане…' : selected ? selected.label : placeholder}
        </span>
        <span className="mc-select-caret" aria-hidden="true">▾</span>
      </button>
      {open ? (
        <ul ref={listRef} id={listId} role="listbox" className="mc-select-menu">
          {options.map((option, index) => {
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
                <span className="mc-option-label">{option.label}</span>
                {option.description ? <span className="mc-option-meta">{option.description}</span> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
