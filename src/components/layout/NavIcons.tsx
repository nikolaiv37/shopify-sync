type IconProps = { className?: string };

const common = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

/** Табло — dashboard grid. */
export function HomeIcon({ className }: IconProps) {
  return (
    <svg className={className} {...common}>
      <rect x="3" y="3" width="7" height="8" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="11" width="7" height="10" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

/** Наличности — inventory / stock (package). */
export function InventoryIcon({ className }: IconProps) {
  return (
    <svg className={className} {...common}>
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <path d="M3.3 7 12 12l8.7-5" />
      <path d="M12 22V12" />
    </svg>
  );
}

/** Цени — pricing / price tag. */
export function PricesIcon({ className }: IconProps) {
  return (
    <svg className={className} {...common}>
      <path d="M20.6 12.5 12.5 20.6a1.9 1.9 0 0 1-2.7 0l-6.4-6.4a1.9 1.9 0 0 1-.5-1.7l1-5.6a1.9 1.9 0 0 1 1.6-1.6l5.6-1a1.9 1.9 0 0 1 1.7.5l6.4 6.4a1.9 1.9 0 0 1 0 2.8Z" />
      <circle cx="8.5" cy="8.5" r="1.4" />
    </svg>
  );
}

/** Липсващи продукти — find gaps in the catalog (package + search). */
export function MissingIcon({ className }: IconProps) {
  return (
    <svg className={className} {...common}>
      <path d="M21 10V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l6 3.43" />
      <path d="M3.3 7 12 12l8.7-5" />
      <path d="M12 22V12" />
      <circle cx="17.5" cy="16.5" r="3" />
      <path d="m21 20-1.5-1.5" />
    </svg>
  );
}
