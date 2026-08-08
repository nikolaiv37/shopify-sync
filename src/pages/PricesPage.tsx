import { useEffect, useMemo, useRef, useState } from 'react';
import { DashboardLayout } from '../components/layout/DashboardLayout';
import { Button } from '../components/ui/Buttons';
import { Select } from '../components/ui/Select';
import { Progress } from '../components/feedback/Progress';
import {
  applyPriceBatch,
  getPriceSuppliers,
  previewPrices,
  rollbackPriceBatch,
  type ApplyBatchItem,
  type CompareOpInput,
  type RollbackBatchItem,
  type SellingOpInput,
} from '../lib/api';
import type { PriceApplyItemResult, PricePreview, PriceRow, PriceSupplierInfo, SupplierKey } from '../lib/types';

const nf = new Intl.NumberFormat('bg-BG');
const fmt = (n: unknown) => nf.format(Number(n) || 0);
const eur = new Intl.NumberFormat('bg-BG', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (n: number | null | undefined) => (n == null ? '—' : eur.format(n));

type SellingType = 'keep' | 'source' | 'multiplier';
type CompareType = 'keep' | 'clear' | 'source' | 'multiplier';
type PreviewFilter = 'all' | 'change' | 'already' | 'problem' | 'unmatched';
type ResultFilter = 'all' | 'success' | 'skipped' | 'errors';

const statusLabel: Record<PriceRow['status'], string> = {
  change: 'За промяна',
  already: 'Вече актуална',
  unmatched: 'Без съвпадение',
  invalid_price: 'Проблем',
  conflict: 'Проблем',
};

const conflictReason: Record<string, string> = {
  'duplicate-shopify-sku': 'Дублиран SKU в Shopify',
  'duplicate-feed-sku': 'Дублиран SKU във feed-а',
  'vendor-mismatch': 'Различен доставчик в Shopify',
  'invalid-wholesale': 'Невалидна доставна цена',
  'no-shopify-match': 'Няма съвпадение в Shopify',
  'sku-mismatch': 'SKU не съвпада',
  'variant-missing': 'Продуктът липсва в Shopify',
  'not-in-feed': 'Липсва в текущия feed',
  'changed-after-preview': 'Променена след прегледа',
  'changed-after-job': 'Променена след актуализацията',
  'variant-missing-or-mismatch': 'Продуктът липсва или не съвпада',
};

function reasonText(reason: string | null | undefined) {
  if (!reason) return '';
  return conflictReason[reason] || reason;
}

function statusPillClass(status: PriceRow['status']) {
  if (status === 'change') return 'change';
  if (status === 'already') return 'already';
  if (status === 'unmatched') return 'unmatched';
  return 'conflict';
}

function parseMultInput(raw: string): number | null {
  const s = raw.trim().replace(',', '.');
  if (!s) return null;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function sellLabel(type: SellingType, m: number | null): string {
  if (type === 'keep') return 'Не се променя';
  return type === 'source' ? 'Върни към доставна цена' : `Коефициент × ${m != null ? nf.format(m) : '—'}`;
}
function cmpLabel(type: CompareType, m: number | null): string {
  if (type === 'keep') return 'Не се променя';
  if (type === 'clear') return 'Изчистване';
  if (type === 'source') return 'Върни към доставна цена';
  return `Коефициент × ${m != null ? nf.format(m) : '—'}`;
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

type ApplyProgress = {
  total: number;
  processed: number;
  success: number;
  skipped: number;
  conflict: number;
  failed: number;
  running: boolean;
  done: boolean;
  kind: 'apply' | 'rollback';
  label: string;
};

export function PricesPage() {
  const [supplier, setSupplier] = useState<PriceSupplierInfo | null>(null);
  const [loadingSupplier, setLoadingSupplier] = useState(true);

  const [sellType, setSellType] = useState<SellingType>('multiplier');
  const [sellMult, setSellMult] = useState('2.50');
  const [cmpType, setCmpType] = useState<CompareType>('keep');
  const [cmpMult, setCmpMult] = useState('3.20');

  const [preview, setPreview] = useState<PricePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState('');

  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState<PreviewFilter>('change');
  const [search, setSearch] = useState('');
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(1);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [progress, setProgress] = useState<ApplyProgress | null>(null);
  const [applyResults, setApplyResults] = useState<PriceApplyItemResult[]>([]);
  const [resultFilter, setResultFilter] = useState<ResultFilter>('all');
  const abortRef = useRef(false);

  useEffect(() => {
    getPriceSuppliers()
      .then((data) => setSupplier(data.suppliers[0] || null))
      .catch((err) => setError(err instanceof Error ? err.message : 'Информацията за доставчика не се зареди.'))
      .finally(() => setLoadingSupplier(false));
  }, []);

  const sellParsed = useMemo(() => parseMultInput(sellMult), [sellMult]);
  const cmpParsed = useMemo(() => parseMultInput(cmpMult), [cmpMult]);
  const sellValid = sellType === 'keep' || sellType === 'source' || sellParsed != null;
  const cmpValid = cmpType !== 'multiplier' || cmpParsed != null;
  const hasActiveOperation = sellType !== 'keep' || cmpType !== 'keep';
  const opsValid = sellValid && cmpValid && hasActiveOperation;
  const sellMarkup = sellType === 'source' ? 0 : sellParsed != null ? Math.round((sellParsed - 1) * 100) : null;
  const cmpMarkup = cmpType === 'source' ? 0 : cmpType === 'multiplier' && cmpParsed != null ? Math.round((cmpParsed - 1) * 100) : null;

  const sellingOp: SellingOpInput =
    sellType === 'keep' ? { operation: 'keep' } : sellType === 'source' ? { operation: 'source' } : { operation: 'multiplier', multiplier: sellParsed };
  const compareOp: CompareOpInput =
    cmpType === 'multiplier' ? { operation: 'multiplier', multiplier: cmpParsed } : { operation: cmpType };

  // Any change to ANY operation parameter invalidates a prior preview/result.
  useEffect(() => {
    setPreview(null);
    setSelected(new Set());
    setProgress(null);
    setApplyResults([]);
    setError('');
  }, [sellType, sellMult, cmpType, cmpMult]);

  async function onPreview() {
    if (!supplier || !opsValid) return;
    setPreviewing(true);
    setError('');
    setPreview(null);
    setSelected(new Set());
    setFilter('change');
    setSearch('');
    setPage(1);
    setProgress(null);
    setApplyResults([]);
    try {
      const data = await previewPrices(supplier.key as SupplierKey, sellingOp, compareOp);
      setPreview(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Прегледът не бе изпълнен.');
    } finally {
      setPreviewing(false);
    }
  }

  // The operations actually previewed (used for apply, never the live inputs).
  const previewSellingOp: SellingOpInput | null = preview
    ? preview.selling.type === 'keep'
      ? { operation: 'keep' }
      : preview.selling.type === 'source'
      ? { operation: 'source' }
      : { operation: 'multiplier', multiplier: preview.selling.multiplier }
    : null;
  const previewCompareOp: CompareOpInput | null = preview
    ? preview.compare.type === 'multiplier'
      ? { operation: 'multiplier', multiplier: preview.compare.multiplier }
      : { operation: preview.compare.type as CompareType }
    : null;
  const previewLabel = preview
    ? `Продажна: ${sellLabel(preview.selling.type as SellingType, preview.selling.multiplier)} · Сравнителна: ${cmpLabel(preview.compare.type as CompareType, preview.compare.multiplier)}`
    : '';

  const changeRows = useMemo(() => (preview?.rows || []).filter((r) => r.status === 'change'), [preview]);

  const visibleRows = useMemo(() => {
    let rows = preview?.rows || [];
    if (filter === 'change') rows = rows.filter((r) => r.status === 'change');
    else if (filter === 'already') rows = rows.filter((r) => r.status === 'already');
    else if (filter === 'unmatched') rows = rows.filter((r) => r.status === 'unmatched');
    else if (filter === 'problem') rows = rows.filter((r) => r.status === 'conflict' || r.status === 'invalid_price');
    const q = search.trim().toLocaleLowerCase();
    if (!q) return rows;
    return rows.filter((r) => [r.sku, r.title].some((v) => String(v || '').toLocaleLowerCase().includes(q)));
  }, [preview, filter, search]);

  const totalPages = Math.max(1, Math.ceil(visibleRows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = visibleRows.length ? (currentPage - 1) * pageSize : 0;
  const pageRows = visibleRows.slice(pageStart, pageStart + pageSize);
  const pageEnd = pageStart + pageRows.length;

  useEffect(() => setPage(1), [filter, search, pageSize]);

  function toggle(id: string) {
    const row = changeRows.find((r) => r.variantId === id);
    if (!row?.selectable) return;
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function selectAllChange() {
    setSelected(new Set(changeRows.map((r) => r.variantId as string)));
  }
  const selectedCount = selected.size;

  const confirmStats = useMemo(() => {
    const rows = changeRows.filter((r) => selected.has(r.variantId as string));
    let sellingChanges = 0;
    let compareChanges = 0;
    let warns = 0;
    let lowest = Infinity;
    let highest = -Infinity;
    for (const r of rows) {
      if (r.sellingChanged) sellingChanges++;
      if (r.compareChanged) compareChanges++;
      if (r.compareWarn) warns++;
      if (r.target != null) {
        lowest = Math.min(lowest, r.target);
        highest = Math.max(highest, r.target);
      }
    }
    return { count: rows.length, sellingChanges, compareChanges, warns, lowest: Number.isFinite(lowest) ? lowest : null, highest: Number.isFinite(highest) ? highest : null };
  }, [changeRows, selected]);

  function accumulate(results: PriceApplyItemResult[], base: ApplyProgress): ApplyProgress {
    let { success, skipped, conflict, failed } = base;
    for (const r of results) {
      if (r.status === 'success' || r.status === 'already') success++;
      else if (r.status === 'skipped_stale') skipped++;
      else if (r.status === 'conflict') conflict++;
      else if (r.status === 'failed') failed++;
    }
    return { ...base, success, skipped, conflict, failed, processed: base.processed + results.length };
  }

  async function runApply(items: ApplyBatchItem[], sOp: SellingOpInput, cOp: CompareOpInput, label: string) {
    if (!supplier || !items.length) return;
    abortRef.current = false;
    setConfirmOpen(false);
    setResultFilter('all');
    let state: ApplyProgress = { total: items.length, processed: 0, success: 0, skipped: 0, conflict: 0, failed: 0, running: true, done: false, kind: 'apply', label };
    setProgress(state);
    setApplyResults([]);
    const size = supplier.batchSize || 50;
    const collected: PriceApplyItemResult[] = [];
    for (let i = 0; i < items.length; i += size) {
      if (abortRef.current) break;
      const batch = items.slice(i, i + size);
      try {
        const { results } = await applyPriceBatch(supplier.key as SupplierKey, sOp, cOp, batch);
        collected.push(...results);
        state = accumulate(results, state);
      } catch (err) {
        const failedItems: PriceApplyItemResult[] = batch.map((b) => ({ sku: b.sku, variantId: b.variantId, status: 'failed', error: err instanceof Error ? err.message : 'Грешка при заявката.' }));
        collected.push(...failedItems);
        state = accumulate(failedItems, state);
      }
      setProgress({ ...state });
      setApplyResults([...collected]);
    }
    setProgress({ ...state, running: false, done: true });
  }

  function startApply() {
    if (!previewSellingOp || !previewCompareOp) return;
    const items: ApplyBatchItem[] = changeRows
      .filter((r) => selected.has(r.variantId as string))
      .map((r) => ({ variantId: r.variantId as string, sku: r.sku, oldSellingPrice: r.currentPrice, oldCompareAtPrice: r.currentCompareAt }));
    void runApply(items, previewSellingOp, previewCompareOp, previewLabel);
  }

  function retryFailed() {
    if (!previewSellingOp || !previewCompareOp) return;
    const failedIds = new Set(applyResults.filter((r) => r.status === 'failed').map((r) => r.variantId));
    const items: ApplyBatchItem[] = changeRows
      .filter((r) => r.variantId && failedIds.has(r.variantId))
      .map((r) => ({ variantId: r.variantId as string, sku: r.sku, oldSellingPrice: r.currentPrice, oldCompareAtPrice: r.currentCompareAt }));
    void runApply(items, previewSellingOp, previewCompareOp, previewLabel);
  }

  async function runRollback() {
    if (!supplier || !progress) return;
    const items: RollbackBatchItem[] = applyResults
      .filter((r) => r.status === 'success')
      .map((r) => ({
        variantId: r.variantId,
        sku: r.sku,
        oldSellingPrice: r.oldSellingPrice ?? null,
        newSellingPrice: r.newSellingPrice ?? null,
        oldCompareAtPrice: r.oldCompareAtPrice ?? null,
        newCompareAtPrice: r.newCompareAtPrice ?? null,
        sellingChanged: Boolean(r.sellingChanged),
        compareChanged: Boolean(r.compareChanged),
      }));
    if (!items.length) return;
    abortRef.current = false;
    const label = progress.label;
    let state: ApplyProgress = { total: items.length, processed: 0, success: 0, skipped: 0, conflict: 0, failed: 0, running: true, done: false, kind: 'rollback', label };
    setProgress(state);
    const collected: PriceApplyItemResult[] = [];
    const size = supplier.batchSize || 50;
    for (let i = 0; i < items.length; i += size) {
      if (abortRef.current) break;
      const batch = items.slice(i, i + size);
      try {
        const { results } = await rollbackPriceBatch(supplier.key as SupplierKey, batch);
        collected.push(...results);
        state = accumulate(results, state);
      } catch (err) {
        const failedItems: PriceApplyItemResult[] = batch.map((b) => ({ sku: b.sku, variantId: b.variantId, status: 'failed', error: err instanceof Error ? err.message : 'Грешка при заявката.' }));
        collected.push(...failedItems);
        state = accumulate(failedItems, state);
      }
      setProgress({ ...state });
      setApplyResults([...collected]);
    }
    setProgress({ ...state, running: false, done: true });
  }

  function downloadReport() {
    if (!supplier) return;
    const report = {
      supplier: supplier.name,
      kind: progress?.kind || 'apply',
      sellingOperation: preview?.selling.type || null,
      sellingMultiplier: preview?.selling.multiplier ?? null,
      compareOperation: preview?.compare.type || null,
      compareMultiplier: preview?.compare.multiplier ?? null,
      generatedAt: new Date().toISOString(),
      feedSnapshotAt: preview?.feedSnapshotAt || null,
      items: applyResults.map((r) => ({
        sku: r.sku,
        variantId: r.variantId,
        wholesale: r.wholesale ?? null,
        oldSellingPrice: r.oldSellingPrice ?? null,
        newSellingPrice: r.newSellingPrice ?? null,
        oldCompareAtPrice: r.oldCompareAtPrice ?? null,
        newCompareAtPrice: r.newCompareAtPrice ?? null,
        result: r.status,
        error: r.error || null,
      })),
    };
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadJson(`price-update-${supplier.key}-${stamp}.json`, report);
  }

  const summary = preview?.summary;
  const problems = summary ? summary.conflict + summary.invalidPrice : 0;

  const resultRows = useMemo(() => {
    if (resultFilter === 'success') return applyResults.filter((r) => r.status === 'success' || r.status === 'already');
    if (resultFilter === 'skipped') return applyResults.filter((r) => r.status === 'skipped_stale' || r.status === 'conflict');
    if (resultFilter === 'errors') return applyResults.filter((r) => r.status === 'failed');
    return applyResults;
  }, [applyResults, resultFilter]);

  const defMult = supplier?.defaultMultiplier ?? 2.5;
  const defMarkup = supplier?.defaultMarkupPercent ?? 150;

  function newCompareCell(r: PriceRow) {
    if (r.compareMode === 'keep') return '—';
    if (r.compareMode === 'clear') return 'Изчисти';
    return money(r.targetCompareAt ?? null);
  }
  function newSellingCell(r: PriceRow) {
    if (preview?.selling.type === 'keep') return 'Без промяна';
    return money(r.target);
  }

  return (
    <DashboardLayout active="prices" eyebrow="Операции" title="Цени" subtitle="Преглед и безопасна актуализация на продажната и сравнителната Shopify цена спрямо актуалната доставна цена." wide>
      <section className="panel prices-intro">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Актуализация на цени</p>
            <h2>Доставчик: {supplier?.name || 'MegaPap'}</h2>
          </div>
          <span className="mode-pill preview">Реални Shopify цени</span>
        </div>

        <div className="price-info-grid">
          <div className="price-info">
            <span className="price-info-label">Shopify vendor</span>
            <strong className="price-info-value">{supplier?.vendor || 'Mebelcenter'}</strong>
          </div>
          <div className="price-info">
            <span className="price-info-label">Съвпадение по</span>
            <strong className="price-info-value">SKU · {supplier?.skuField || 'model'}</strong>
          </div>
          <div className="price-info">
            <span className="price-info-label">Източник на цената</span>
            <strong className="price-info-value">{supplier?.sourceField || 'wholesale_price_without_vat'}</strong>
          </div>
          <div className="price-info">
            <span className="price-info-label">Стандартен коефициент (нови продукти)</span>
            <strong className="price-info-value">× {nf.format(defMult)} · {defMarkup}%</strong>
          </div>
        </div>

        {/* Dual operation builder */}
        <div className="op-columns">
          <div className="op-block">
            <p className="op-block-title">Продажна цена</p>
            <div className="op-fields">
              <div className="field">
                <span>Операция</span>
                <Select<SellingType>
                  value={sellType}
                  options={[
                    { value: 'keep', label: 'Не променяй' },
                    { value: 'source', label: 'Върни към доставна цена' },
                    { value: 'multiplier', label: 'Приложи коефициент' },
                  ]}
                  ariaLabel="Операция за продажна цена"
                  onChange={setSellType}
                />
              </div>
              {sellType === 'multiplier' ? (
                <div className="field">
                  <span>Коефициент</span>
                  <input className="op-multiplier-input" type="text" inputMode="decimal" value={sellMult} aria-invalid={!sellValid} placeholder="напр. 2.50" onChange={(e) => setSellMult(e.target.value)} />
                  <span className={`op-markup${sellMarkup != null ? '' : ' is-invalid'}`}>{sellMarkup != null ? `Надценка: ${sellMarkup}%` : 'Въведете положително число'}</span>
                </div>
              ) : (
                <div className="field">
                  <span>Ефект</span>
                  <p className="op-explain">{sellType === 'keep' ? 'Продажната цена няма да бъде променяна.' : 'Продажната цена ще бъде изравнена с доставната цена.'}</p>
                </div>
              )}
            </div>
          </div>

          <div className="op-block">
            <p className="op-block-title">Сравнителна цена</p>
            <div className="op-fields">
              <div className="field">
                <span>Операция</span>
                <Select<CompareType>
                  value={cmpType}
                  options={[
                    { value: 'keep', label: 'Не променяй' },
                    { value: 'clear', label: 'Изчисти сравнителната цена' },
                    { value: 'source', label: 'Върни към доставна цена' },
                    { value: 'multiplier', label: 'Приложи коефициент' },
                  ]}
                  ariaLabel="Операция за сравнителна цена"
                  onChange={setCmpType}
                />
              </div>
              {cmpType === 'multiplier' ? (
                <div className="field">
                  <span>Коефициент</span>
                  <input className="op-multiplier-input" type="text" inputMode="decimal" value={cmpMult} aria-invalid={!cmpValid} placeholder="напр. 3.20" onChange={(e) => setCmpMult(e.target.value)} />
                  <span className={`op-markup${cmpMarkup != null ? '' : ' is-invalid'}`}>{cmpMarkup != null ? `Надценка: ${cmpMarkup}%` : 'Въведете положително число'}</span>
                </div>
              ) : (
                <div className="field">
                  <span>Ефект</span>
                  <p className="op-explain">
                    {cmpType === 'keep' ? 'Сравнителната цена няма да бъде променяна.' : cmpType === 'clear' ? 'Сравнителната цена ще бъде премахната.' : 'Сравнителната цена ще бъде изравнена с доставната цена.'}
                  </p>
                </div>
              )}
            </div>
            <p className="op-helper">
              <span className="pricing-note-ico" aria-hidden="true">i</span>
              За да се показва като зачеркната цена в Shopify, сравнителната цена трябва да бъде по-висока от продажната цена.
            </p>
          </div>
        </div>

        <p className="pricing-note">
          <span className="pricing-note-ico" aria-hidden="true">€</span>
          И двете цени се изчисляват от актуалната доставна цена във feed-а, а не от текущата Shopify цена.
        </p>

        <div className="notice info-soft">
          Актуализирането е активно за <strong>MegaPap</strong>. Текущата операция важи само за това пускане — стандартният коефициент за нови продукти остава × {nf.format(defMult)}.
        </div>

        {previewing ? <Progress text="Зареждат се feed-ът и текущите Shopify цени…" /> : null}
        {error ? <div className="notice error">{error}</div> : null}

        <div className="action-row">
          <Button variant="primary" disabled={loadingSupplier || previewing || !opsValid} onClick={onPreview}>
            {previewing ? 'Преглед…' : 'Преглед на промените'}
          </Button>
          <p>{hasActiveOperation ? 'Прегледът е само за четене. Не се записват промени в Shopify.' : 'Изберете операция за поне една от цените.'}</p>
        </div>
      </section>

      {preview && summary ? (
        <section className="panel result-panel is-success">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Резултат от прегледа</p>
              <h2>{preview.supplier.name}</h2>
              <p className="result-sub">{previewLabel}</p>
            </div>
            <span className="status success">Прегледът приключи</span>
          </div>
          {preview.warnings.length ? <div className="notice warning">{preview.warnings.join(' ')}</div> : null}
          {summary.compareWarnings ? (
            <div className="notice warning">Сравнителната цена не е по-висока от продажната при {fmt(summary.compareWarnings)} продукта — няма да се показват като намаление.</div>
          ) : null}
          <div className="stat-row price-stats">
            <div className="stat"><span className="stat-label">Във feed-а</span><strong className="stat-value">{fmt(summary.feedProducts)}</strong></div>
            <div className="stat"><span className="stat-label">Намерени в Shopify</span><strong className="stat-value">{fmt(summary.matched)}</strong></div>
            <div className="stat">
              <span className="stat-label">За промяна</span>
              <strong className="stat-value">{fmt(summary.toChange)}</strong>
              <span className="stat-sub">Продажна: {fmt(summary.changeSellingOnly + summary.changeBoth)} · Сравнителна: {fmt(summary.changeCompareOnly + summary.changeBoth)}</span>
            </div>
            <div className="stat"><span className="stat-label">Вече актуални</span><strong className="stat-value">{fmt(summary.alreadyCorrect)}</strong></div>
            <div className="stat"><span className="stat-label">Без съвпадение</span><strong className="stat-value">{fmt(summary.unmatched)}</strong></div>
            <div className={`stat${problems ? ' is-attention' : ''}`}><span className="stat-label">Проблеми</span><strong className="stat-value">{fmt(problems)}</strong></div>
          </div>
        </section>
      ) : null}

      {progress ? (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">{progress.kind === 'rollback' ? 'Възстановяване' : 'Актуализиране на цени'}</p>
              <h2>{progress.done ? 'Актуализацията приключи' : 'Актуализиране…'}</h2>
              <p className="result-sub">{supplier?.name} · {progress.kind === 'rollback' ? 'Възстановяване към предишни цени' : progress.label}</p>
            </div>
            <span className={`status ${progress.done ? (progress.failed ? 'warning' : 'success') : 'running'}`}>{progress.done ? 'Готово' : 'Изпълнява се'}</span>
          </div>
          <div className="apply-progress">
            <div className="apply-progress-head">
              <strong>{fmt(progress.processed)} / {fmt(progress.total)}</strong>
              <span>{progress.total ? Math.round((progress.processed / progress.total) * 100) : 0}%</span>
            </div>
            <div className="apply-bar"><span style={{ width: `${progress.total ? (progress.processed / progress.total) * 100 : 0}%` }} /></div>
            <div className="apply-counts">
              <span className="ok">Успешни: {fmt(progress.success)}</span>
              <span>Пропуснати: {fmt(progress.skipped + progress.conflict)}</span>
              <span className="err">Грешки: {fmt(progress.failed)}</span>
            </div>
          </div>

          {progress.done ? (
            <>
              <div className="selection-bar">
                <div className="selection-info">
                  <strong>{fmt(progress.success)} обновени</strong>
                  {progress.skipped + progress.conflict ? <span>{fmt(progress.skipped + progress.conflict)} пропуснати</span> : null}
                  {progress.failed ? <span className="selection-note">{fmt(progress.failed)} грешки</span> : null}
                </div>
                <div className="selection-actions">
                  <Button variant="ghost" size="sm" onClick={downloadReport}>Изтегли отчет (JSON)</Button>
                  {progress.failed ? <Button variant="secondary" size="sm" onClick={retryFailed}>Опитай отново неуспешните</Button> : null}
                  {progress.kind === 'apply' && progress.success ? <Button variant="ghost" size="sm" onClick={() => void runRollback()}>Възстанови цените</Button> : null}
                </div>
              </div>

              <div className="filter-row" aria-label="Филтри резултати">
                {([
                  ['all', `Всички (${fmt(applyResults.length)})`],
                  ['success', `Успешни (${fmt(progress.success)})`],
                  ['skipped', `Пропуснати (${fmt(progress.skipped + progress.conflict)})`],
                  ['errors', `Грешки (${fmt(progress.failed)})`],
                ] as const).map(([key, label]) => (
                  <button key={key} type="button" className={`filter-pill ${resultFilter === key ? 'active' : ''}`} onClick={() => setResultFilter(key)}>{label}</button>
                ))}
              </div>

              <div className="table-wrap missing-table-wrap">
                <table className="missing-table">
                  <thead>
                    <tr>
                      <th className="col-code">SKU</th>
                      <th>Продажна</th>
                      <th>Сравнителна</th>
                      <th className="col-status">Резултат</th>
                      <th>Забележка</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resultRows.slice(0, 500).map((r) => (
                      <tr key={r.variantId}>
                        <td className="cell-supplier col-code">{r.sku}</td>
                        <td className="num">{r.sellingChanged ? `${money(r.oldSellingPrice)} → ${money(r.newSellingPrice)}` : '—'}</td>
                        <td className="num">{r.compareChanged ? `${money(r.oldCompareAtPrice)} → ${money(r.newCompareAtPrice)}` : '—'}</td>
                        <td className="col-status">
                          <span className={`status-pill ${r.status === 'success' || r.status === 'already' ? 'ready' : r.status === 'failed' || r.status === 'conflict' ? 'blocked' : 'notes'}`}>
                            {r.status === 'success' ? 'Успешно' : r.status === 'already' ? 'Вече актуална' : r.status === 'skipped_stale' ? 'Пропуснато' : r.status === 'conflict' ? 'Проблем' : 'Грешка'}
                          </span>
                        </td>
                        <td className="col-note">{r.error || reasonText(r.reason)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </section>
      ) : null}

      {preview && !progress ? (
        <section className="workspace">
          <div className="workspace-head">
            <div>
              <p className="eyebrow">Преглед на промените</p>
              <h2>Цени <span className="workspace-count">{fmt(changeRows.length)} за промяна</span></h2>
            </div>
          </div>

          <div className="review-toolbar">
            <div className="filter-row" aria-label="Филтри">
              {([
                ['change', `За промяна (${fmt(summary?.toChange || 0)})`],
                ['already', `Вече актуални (${fmt(summary?.alreadyCorrect || 0)})`],
                ['unmatched', `Без съвпадение (${fmt(summary?.unmatched || 0)})`],
                ['problem', `Проблеми (${fmt(problems)})`],
                ['all', `Всички (${fmt(preview.rows.length)})`],
              ] as const).map(([key, label]) => (
                <button key={key} type="button" className={`filter-pill ${filter === key ? 'active' : ''}`} onClick={() => setFilter(key)}>{label}</button>
              ))}
            </div>
            <div className="review-toolbar-right">
              <div className="review-search">
                <input type="search" aria-label="Търсене по SKU или име" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Търсене по SKU или име" />
              </div>
              <div className="review-page-size">
                <Select<string> value={String(pageSize)} options={[{ value: '25', label: '25 реда' }, { value: '50', label: '50 реда' }, { value: '100', label: '100 реда' }]} ariaLabel="Редове на страница" onChange={(v) => setPageSize(Number(v))} />
              </div>
            </div>
          </div>

          <div className="selection-bar">
            <div className="selection-info">
              <strong>{selectedCount ? `${fmt(selectedCount)} продукта маркирани за актуализация` : 'Няма маркирани продукти за актуализация'}</strong>
            </div>
            <div className="selection-actions">
              <Button variant="ghost" size="sm" disabled={!changeRows.length} onClick={selectAllChange}>Маркирай всички за актуализация</Button>
              <Button variant="ghost" size="sm" disabled={!selectedCount} onClick={() => setSelected(new Set())}>Изчисти</Button>
              <Button variant="primary" size="sm" disabled={!selectedCount} onClick={() => setConfirmOpen(true)}>{selectedCount ? `Актуализирай цените на ${fmt(selectedCount)} продукта` : 'Актуализирай цените'}</Button>
            </div>
          </div>

          <div className="table-wrap missing-table-wrap">
            <table className="missing-table">
              <thead>
                <tr>
                  <th className="col-check" />
                  <th className="col-code">SKU</th>
                  <th className="col-title">Продукт</th>
                  <th className="num col-price">Доставна</th>
                  <th className="num col-price">Продажна сега</th>
                  <th className="num col-price">Нова продажна</th>
                  <th className="num col-price">Сравнителна сега</th>
                  <th className="num col-price">Нова сравнителна</th>
                  <th className="col-status">Статус</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.length ? (
                  pageRows.map((r) => (
                    <tr key={r.variantId || r.sku} className={r.status === 'change' ? '' : 'is-muted'}>
                      <td className="col-check">
                        <input type="checkbox" aria-label={`Маркирай ${r.sku}`} checked={r.variantId ? selected.has(r.variantId) : false} disabled={!r.selectable} onChange={() => r.variantId && toggle(r.variantId)} />
                      </td>
                      <td className="cell-supplier col-code">{r.sku}</td>
                      <td className="missing-title col-title" title={r.title || undefined}>{r.title || '—'}</td>
                      <td className="num col-price">{money(r.wholesale)}</td>
                      <td className="num col-price">{money(r.currentPrice)}</td>
                      <td className={`num col-price${r.sellingChanged ? (r.diff != null && r.diff > 0 ? ' diff-up' : r.diff != null && r.diff < 0 ? ' diff-down' : '') : ' is-unchanged'}`}>{newSellingCell(r)}</td>
                      <td className="num col-price">{money(r.currentCompareAt)}</td>
                      <td className={`num col-price${r.compareChanged ? '' : ' is-unchanged'}`}>
                        {newCompareCell(r)}
                        {r.compareWarn ? <span className="compare-warn" title="Сравнителната не е по-висока от продажната"> ⚠</span> : null}
                      </td>
                      <td className="col-status">
                        <span className={`status-pill ${statusPillClass(r.status)}`} title={reasonText(r.reason)}>{statusLabel[r.status]}</span>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr><td className="empty-cell" colSpan={9}><strong>Няма редове за този филтър</strong></td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="pagination-row">
            <span>{visibleRows.length ? `${fmt(pageStart + 1)}–${fmt(pageEnd)} от ${fmt(visibleRows.length)}` : `0 от 0`}</span>
            <div className="pagination-actions">
              <Button variant="ghost" size="sm" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>Назад</Button>
              <span>Страница {fmt(currentPage)} от {fmt(totalPages)}</span>
              <Button variant="ghost" size="sm" disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}>Напред</Button>
            </div>
          </div>
        </section>
      ) : null}

      {!preview && !previewing && !progress ? (
        <section className="panel idle-panel">
          <div className="idle-hint">
            <div className="idle-ico" aria-hidden="true">i</div>
            <div>
              <p className="idle-title">Изберете операции и направете преглед</p>
              <p className="idle-body">Прегледът чете актуалния feed и текущите Shopify цени и показва какво ще се промени за продажната и сравнителната цена. Нищо не се записва, докато не потвърдите.</p>
            </div>
          </div>
        </section>
      ) : null}

      {confirmOpen && preview ? (
        <div className="modal-overlay" onMouseDown={() => setConfirmOpen(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="price-confirm-title" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-icon" aria-hidden="true">!</div>
            <h3 id="price-confirm-title">Ще бъдат променени реални цени в Shopify.</h3>
            <ul className="modal-points">
              <li className="will">Доставчик: <strong>{supplier?.name}</strong></li>
              <li className="will">Продажна цена: <strong>{sellLabel(preview.selling.type as SellingType, preview.selling.multiplier)}</strong>{preview.selling.markupPercent != null ? ` · надценка ${preview.selling.markupPercent}%` : ''}</li>
              <li className="will">Сравнителна цена: <strong>{cmpLabel(preview.compare.type as CompareType, preview.compare.multiplier)}</strong>{preview.compare.markupPercent != null ? ` · надценка ${preview.compare.markupPercent}%` : ''}</li>
              <li className="will">Продукти: <strong>{fmt(confirmStats.count)}</strong></li>
              <li className="will">Продажна цена ще се промени: {fmt(confirmStats.sellingChanges)}</li>
              <li className="will">Сравнителна цена ще се промени: {fmt(confirmStats.compareChanges)}</li>
              {confirmStats.lowest != null ? <li className="will">Диапазон нови продажни цени: {money(confirmStats.lowest)} – {money(confirmStats.highest)}</li> : null}
            </ul>
            {confirmStats.warns ? <p className="modal-hint">При {fmt(confirmStats.warns)} продукта сравнителната цена не е по-висока от продажната — няма да се показват като намаление.</p> : null}
            <p className="modal-hint">И двете цени се изчисляват от актуалната доставна цена във feed-а. Записва се директно крайната стойност.</p>
            <div className="modal-actions">
              <Button variant="ghost" onClick={() => setConfirmOpen(false)}>Отказ</Button>
              <Button variant="primary" onClick={startApply}>Потвърди и започни</Button>
            </div>
          </div>
        </div>
      ) : null}
    </DashboardLayout>
  );
}
