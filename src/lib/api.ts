import type {
  MissingProductsScanResult,
  MissingProductsExportSummary,
  MissingSupplier,
  RecentRun,
  SessionResponse,
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
