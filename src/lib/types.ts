export type SupplierKey = 'megapap' | 'b2bmarkt';
export type SyncTarget = 'shopify' | 'b2bcenter';

export type SessionResponse = {
  authenticated: boolean;
  hasDashboardPassword: boolean;
};

export type SyncSummary = {
  target: SyncTarget;
  supplierKey: SupplierKey;
  supplier: string;
  manufacturer: string | null;
  vendor: string | null;
  mode: 'dry-run' | 'apply';
  dryRun: boolean;
  updated: number;
  errors: number;
  skipped: number;
  planned: number;
  elapsed: number | null;
  elapsedSeconds: number | null;
  finishedAt: string | null;
  logFiles?: unknown;
  logs?: string[];
};

export type SyncRun = {
  target: SyncTarget;
  supplierKey: SupplierKey;
  dryRun: boolean;
  logs: string[];
  summary: SyncSummary | null;
};

export type StatusResponse = {
  running: boolean;
  run: SyncRun | null;
};

export type RecentRun = {
  target: SyncTarget;
  supplierKey: SupplierKey;
  supplier: string;
  vendor: string | null;
  mode: 'dry-run' | 'apply';
  updated: number;
  errors: number;
  skipped: number;
  planned: number;
  elapsed: number | null;
  finishedAt: string | null;
};

export type SupplierCategory = {
  id: string;
  name: string;
  productCount: number;
  level: string;
  displayName: string;
  originalName: string;
  originalPath: string;
  parentPath: string;
  parentPathOriginal: string;
  hasTranslation: boolean;
  hasParent: boolean;
};

export type MissingSupplier = {
  key: SupplierKey;
  name: string;
  vendor: string;
  available: boolean;
};

export type MissingProductRow = {
  id: string;
  supplierSku: string;
  title: string;
  category: string;
  supplierPrice: string;
  shopifyPrice: string;
  stock: string;
  availability: string;
  hasImages: boolean;
  imageCount: number;
  validationState: 'valid' | 'warning' | 'blocked';
  importable: boolean;
  validationErrors: string[];
  validationWarnings: string[];
  barcode: string;
  dimensions: Record<string, string | null> | null;
  weightKg: string;
  typePreview: string;
  tagsPreview: string[];
  description: string;
  imageUrls: string[];
};

export type MissingProductsExportSummary = {
  supplier: SupplierKey;
  supplierName: string;
  category: {
    id: string;
    name: string;
  };
  requested: number;
  selected: number;
  exported: number;
  excluded: number;
  warningProducts: number;
  blockedExcluded: number;
  duplicateExcluded: number;
  missingImages: number;
  zeroStock: number;
  rows: number;
  durationMs: number;
  excludedProducts?: Array<{ id: string; sku: string; title: string; reasons: string[] }>;
};

export type MissingProductsScanResult = {
  supplier: SupplierKey;
  supplierName: string;
  category: {
    id: string;
    name: string;
  };
  totals: {
    supplierProducts: number;
    alreadyInShopify: number;
    missing: number;
    invalid: number;
    duplicateCodes: number;
    shopifyVariants: number;
  };
  missingProducts: MissingProductRow[];
  warnings: string[];
  durationMs: number;
};
