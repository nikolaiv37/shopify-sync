import type { MissingProductRow } from './types';

/**
 * Operator-facing export status, derived from the existing validation model
 * WITHOUT changing eligibility. Internal states map as follows:
 *   blocked (validation errors)            -> 'blocked'  (не може да се експортира)
 *   warning w/ a meaningful reason         -> 'notes'    (може, но има забележки)
 *   valid, or only informational warnings  -> 'ready'    (готов за експорт)
 *
 * `category-unmapped` is informational only: the product still exports fine
 * (its Shopify Type falls back to the raw category, Tags stay empty), so it is
 * not treated as an attention-worthy note.
 */
export type ExportStatus = 'ready' | 'notes' | 'blocked';

const INFO_ONLY_REASONS = new Set(['category-unmapped']);

export function meaningfulWarnings(row: MissingProductRow): string[] {
  return row.validationWarnings.filter((reason) => !INFO_ONLY_REASONS.has(reason));
}

export function infoWarnings(row: MissingProductRow): string[] {
  return row.validationWarnings.filter((reason) => INFO_ONLY_REASONS.has(reason));
}

export function exportStatus(row: MissingProductRow): ExportStatus {
  if (!row.importable) return 'blocked';
  return meaningfulWarnings(row).length ? 'notes' : 'ready';
}

/** Short label used in the table status pill. */
export const statusLabel: Record<ExportStatus, string> = {
  ready: 'Готов за експорт',
  notes: 'Със забележки',
  blocked: 'Не може да се експортира',
};

/** Operator-facing reason text for a validation error/warning code. */
const reasonLabels: Record<string, string> = {
  'missing-sku': 'Липсва код (SKU)',
  'missing-title': 'Липсва име на продукта',
  'missing-price': 'Липсва цена',
  'no-image': 'Липсва основна снимка',
  'category-unmapped': 'Категорията не е напълно мапната към Shopify тип/колекция',
  'already-in-shopify': 'Вече съществува в Shopify',
  'duplicate-supplier-sku': 'Дублиран код от доставчика',
  'duplicate-selected-sku': 'Дублиран избран код',
};

export function reasonText(reason: string): string {
  return reasonLabels[reason] || reason;
}
