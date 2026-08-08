export type SupplierKey = 'megapap' | 'b2bmarkt' | 'symetron';
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
  priceMultiplier: number | null;
};

export type MissingProductRow = {
  id: string;
  supplierSku: string;
  title: string;
  category: string;
  categoryDisplay: string;
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

export type SellingOperationType = 'keep' | 'source' | 'multiplier';
export type CompareOperationType = 'keep' | 'clear' | 'source' | 'multiplier';

export type PriceOperation = {
  type: SellingOperationType | CompareOperationType;
  multiplier: number | null;
  effectiveMultiplier: number | null;
  markupPercent: number | null;
};

export type PriceSupplierInfo = {
  key: SupplierKey;
  name: string;
  vendor: string;
  skuField: string | null;
  sourceField: string | null;
  defaultMultiplier: number;
  defaultMarkupPercent: number;
  applyEnabled: boolean;
  batchSize: number;
};

export type PriceRowStatus = 'change' | 'already' | 'unmatched' | 'invalid_price' | 'conflict';

export type PriceRow = {
  sku: string;
  title: string;
  wholesale: number | null;
  currentPrice: number | null;
  target: number | null;
  diff: number | null;
  currentCompareAt: number | null;
  targetCompareAt: number | null | undefined;
  compareMode: 'keep' | 'set' | 'clear';
  sellingChanged: boolean;
  compareChanged: boolean;
  compareWarn: boolean;
  status: PriceRowStatus;
  reason: string | null;
  variantId: string | null;
  productId: string | null;
  vendor: string | null;
  selectable: boolean;
};

export type PricePreviewSummary = {
  supplier: SupplierKey;
  vendor: string;
  selling: PriceOperation | null;
  compare: PriceOperation | null;
  feedProducts: number;
  feedRows: number;
  feedEmptySku: number;
  feedDuplicateSku: number;
  matched: number;
  toChange: number;
  alreadyCorrect: number;
  unmatched: number;
  invalidPrice: number;
  conflict: number;
  changeSellingOnly: number;
  changeCompareOnly: number;
  changeBoth: number;
  compareWarnings: number;
};

export type PricePreview = {
  supplier: PriceSupplierInfo;
  selling: PriceOperation;
  compare: PriceOperation;
  generatedAt: string;
  feedSnapshotAt: string;
  warnings: string[];
  rows: PriceRow[];
  summary: PricePreviewSummary;
};

export type PriceApplyItemResult = {
  sku: string;
  variantId: string;
  status: 'success' | 'skipped_stale' | 'conflict' | 'failed' | 'already';
  sellingChanged?: boolean;
  compareChanged?: boolean;
  oldSellingPrice?: number | null;
  newSellingPrice?: number | null;
  oldCompareAtPrice?: number | null;
  newCompareAtPrice?: number | null;
  wholesale?: number | null;
  reason?: string;
  error?: string;
};

export type PriceApplyBatchResult = {
  results: PriceApplyItemResult[];
  feedSnapshotAt?: string;
};

export type MissingProductsScanResult = {
  supplier: SupplierKey;
  supplierName: string;
  category: {
    id: string;
    name: string;
    displayName: string;
    originalName: string;
    originalPath: string;
    parentPath: string;
    hasTranslation: boolean;
    hasParent: boolean;
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
