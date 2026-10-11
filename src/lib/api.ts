import type {
  MissingProductsScanResult,
  MissingProductsExportSummary,
  MissingSupplier,
  PriceApplyBatchResult,
  PriceApplyItemResult,
  PricePreview,
  PriceSupplierInfo,
  RecentRun,
  SessionResponse,
  SkuApplyResult,
  SkuMigrationPreview,
  SkuSupplierInfo,
  StatusResponse,
  SupplierCategory,
  SupplierKey,
  SyncTarget,
} from './types';

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function parseResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new ApiError(data.error || 'Заявката не бе изпълнена.', res.status);
  }
  return data as T;
}

export async function getSession() {
  const res = await fetch('/api/session', { credentials: 'same-origin' });
  return parseResponse<SessionResponse>(res);
}

export async function login(password: string) {
  const res = await fetch('/api/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ password }),
  });
  return parseResponse<{ ok: true }>(res);
}

export async function logout() {
  const res = await fetch('/api/logout', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  return parseResponse<{ ok: true }>(res);
}

export async function getStatus() {
  const res = await fetch('/api/status', { credentials: 'same-origin' });
  return parseResponse<StatusResponse>(res);
}

export async function getRuns() {
  const res = await fetch('/api/runs', { credentials: 'same-origin' });
  return parseResponse<{ runs: RecentRun[]; volatile: boolean; logDir: string }>(res);
}

export async function runSync(payload: {
  target: SyncTarget;
  supplierKey: SupplierKey;
  dryRun: boolean;
  confirm?: boolean;
  allowLargeApply?: boolean;
  previewToken?: string;
}) {
  const res = await fetch('/api/sync', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseResponse<{ ok: true; logs: string[]; summary: NonNullable<StatusResponse['run']>['summary'] }>(res);
}

export async function getMissingSuppliers() {
  const res = await fetch('/api/missing-products/suppliers', { credentials: 'same-origin' });
  return parseResponse<{ suppliers: MissingSupplier[] }>(res);
}

export async function getMissingCategories(supplier: SupplierKey) {
  const params = new URLSearchParams({ supplier });
  const res = await fetch(`/api/missing-products/categories?${params}`, { credentials: 'same-origin' });
  return parseResponse<{ supplier: SupplierKey; categories: SupplierCategory[] }>(res);
}

export async function scanMissingProducts(supplier: SupplierKey, categoryId: string) {
  const res = await fetch('/api/missing-products/scan', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ supplier, categoryId }),
  });
  return parseResponse<MissingProductsScanResult>(res);
}

function parseExportSummary(header: string | null): MissingProductsExportSummary | null {
  if (!header) return null;
  try {
    const normalized = header.replaceAll('-', '+').replaceAll('_', '/');
    return JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')));
  } catch {
    return null;
  }
}

export async function exportMissingProducts(supplier: SupplierKey, categoryId: string, productIds: string[]) {
  const res = await fetch('/api/missing-products/export', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ supplier, categoryId, productIds }),
  });

  if (!res.ok) {
    await parseResponse<never>(res);
  }

  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') || '';
  const filenameMatch = disposition.match(/filename="([^"]+)"/);
  return {
    blob,
    filename: filenameMatch?.[1] || 'missing-products.csv',
    summary: parseExportSummary(res.headers.get('X-Mebelcenter-Export-Summary')),
  };
}

// ---------- Prices ----------

export async function getPriceSuppliers() {
  const res = await fetch('/api/prices/suppliers', { credentials: 'same-origin' });
  return parseResponse<{ suppliers: PriceSupplierInfo[] }>(res);
}

export type SellingOpInput = { operation: 'keep' | 'source' | 'multiplier'; multiplier?: number | null };
export type CompareOpInput = { operation: 'keep' | 'clear' | 'source' | 'multiplier'; multiplier?: number | null };

export async function previewPrices(supplier: SupplierKey, selling: SellingOpInput, compare: CompareOpInput) {
  const res = await fetch('/api/prices/preview', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ supplier, selling, compare }),
  });
  return parseResponse<PricePreview>(res);
}

export type ApplyBatchItem = { variantId: string; sku: string; oldSellingPrice: number | null; oldCompareAtPrice: number | null };

export async function applyPriceBatch(supplier: SupplierKey, selling: SellingOpInput, compare: CompareOpInput, items: ApplyBatchItem[]) {
  const res = await fetch('/api/prices/apply-batch', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ supplier, selling, compare, items }),
  });
  return parseResponse<PriceApplyBatchResult>(res);
}

export type RollbackBatchItem = {
  variantId: string;
  sku: string;
  oldSellingPrice: number | null;
  newSellingPrice: number | null;
  oldCompareAtPrice: number | null;
  newCompareAtPrice: number | null;
  sellingChanged: boolean;
  compareChanged: boolean;
};

export async function rollbackPriceBatch(supplier: SupplierKey, items: RollbackBatchItem[]) {
  const res = await fetch('/api/prices/rollback-batch', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ supplier, items }),
  });
  return parseResponse<{ results: PriceApplyItemResult[] }>(res);
}

// ---------- SKU migration ----------

export const SKU_API_VERSION = 'inventory-item-sku-v2';

export async function getSkuSuppliers() {
  const res = await fetch('/api/sku/suppliers', { credentials: 'same-origin' });
  return parseResponse<{ apiVersion?: string; suppliers: SkuSupplierInfo[] }>(res);
}

export async function previewSkuMigration(supplier: SupplierKey) {
  const res = await fetch('/api/sku/preview', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ apiVersion: SKU_API_VERSION, supplier }),
  });
  return parseResponse<SkuMigrationPreview>(res);
}

export type SkuApplyItem = { variantId: string; oldSku: string; newSku: string };

export async function applySkuBatch(supplier: SupplierKey, items: SkuApplyItem[]) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetch('/api/sku/apply-batch', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ apiVersion: SKU_API_VERSION, supplier, items }),
      signal: controller.signal,
    });
    return await parseResponse<{ results: SkuApplyResult[]; feedSnapshotAt: string }>(res);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('SKU партидата не отговори до 120 секунди. Проверете server terminal-а и опитайте отново.');
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

// Inventory V2 authorization is carried by signed server-issued batch receipts.
import type { InventoryPreview, InventoryBatchResult, InventoryHistory, IdentityDiscovery } from './types';
async function inventoryPost<T>(path: string, payload: object) {
  const res = await fetch(`/api/inventory/${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return parseResponse<T>(res);
}
export const previewInventory = (supplier: SupplierKey, allowPartial = false) => inventoryPost<InventoryPreview>('preview', { supplier, allowPartial });
export const persistInventoryMappings = (token: string, initializeDefinitions: boolean) => inventoryPost<InventoryBatchResult>('backfill-batch', { token, confirm: true, initializeDefinitions });
export const discoverInventoryIdentities = () => inventoryPost<IdentityDiscovery>('discovery', {});
export const applyInventoryBatch = (supplier: SupplierKey, token: string, allowLargeApply: boolean) => inventoryPost<InventoryBatchResult>('apply-batch', { supplier, token, confirm: true, allowLargeApply });
export async function getInventoryHistory() {
  return parseResponse<{ runs: InventoryHistory[]; durable: boolean }>(await fetch('/api/inventory/history', { credentials: 'same-origin' }));
}
