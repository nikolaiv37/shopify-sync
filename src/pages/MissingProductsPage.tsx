import { Fragment, useEffect, useMemo, useState } from 'react';
import { DashboardLayout } from '../components/layout/DashboardLayout';
import { Button } from '../components/ui/Buttons';
import { Progress } from '../components/feedback/Progress';
import { exportMissingProducts, getMissingCategories, getMissingSuppliers, scanMissingProducts } from '../lib/api';
import type { MissingProductRow, MissingProductsExportSummary, MissingProductsScanResult, MissingSupplier, SupplierCategory, SupplierKey } from '../lib/types';

const nf = new Intl.NumberFormat('bg-BG');
const fmt = (n: unknown) => nf.format(Number(n) || 0);
const money = new Intl.NumberFormat('bg-BG', { style: 'currency', currency: 'BGN', minimumFractionDigits: 2, maximumFractionDigits: 2 });
type ReviewFilter = 'all' | 'valid' | 'warning' | 'blocked' | 'selected' | 'zeroStock';

function validationLabel(row: MissingProductRow) {
  if (row.validationState === 'blocked') return 'Не може да се експортира';
  if (row.validationState === 'warning') return 'С предупреждение';
  return 'Валиден';
}

function formatPrice(value: string) {
  const num = Number.parseFloat(String(value || '').replace(',', '.'));
  return Number.isFinite(num) ? money.format(num) : '—';
}

function isZeroStock(row: MissingProductRow) {
  const value = Number.parseFloat(String(row.stock || '').replace(',', '.'));
  return Number.isFinite(value) && value <= 0;
}

const reasonLabels: Record<string, string> = {
  'missing-sku': 'Липсва SKU.',
  'missing-title': 'Липсва име.',
  'missing-price': 'Липсва цена.',
  'category-unmapped': 'Категорията няма пълно мапване.',
  'no-image': 'Няма снимка.',
  'already-in-shopify': 'Вече съществува в Shopify.',
  'duplicate-supplier-sku': 'Дублиран доставчик код.',
  'duplicate-selected-sku': 'Дублиран избран SKU.',
};

function reasonText(reason: string) {
  return reasonLabels[reason] || reason;
}

function htmlToPreview(value: string) {
  if (!value) return '';
  if (typeof window === 'undefined') return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const normalized = value
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*p\s*>/gi, '\n')
    .replace(/<\/\s*li\s*>/gi, '\n');
  const doc = new DOMParser().parseFromString(normalized, 'text/html');
  doc.querySelectorAll('script,style,iframe,object,embed').forEach((node) => node.remove());
  return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

function copyText(value: string) {
  if (!navigator.clipboard) return;
  void navigator.clipboard.writeText(value);
}

function ProductDetails({ row }: { row: MissingProductRow }) {
  const preview = htmlToPreview(row.description);
  const extraImages = Math.max(0, row.imageUrls.length - 1);
  const reasons = [...row.validationErrors, ...row.validationWarnings];

  return (
    <div className="missing-details">
      <div className="detail-media-row">
        {row.imageUrls[0] ? (
          <a href={row.imageUrls[0]} target="_blank" rel="noreferrer" className="product-thumb-link">
            <img className="product-thumb" src={row.imageUrls[0]} alt={row.title || row.supplierSku} loading="lazy" />
          </a>
        ) : (
          <div className="product-thumb product-thumb-empty">Няма снимка</div>
        )}
        <div>
          <h4>Описание</h4>
          <p className="description-preview">{preview || 'Няма описание.'}</p>
        </div>
      </div>
      <details>
        <summary>
          {row.imageUrls.length ? `${row.imageUrls.length} снимки${extraImages ? ` · +${extraImages} снимки` : ''}` : 'Няма снимки'}
        </summary>
        {row.imageUrls.length ? (
          <>
            <Button variant="ghost" size="sm" onClick={() => copyText(row.imageUrls.join('\n'))}>
              Копирай URL адресите
            </Button>
            <ul>
              {row.imageUrls.slice(0, 8).map((url) => (
                <li key={url}>
                  <a href={url} target="_blank" rel="noreferrer">
                    {url}
                  </a>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>Няма снимки.</p>
        )}
      </details>
      <div className="detail-grid">
        <div>
          <h4>Доставна цена</h4>
          <p>{formatPrice(row.supplierPrice)}</p>
        </div>
        <div>
          <h4>Тегло</h4>
          <p>{row.weightKg ? `${row.weightKg} kg` : '—'}</p>
        </div>
        <div>
          <h4>Баркод</h4>
          <p>{row.barcode || '—'}</p>
        </div>
        <div>
          <h4>Тип / тагове</h4>
          <p>{[row.typePreview, ...row.tagsPreview].filter(Boolean).join(', ') || '—'}</p>
        </div>
      </div>
      <div>
        <h4>Валидация</h4>
        {reasons.length ? (
          <ul>
            {reasons.map((reason) => (
              <li key={reason}>{reasonText(reason)}</li>
            ))}
          </ul>
        ) : (
          <p>Няма блокиращи проблеми.</p>
        )}
      </div>
    </div>
  );
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function MissingProductsPage() {
  const [suppliers, setSuppliers] = useState<MissingSupplier[]>([]);
  const [supplier, setSupplier] = useState<SupplierKey | ''>('');
  const [categories, setCategories] = useState<SupplierCategory[]>([]);
  const [categoryId, setCategoryId] = useState('');
  const [categorySearch, setCategorySearch] = useState('');
  const [loadingSuppliers, setLoadingSuppliers] = useState(true);
  const [loadingCategories, setLoadingCategories] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<MissingProductsScanResult | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selectedRows, setSelectedRows] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState<ReviewFilter>('all');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [exportSuccess, setExportSuccess] = useState<{ filename: string; summary: MissingProductsExportSummary | null } | null>(null);
  const [productSearch, setProductSearch] = useState('');
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);

  useEffect(() => {
    getMissingSuppliers()
      .then((data) => {
        const available = data.suppliers.filter((item) => item.available);
        setSuppliers(available);
        if (available[0]) setSupplier(available[0].key);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Доставчиците не можаха да се заредят.'))
      .finally(() => setLoadingSuppliers(false));
  }, []);

  useEffect(() => {
    if (!supplier) return;
    setLoadingCategories(true);
    setCategories([]);
    setCategoryId('');
    setResult(null);
    setSelectedRows(new Set());
    setFilter('all');
    setProductSearch('');
    setPage(1);
    setExportSuccess(null);
    setExportError('');
    setError('');
    getMissingCategories(supplier)
      .then((data) => setCategories(data.categories))
      .catch((err) => setError(err instanceof Error ? err.message : 'Категориите не можаха да се заредят.'))
      .finally(() => setLoadingCategories(false));
  }, [supplier]);

  const filteredCategories = useMemo(() => {
    const q = categorySearch.trim().toLocaleLowerCase();
    if (!q) return categories;
    return categories.filter((category) => category.name.toLocaleLowerCase().includes(q));
  }, [categories, categorySearch]);

  const selectedCategory = useMemo(
    () => categories.find((category) => category.id === categoryId) || null,
    [categories, categoryId],
  );

  useEffect(() => {
    setResult(null);
    setSelectedRows(new Set());
    setExpanded(null);
    setFilter('all');
    setProductSearch('');
    setPage(1);
    setExportSuccess(null);
    setExportError('');
  }, [categoryId]);

  async function onScan() {
    if (!supplier || !categoryId) return;
    setScanning(true);
    setError('');
    setResult(null);
    setExpanded(null);
    setSelectedRows(new Set());
    setFilter('all');
    setProductSearch('');
    setPage(1);
    setExportSuccess(null);
    setExportError('');
    try {
      const data = await scanMissingProducts(supplier, categoryId);
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Проверката не бе изпълнена.');
    } finally {
      setScanning(false);
    }
  }

  function toggleSelected(id: string) {
    const row = result?.missingProducts.find((item) => item.id === id);
    if (!row?.importable) return;
    setSelectedRows((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const counts = useMemo(() => {
    const rows = result?.missingProducts || [];
    return {
      total: rows.length,
      valid: rows.filter((row) => row.validationState === 'valid').length,
      warning: rows.filter((row) => row.validationState === 'warning').length,
      blocked: rows.filter((row) => row.validationState === 'blocked').length,
      importable: rows.filter((row) => row.importable).length,
      missingImages: rows.filter((row) => row.importable && !row.hasImages).length,
      zeroStock: rows.filter((row) => row.importable && isZeroStock(row)).length,
    };
  }, [result]);

  const selectedZeroStock = useMemo(() => {
    if (!result) return 0;
    return result.missingProducts.filter((row) => selectedRows.has(row.id) && isZeroStock(row)).length;
  }, [result, selectedRows]);

  const visibleRows = useMemo(() => {
    let rows = result?.missingProducts || [];
    if (filter === 'selected') rows = rows.filter((row) => selectedRows.has(row.id));
    else if (filter === 'valid') rows = rows.filter((row) => row.validationState === 'valid');
    else if (filter === 'warning') rows = rows.filter((row) => row.validationState === 'warning');
    else if (filter === 'blocked') rows = rows.filter((row) => row.validationState === 'blocked');
    else if (filter === 'zeroStock') rows = rows.filter(isZeroStock);

    const q = productSearch.trim().toLocaleLowerCase();
    if (!q) return rows;
    return rows.filter((row) =>
      [row.supplierSku, row.title].some((value) => String(value || '').toLocaleLowerCase().includes(q)),
    );
  }, [filter, productSearch, result, selectedRows]);

  const totalPages = Math.max(1, Math.ceil(visibleRows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = visibleRows.length ? (currentPage - 1) * pageSize : 0;
  const pageRows = visibleRows.slice(pageStart, pageStart + pageSize);
  const pageEnd = pageStart + pageRows.length;

  useEffect(() => {
    setPage(1);
    setExpanded(null);
  }, [filter, productSearch, pageSize]);

  function updatePage(nextPage: number) {
    setExpanded(null);
    setPage(Math.max(1, Math.min(totalPages, nextPage)));
  }

  function selectAllValid() {
    if (!result) return;
    setSelectedRows(new Set(result.missingProducts.filter((row) => row.importable).map((row) => row.id)));
  }

  async function onExport() {
    if (!supplier || !categoryId || !selectedRows.size) return;
    setExporting(true);
    setExportError('');
    setExportSuccess(null);
    try {
      const data = await exportMissingProducts(supplier, categoryId, Array.from(selectedRows));
      downloadBlob(data.blob, data.filename);
      setExportSuccess({ filename: data.filename, summary: data.summary });
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'CSV файлът не можа да бъде генериран.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <DashboardLayout
      active="missing"
      eyebrow="Каталог"
      title="Липсващи продукти"
      subtitle="Проверете кои продукти от доставчиците липсват в Shopify. Този екран е само за преглед и не прави промени."
    >
      <section className="panel missing-workflow">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Phase C</p>
            <h2>Проверка по категория</h2>
          </div>
          <span className="mode-pill preview">CSV без Shopify промени</span>
        </div>

        <div className="form-grid">
          <label className="field">
            <span>Доставчик</span>
            <select value={supplier} disabled={loadingSuppliers || scanning} onChange={(event) => setSupplier(event.target.value as SupplierKey)}>
              {loadingSuppliers ? <option>Зареждане…</option> : null}
              {suppliers.map((item) => (
                <option value={item.key} key={item.key}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Търсене в категории</span>
            <input
              value={categorySearch}
              disabled={loadingCategories || scanning || !categories.length}
              onChange={(event) => setCategorySearch(event.target.value)}
              placeholder="Например: столове, Παιδικό..."
            />
          </label>

          <label className="field field-wide">
            <span>Категория</span>
            <select value={categoryId} disabled={loadingCategories || scanning || !categories.length} onChange={(event) => setCategoryId(event.target.value)}>
              <option value="">{loadingCategories ? 'Категориите се зареждат…' : 'Изберете категория'}</option>
              {filteredCategories.map((category) => (
                <option value={category.id} key={category.id}>
                  {category.name} · {fmt(category.productCount)} продукта
                </option>
              ))}
            </select>
          </label>
        </div>

        {loadingCategories ? <Progress text="Зареждат се категориите от XML фийда…" /> : null}
        {selectedCategory && selectedCategory.productCount >= 500 ? (
          <div className="notice warning">
            Категорията съдържа {fmt(selectedCategory.productCount)} продукта. Проверката може да отнеме около 20–30 секунди.
          </div>
        ) : null}
        {scanning ? <Progress text="Проверката се изпълнява. Shopify се чете без промени…" /> : null}
        {error ? <div className="notice error">{error}</div> : null}
        {!loadingSuppliers && !suppliers.length ? <div className="notice warning">Няма доставчик с достъпен фийд в текущата среда.</div> : null}

        <div className="action-row">
          <Button variant="primary" disabled={!supplier || !categoryId || scanning || loadingCategories} onClick={onScan}>
            Стартирай проверка
          </Button>
          <p>CSV файлът подготвя продуктите като чернови. Не се правят автоматични промени в Shopify.</p>
        </div>
      </section>

      {result ? (
        <section className="panel result-panel is-success">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Резултат</p>
              <h2>{result.supplierName} · {result.category.name}</h2>
            </div>
            <span className="status success">Проверката приключи</span>
          </div>
          <p className="result-summary">
            Проверката приключи. От {fmt(result.totals.supplierProducts)} продукта в категорията, {fmt(result.totals.alreadyInShopify)} вече съществуват в Shopify,
            а {fmt(result.totals.missing)} липсват. Не са направени Shopify промени.
          </p>
          <div className="stat-row missing-stats">
            <div className="stat">
              <span className="stat-label">В категорията</span>
              <strong className="stat-value">{fmt(result.totals.supplierProducts)}</strong>
            </div>
            <div className="stat">
              <span className="stat-label">Вече в Shopify</span>
              <strong className="stat-value">{fmt(result.totals.alreadyInShopify)}</strong>
            </div>
            <div className="stat">
              <span className="stat-label">Липсват</span>
              <strong className="stat-value">{fmt(result.totals.missing)}</strong>
            </div>
            <div className="stat">
              <span className="stat-label">Невалидни</span>
              <strong className="stat-value">{fmt(result.totals.invalid)}</strong>
            </div>
            <div className="stat">
              <span className="stat-label">Дублирани кодове</span>
              <strong className="stat-value">{fmt(result.totals.duplicateCodes)}</strong>
            </div>
          </div>
          {result.warnings.length ? <div className="notice warning">{result.warnings.join(' ')}</div> : null}
        </section>
      ) : null}

      {result ? (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Преглед</p>
              <h2>Липсващи продукти</h2>
            </div>
            <span className="table-count">Избрани: {fmt(selectedRows.size)} · Валидни: {fmt(counts.importable)}</span>
          </div>

          <div className="selection-bar">
            <div className="selection-stats">
              <span>Валидни: {fmt(counts.valid)}</span>
              <span>С предупреждения: {fmt(counts.warning)}</span>
              <span>Блокирани: {fmt(counts.blocked)}</span>
              <span>Без снимки: {fmt(counts.missingImages)}</span>
              <span>Без наличност: {fmt(counts.zeroStock)}</span>
            </div>
            <div className="selection-actions">
              <Button variant="secondary" size="sm" disabled={!counts.importable} onClick={selectAllValid}>
                Избери всички валидни
              </Button>
              <Button variant="ghost" size="sm" disabled={!selectedRows.size} onClick={() => setSelectedRows(new Set())}>
                Изчисти избора
              </Button>
            </div>
          </div>

          <div className="filter-row" aria-label="Филтри">
            {[
              ['all', `Всички (${fmt(counts.total)})`],
              ['valid', `Валидни (${fmt(counts.valid)})`],
              ['warning', `С предупреждения (${fmt(counts.warning)})`],
              ['blocked', `Блокирани (${fmt(counts.blocked)})`],
              ['zeroStock', `Без наличност (${fmt(counts.zeroStock)})`],
              ['selected', `Избрани (${fmt(selectedRows.size)})`],
            ].map(([key, label]) => (
              <button className={`filter-pill ${filter === key ? 'active' : ''}`} type="button" key={key} onClick={() => setFilter(key as ReviewFilter)}>
                {label}
              </button>
            ))}
          </div>

          <div className="export-panel">
            <div>
              <p className="export-title">Експорт към Shopify CSV</p>
              <p className="export-copy">
                Избрани: {fmt(selectedRows.size)}. Блокираните продукти не могат да бъдат избрани. Продуктите с предупреждения се включват, ако са importable.
                {selectedZeroStock ? ` Избрани без наличност: ${fmt(selectedZeroStock)} — ще бъдат включени като Shopify чернови.` : ''}
              </p>
            </div>
            <Button variant="primary" disabled={!result || !selectedRows.size || exporting} onClick={onExport}>
              {exporting ? 'Генериране…' : 'Генерирай и изтегли CSV'}
            </Button>
          </div>
          {exportSuccess ? (
            <div className="notice success">
              CSV файлът е генериран: {exportSuccess.filename}. Експортирани продукти: {fmt(exportSuccess.summary?.exported || 0)}, изключени: {fmt(exportSuccess.summary?.excluded || 0)}.
              Не са направени Shopify промени.
            </div>
          ) : null}
          {exportError ? <div className="notice error">{exportError}</div> : null}

          <div className="table-toolbar">
            <label className="field compact-field">
              <span>Търсене по код или име</span>
              <input
                value={productSearch}
                onChange={(event) => setProductSearch(event.target.value)}
                placeholder="SKU или име на продукт"
              />
            </label>
            <label className="field page-size-field">
              <span>Редове</span>
              <select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>
                <option value={25}>25</option>
                <option value={50}>50</option>
              </select>
            </label>
          </div>

          <div className="table-wrap missing-table-wrap">
            <table className="missing-table">
              <thead>
                <tr>
                  <th />
                  <th>Код</th>
                  <th>Име</th>
                  <th>Категория</th>
                  <th className="num">Shopify цена</th>
                  <th>Наличност</th>
                  <th>Валидация</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pageRows.length ? (
                  pageRows.map((row) => (
                    <Fragment key={row.id}>
                      <tr className={row.importable ? '' : 'is-blocked'}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Маркирай ${row.supplierSku}`}
                            checked={selectedRows.has(row.id)}
                            disabled={!row.importable}
                            onChange={() => toggleSelected(row.id)}
                          />
                        </td>
                        <td className="cell-supplier">{row.supplierSku}</td>
                        <td className="missing-title">{row.title || '—'}</td>
                        <td>{row.category || '—'}</td>
                        <td className="num">{formatPrice(row.shopifyPrice)}</td>
                        <td>{row.stock || row.availability || '—'}</td>
                        <td>
                          <span className={`validation-pill ${row.validationState}`}>{validationLabel(row)}</span>
                        </td>
                        <td>
                          <Button variant="ghost" size="sm" onClick={() => setExpanded(expanded === row.id ? null : row.id)}>
                            Детайли
                          </Button>
                        </td>
                      </tr>
                      {expanded === row.id ? (
                        <tr key={`${row.id}-details`}>
                          <td colSpan={8}>
                            <ProductDetails row={row} />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  ))
                ) : (
                  <tr>
                    <td className="empty-cell" colSpan={8}>
                      <strong>{result.missingProducts.length ? 'Няма редове за този филтър' : 'Няма липсващи продукти'}</strong>
                      <span>{result.missingProducts.length ? 'Сменете филтъра, за да видите останалите продукти.' : 'Всички продукти от избраната категория вече са открити в Shopify.'}</span>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="pagination-row">
            <span>
              {visibleRows.length ? `${fmt(pageStart + 1)}–${fmt(pageEnd)} от ${fmt(visibleRows.length)}` : `0 от ${fmt(visibleRows.length)}`}
            </span>
            <div className="pagination-actions">
              <Button variant="ghost" size="sm" disabled={currentPage <= 1} onClick={() => updatePage(currentPage - 1)}>
                Назад
              </Button>
              <span>Страница {fmt(currentPage)} от {fmt(totalPages)}</span>
              <Button variant="ghost" size="sm" disabled={currentPage >= totalPages} onClick={() => updatePage(currentPage + 1)}>
                Напред
              </Button>
            </div>
          </div>
        </section>
      ) : (
        <section className="panel">
          <div className="idle-hint">
            <div className="idle-ico" aria-hidden="true">
              i
            </div>
            <div>
              <p className="idle-title">Изберете доставчик и категория</p>
              <p className="idle-body">След проверката тук ще се покажат липсващите продукти за преглед. Екранът не създава продукти и не експортира CSV.</p>
            </div>
          </div>
        </section>
      )}
    </DashboardLayout>
  );
}
