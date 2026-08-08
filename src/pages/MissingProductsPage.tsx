import { Fragment, useEffect, useMemo, useState } from 'react';
import { DashboardLayout } from '../components/layout/DashboardLayout';
import { Button } from '../components/ui/Buttons';
import { Select } from '../components/ui/Select';
import { Combobox, type ComboboxOption } from '../components/ui/Combobox';
import { Progress } from '../components/feedback/Progress';
import { ProductDrawer } from '../components/missing/ProductDrawer';
import { exportStatus, statusLabel, type ExportStatus } from '../lib/missingStatus';
import { exportMissingProducts, getMissingCategories, getMissingSuppliers, scanMissingProducts } from '../lib/api';
import type { MissingProductRow, MissingProductsExportSummary, MissingProductsScanResult, MissingSupplier, SupplierCategory, SupplierKey } from '../lib/types';

const nf = new Intl.NumberFormat('bg-BG');
const fmt = (n: unknown) => nf.format(Number(n) || 0);
const eur = new Intl.NumberFormat('bg-BG', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
type ReviewFilter = 'all' | 'ready' | 'notes' | 'blocked' | 'selected' | 'zeroStock';

function formatPrice(value: string) {
  const num = Number.parseFloat(String(value || '').replace(',', '.'));
  return Number.isFinite(num) ? eur.format(num) : '—';
}

function isZeroStock(row: MissingProductRow) {
  const value = Number.parseFloat(String(row.stock || '').replace(',', '.'));
  return Number.isFinite(value) && value <= 0;
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
  const [loadingSuppliers, setLoadingSuppliers] = useState(true);
  const [loadingCategories, setLoadingCategories] = useState(false);
  const [categoriesError, setCategoriesError] = useState('');
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<MissingProductsScanResult | null>(null);
  const [detailsId, setDetailsId] = useState<string | null>(null);
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
    setCategoriesError('');
    getMissingCategories(supplier)
      .then((data) => setCategories(data.categories))
      .catch((err) => setCategoriesError(err instanceof Error ? err.message : 'Категориите не можаха да се заредят.'))
      .finally(() => setLoadingCategories(false));
  }, [supplier]);

  const selectedCategory = useMemo(
    () => categories.find((category) => category.id === categoryId) || null,
    [categories, categoryId],
  );

  const supplierOptions = useMemo(
    () => suppliers.map((item) => ({ value: item.key, label: item.name })),
    [suppliers],
  );

  const categoryOptions = useMemo<ComboboxOption[]>(
    () =>
      categories.map((category) => {
        const secondaryParts: string[] = [];
        if (category.hasParent) secondaryParts.push(category.parentPath);
        if (category.hasTranslation) secondaryParts.push(category.originalName);
        return {
          value: category.id,
          primary: category.displayName,
          secondary: secondaryParts.join(' · ') || undefined,
          meta: `${fmt(category.productCount)} продукта`,
          searchText: [
            category.displayName,
            category.originalName,
            category.originalPath,
            category.parentPath,
            category.parentPathOriginal,
          ]
            .filter(Boolean)
            .join(' '),
        };
      }),
    [categories],
  );

  const categoryState: 'idle' | 'loading' | 'error' | 'empty' = loadingCategories
    ? 'loading'
    : categoriesError
      ? 'error'
      : !categories.length && supplier
        ? 'empty'
        : 'idle';

  useEffect(() => {
    setResult(null);
    setSelectedRows(new Set());
    setDetailsId(null);
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
    setDetailsId(null);
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
    let ready = 0;
    let notes = 0;
    let blocked = 0;
    for (const row of rows) {
      const status = exportStatus(row);
      if (status === 'ready') ready += 1;
      else if (status === 'notes') notes += 1;
      else blocked += 1;
    }
    return {
      total: rows.length,
      ready,
      notes,
      blocked,
      importable: rows.filter((row) => row.importable).length,
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
    else if (filter === 'ready') rows = rows.filter((row) => exportStatus(row) === 'ready');
    else if (filter === 'notes') rows = rows.filter((row) => exportStatus(row) === 'notes');
    else if (filter === 'blocked') rows = rows.filter((row) => exportStatus(row) === 'blocked');
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
  }, [filter, productSearch, pageSize]);

  function updatePage(nextPage: number) {
    setPage(Math.max(1, Math.min(totalPages, nextPage)));
  }

  function selectAllExportable() {
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

  const detailsRow = useMemo(
    () => result?.missingProducts.find((row) => row.id === detailsId) || null,
    [result, detailsId],
  );

  const selectedCount = selectedRows.size;

  return (
    <DashboardLayout
      active="missing"
      eyebrow="Каталог"
      title="Липсващи продукти"
      subtitle="Проверете кои продукти от доставчиците липсват в Shopify. Този екран е само за преглед и не прави промени."
      wide
    >
      <section className="panel missing-workflow">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Проверка</p>
            <h2>Проверка по категория</h2>
          </div>
          <span className="mode-pill preview">CSV без Shopify промени</span>
        </div>

        <div className="form-grid">
          <div className="field">
            <span>Доставчик</span>
            <Select<SupplierKey>
              value={supplier}
              options={supplierOptions}
              loading={loadingSuppliers}
              disabled={scanning || !supplierOptions.length}
              placeholder={loadingSuppliers ? 'Зареждане…' : 'Изберете доставчик'}
              ariaLabel="Доставчик"
              onChange={setSupplier}
            />
          </div>

          <div className="field">
            <span>Категория</span>
            <Combobox
              value={categoryId}
              options={categoryOptions}
              disabled={scanning || !supplier}
              state={categoryState}
              placeholder="Изберете категория"
              searchPlaceholder="Търсене по име (BG или оригинал)…"
              loadingMessage="Категориите се зареждат…"
              emptyMessage="Няма налични категории за този доставчик."
              errorMessage={categoriesError || 'Категориите не можаха да се заредят.'}
              noResultsMessage="Няма съвпадения."
              ariaLabel="Категория"
              onChange={setCategoryId}
            />
          </div>
        </div>

        {loadingCategories ? <Progress text="Зареждат се категориите от XML фийда…" /> : null}
        {selectedCategory ? (
          <div className="info-callout">
            <strong>{fmt(selectedCategory.productCount)} продукта</strong> ще бъдат проверени в тази категория.
            {selectedCategory.productCount >= 500 ? ' Проверката може да отнеме около 20–30 секунди.' : ''}
          </div>
        ) : null}
        {scanning ? <Progress text="Проверката се изпълнява. Shopify се чете без промени…" /> : null}
        {error ? <div className="notice error">{error}</div> : null}
        {categoriesError && !loadingCategories ? <div className="notice error">{categoriesError}</div> : null}
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
              <h2>
                {result.supplierName} · {result.category.displayName || result.category.name}
              </h2>
              {result.category.hasTranslation ? (
                <p className="result-sub">{result.category.originalName}</p>
              ) : null}
            </div>
            <span className="status success">Проверката приключи успешно</span>
          </div>
          <p className="result-summary">Проверката приключи успешно. Не са направени промени в Shopify.</p>
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
        <section className="workspace">
          <div className="workspace-head">
            <div>
              <p className="eyebrow">Преглед</p>
              <h2>Липсващи продукти <span className="workspace-count">{fmt(counts.total)} намерени</span></h2>
            </div>
          </div>

          <div className="review-toolbar">
            <div className="filter-row" aria-label="Филтри по статус">
              {([
                ['all', `Всички (${fmt(counts.total)})`],
                ['ready', `Готови (${fmt(counts.ready)})`],
                ['notes', `Със забележки (${fmt(counts.notes)})`],
                ['blocked', `Блокирани (${fmt(counts.blocked)})`],
              ] as const).map(([key, label]) => (
                <button
                  className={`filter-pill ${filter === key ? 'active' : ''}`}
                  type="button"
                  key={key}
                  onClick={() => setFilter(key)}
                >
                  {label}
                </button>
              ))}
              {counts.zeroStock ? (
                <>
                  <span className="filter-divider" aria-hidden="true" />
                  <button
                    className={`filter-pill is-subtle ${filter === 'zeroStock' ? 'active' : ''}`}
                    type="button"
                    onClick={() => setFilter(filter === 'zeroStock' ? 'all' : 'zeroStock')}
                    title="Продукти с наличност 0"
                  >
                    Без наличност ({fmt(counts.zeroStock)})
                  </button>
                </>
              ) : null}
            </div>

            <div className="review-toolbar-right">
              <div className="review-search">
                <input
                  type="search"
                  aria-label="Търсене по код или име"
                  value={productSearch}
                  onChange={(event) => setProductSearch(event.target.value)}
                  placeholder="Търсене по код или име на продукт"
                />
              </div>
              <div className="review-page-size">
                <Select<string>
                  value={String(pageSize)}
                  options={[
                    { value: '25', label: '25 реда' },
                    { value: '50', label: '50 реда' },
                    { value: '100', label: '100 реда' },
                  ]}
                  ariaLabel="Редове на страница"
                  onChange={(value) => setPageSize(Number(value))}
                />
              </div>
            </div>
          </div>

          <div className="selection-bar">
            <div className="selection-info">
              <strong>
                {selectedCount ? `${fmt(selectedCount)} продукта маркирани за експорт` : 'Няма маркирани продукти за експорт'}
              </strong>
              {selectedCount && filter !== 'selected' ? (
                <button className="link-btn" type="button" onClick={() => setFilter('selected')}>
                  Покажи маркираните
                </button>
              ) : null}
              {filter === 'selected' ? (
                <button className="link-btn" type="button" onClick={() => setFilter('all')}>
                  Покажи всички
                </button>
              ) : null}
              {selectedZeroStock ? (
                <span className="selection-note">включително {fmt(selectedZeroStock)} без наличност (Shopify чернови)</span>
              ) : null}
            </div>
            <div className="selection-actions">
              <Button variant="ghost" size="sm" disabled={!counts.importable} onClick={selectAllExportable}>
                Маркирай всички за експорт
              </Button>
              <Button variant="ghost" size="sm" disabled={!selectedCount} onClick={() => setSelectedRows(new Set())}>
                Изчисти
              </Button>
              <Button variant="primary" size="sm" disabled={!selectedCount || exporting} onClick={onExport}>
                {exporting ? 'Генериране…' : selectedCount ? `Генерирай CSV за ${fmt(selectedCount)} продукта` : 'Генерирай CSV'}
              </Button>
            </div>
          </div>

          {exportSuccess ? (
            <div className="notice success">
              CSV файлът е генериран: {exportSuccess.filename}. Експортирани продукти: {fmt(exportSuccess.summary?.exported || 0)}, изключени: {fmt(exportSuccess.summary?.excluded || 0)}.
            </div>
          ) : null}
          {exportError ? <div className="notice error">{exportError}</div> : null}

          <div className="table-wrap missing-table-wrap">
            <table className="missing-table">
              <thead>
                <tr>
                  <th className="col-check" />
                  <th className="col-code">Код</th>
                  <th className="col-title">Продукт</th>
                  <th className="col-cat">Категория</th>
                  <th className="num col-price">Доставна цена</th>
                  <th className="num col-price">Shopify цена</th>
                  <th className="col-stock">Наличност</th>
                  <th className="col-status">Статус</th>
                  <th className="col-details" />
                </tr>
              </thead>
              <tbody>
                {pageRows.length ? (
                  pageRows.map((row) => {
                    const status: ExportStatus = exportStatus(row);
                    const zeroStock = isZeroStock(row);
                    const stockText = row.stock || row.availability || '—';
                    const isActive = detailsId === row.id;
                    return (
                      <tr key={row.id} className={[status === 'blocked' ? 'is-blocked' : '', isActive ? 'is-active' : ''].filter(Boolean).join(' ')}>
                        <td className="col-check">
                          <input
                            type="checkbox"
                            aria-label={`Маркирай ${row.supplierSku}`}
                            checked={selectedRows.has(row.id)}
                            disabled={!row.importable}
                            onChange={() => toggleSelected(row.id)}
                          />
                        </td>
                        <td className="cell-supplier col-code">{row.supplierSku}</td>
                        <td className="missing-title col-title" title={row.title || undefined}>{row.title || '—'}</td>
                        <td className="col-cat" title={row.category || undefined}>{row.categoryDisplay || row.category || '—'}</td>
                        <td className="num col-price">{formatPrice(row.supplierPrice)}</td>
                        <td className="num col-price">{formatPrice(row.shopifyPrice)}</td>
                        <td className={`col-stock${zeroStock ? ' is-zero' : ''}`}>{stockText}</td>
                        <td className="col-status">
                          <span className={`status-pill ${status}`}>{statusLabel[status]}</span>
                        </td>
                        <td className="col-details">
                          <button
                            type="button"
                            className={`details-link${isActive ? ' is-active' : ''}`}
                            onClick={() => setDetailsId(isActive ? null : row.id)}
                          >
                            Детайли <span aria-hidden="true">→</span>
                          </button>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td className="empty-cell" colSpan={9}>
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
        <section className="panel idle-panel">
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

      <ProductDrawer row={detailsRow} onClose={() => setDetailsId(null)} />
    </DashboardLayout>
  );
}
