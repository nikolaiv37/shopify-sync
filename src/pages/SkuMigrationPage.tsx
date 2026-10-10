import { useEffect, useMemo, useState } from 'react';
import { DashboardLayout } from '../components/layout/DashboardLayout';
import { Button } from '../components/ui/Buttons';
import { Select } from '../components/ui/Select';
import { SKU_API_VERSION, applySkuBatch, getSkuSuppliers, previewSkuMigration, type SkuApplyItem } from '../lib/api';
import type { SkuApplyResult, SkuMigrationRow, SkuMigrationStatus, SkuSupplierInfo, SupplierKey } from '../lib/types';

const nf = new Intl.NumberFormat('bg-BG');
const fmt = (value: unknown) => nf.format(Number(value) || 0);

const statusText: Record<SkuMigrationStatus, string> = {
  change: 'За промяна',
  already: 'Вече променен',
  unmatched: 'Без съвпадение',
  conflict: 'Проблем',
};

const reasonText: Record<string, string> = {
  'duplicate-feed-old-sku': 'Дублиран стар SKU във feed-а',
  'duplicate-shopify-old-sku': 'Дублиран стар SKU в Shopify',
  'vendor-mismatch': 'SKU принадлежи на друг Shopify vendor',
  'not-in-shopify': 'Старият и новият SKU не са намерени в Shopify',
  'feed-mapping-changed': 'Feed mapping-ът е променен след прегледа',
  'variant-missing': 'Вариантът вече не съществува',
  'sku-changed-after-preview': 'SKU е променен след прегледа',
};

type Filter = 'change' | 'all' | 'already' | 'problem';

export function SkuMigrationPage() {
  const [suppliers, setSuppliers] = useState<SkuSupplierInfo[]>([]);
  const [supplierKey, setSupplierKey] = useState<SupplierKey | ''>('');
  const [loadingSuppliers, setLoadingSuppliers] = useState(true);
  const [apiCompatible, setApiCompatible] = useState(false);
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewSkuMigration>> | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState<Filter>('change');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [processed, setProcessed] = useState(0);
  const [activeBatch, setActiveBatch] = useState({ current: 0, total: 0 });
  const [results, setResults] = useState<SkuApplyResult[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    getSkuSuppliers()
      .then(({ apiVersion, suppliers: items }) => {
        if (apiVersion !== SKU_API_VERSION) {
          throw new Error('SKU страницата е по-нова от работещия API сървър. Спрете всички стари процеси, стартирайте npm run dev отново и направете hard refresh.');
        }
        setApiCompatible(true);
        setSuppliers(items);
        setSupplierKey(items[0]?.key || '');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Доставчиците не се заредиха.'))
      .finally(() => setLoadingSuppliers(false));
  }, []);

  const supplier = suppliers.find((item) => item.key === supplierKey) || null;

  function resetReview() {
    setPreview(null);
    setSelected(new Set());
    setResults([]);
    setProcessed(0);
    setActiveBatch({ current: 0, total: 0 });
    setFilter('change');
    setSearch('');
    setPage(1);
    setError('');
  }

  function changeSupplier(key: SupplierKey) {
    setSupplierKey(key);
    resetReview();
  }

  async function runPreview() {
    if (!supplierKey) return;
    setPreviewing(true);
    resetReview();
    try {
      const data = await previewSkuMigration(supplierKey);
      setPreview(data);
      setSelected(new Set(data.rows.filter((row) => row.selectable && row.variantId).map((row) => row.variantId as string)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Прегледът не бе изпълнен.');
    } finally {
      setPreviewing(false);
    }
  }

  const changeRows = useMemo(() => (preview?.rows || []).filter((row) => row.selectable && row.variantId), [preview]);
  const visibleRows = useMemo(() => {
    let rows = preview?.rows || [];
    if (filter === 'change') rows = rows.filter((row) => row.status === 'change');
    else if (filter === 'already') rows = rows.filter((row) => row.status === 'already');
    else if (filter === 'problem') rows = rows.filter((row) => row.status === 'conflict' || row.status === 'unmatched');
    const query = search.trim().toLocaleLowerCase();
    if (query) rows = rows.filter((row) => [row.oldSku, row.newSku, row.title, row.shopifyTitle].some((value) => String(value || '').toLocaleLowerCase().includes(query)));
    return rows;
  }, [filter, preview, search]);
  const pageSize = 100;
  const totalPages = Math.max(1, Math.ceil(visibleRows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageRows = visibleRows.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  function toggle(row: SkuMigrationRow) {
    if (!row.selectable || !row.variantId) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(row.variantId as string)) next.delete(row.variantId as string);
      else next.add(row.variantId as string);
      return next;
    });
  }

  async function applySelected() {
    if (!supplierKey || !supplier) return;
    const items: SkuApplyItem[] = changeRows
      .filter((row) => selected.has(row.variantId as string))
      .map((row) => ({ variantId: row.variantId as string, oldSku: row.oldSku, newSku: row.newSku }));
    if (!items.length) return;

    setConfirmOpen(false);
    setApplying(true);
    setProcessed(0);
    setResults([]);
    setError('');
    const collected: SkuApplyResult[] = [];
    const batchSize = supplier.batchSize || 50;
    const totalBatches = Math.ceil(items.length / batchSize);
    setActiveBatch({ current: 1, total: totalBatches });
    for (let index = 0; index < items.length; index += batchSize) {
      const batch = items.slice(index, index + batchSize);
      setActiveBatch({ current: Math.floor(index / batchSize) + 1, total: totalBatches });
      try {
        const response = await applySkuBatch(supplierKey, batch);
        collected.push(...response.results);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Грешка при заявката.';
        collected.push(...batch.map((item) => ({ ...item, status: 'failed' as const, error: message })));
        setError(`Партида ${Math.floor(index / batchSize) + 1} бе прекратена: ${message}`);
        setProcessed(Math.min(index + batch.length, items.length));
        setResults([...collected]);
        break;
      }
      setProcessed(Math.min(index + batch.length, items.length));
      setResults([...collected]);
    }
    setApplying(false);
  }

  const succeeded = results.filter((item) => item.status === 'success' || item.status === 'already').length;
  const failed = results.length - succeeded;
  const failedResults = results.filter((item) => item.status !== 'success' && item.status !== 'already');
  const applyTotal = changeRows.filter((row) => selected.has(row.variantId as string)).length;

  return (
    <DashboardLayout
      active="sku"
      eyebrow="Операции"
      title="Промяна на SKU"
      subtitle="Мигрирайте Shopify SKU към одобреното поле от XML feed-а, по един доставчик и след задължителен преглед."
      wide
    >
      <section className="panel sku-workflow">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Настройка</p>
            <h2>Изберете доставчик</h2>
          </div>
          <span className="mode-pill preview">Първо преглед</span>
        </div>
        <div className="form-grid">
          <div className="field">
            <span>Доставчик</span>
            <Select<SupplierKey>
              value={supplierKey}
              options={suppliers.map((item) => ({ value: item.key, label: item.name, description: item.vendor }))}
              loading={loadingSuppliers}
              ariaLabel="Доставчик за SKU миграция"
              onChange={changeSupplier}
            />
          </div>
          <div className="sku-mapping-card">
            <span className="sku-map-field">&lt;{supplier?.oldField || '—'}&gt;</span>
            <span className="sku-map-arrow" aria-hidden="true">→</span>
            <span className="sku-map-field is-target">&lt;{supplier?.newField || '—'}&gt;</span>
          </div>
        </div>
        {supplierKey === 'b2bmarkt' ? (
          <p className="notice warning">B2BMarkt съдържа повтарящи се ItemCode стойности. Те са разрешени според избора ви и са маркирани в таблицата; бъдещите автоматични операции ги пропускат безопасно като нееднозначни.</p>
        ) : null}
        {error ? <p className="notice error">{error}</p> : null}
        <div className="action-row">
          <Button variant="secondary" disabled={!apiCompatible || !supplierKey || previewing || applying} onClick={runPreview}>
            {previewing ? 'Проверяване…' : 'Направи преглед'}
          </Button>
          <p>Прегледът не променя Shopify.</p>
        </div>
      </section>

      {preview ? (
        <>
          <section className="stat-row sku-stats">
            <div className="stat"><span className="stat-label">За промяна</span><strong className="stat-value">{fmt(preview.summary.toChange)}</strong></div>
            <div className="stat"><span className="stat-label">Вече променени</span><strong className="stat-value">{fmt(preview.summary.alreadyChanged)}</strong></div>
            <div className="stat"><span className="stat-label">Без съвпадение</span><strong className="stat-value">{fmt(preview.summary.unmatched)}</strong></div>
            <div className="stat is-attention"><span className="stat-label">Дублирани нови SKU</span><strong className="stat-value">{fmt(preview.summary.duplicateTargetProducts)}</strong><span className="stat-sub">{fmt(preview.summary.duplicateTargetValues)} стойности</span></div>
            <div className="stat is-error"><span className="stat-label">Проблеми</span><strong className="stat-value">{fmt(preview.summary.conflicts)}</strong></div>
          </section>

          <section className="workspace">
            <div className="section-heading">
              <div><h2>Преглед на промените <span className="workspace-count">{fmt(visibleRows.length)}</span></h2></div>
              <div className="review-search"><input value={search} placeholder="Търси SKU или продукт…" aria-label="Търсене" onChange={(event) => { setSearch(event.target.value); setPage(1); }} /></div>
            </div>
            <div className="review-toolbar">
              <div className="filter-row">
                {(['change', 'all', 'already', 'problem'] as Filter[]).map((item) => (
                  <button key={item} type="button" className={`filter-pill${filter === item ? ' active' : ''}`} onClick={() => { setFilter(item); setPage(1); }}>
                    {item === 'change' ? 'За промяна' : item === 'all' ? 'Всички' : item === 'already' ? 'Вече променени' : 'Проблеми'}
                  </button>
                ))}
              </div>
            </div>
            <div className="selection-bar">
              <div className="selection-info"><strong>{fmt(selected.size)} избрани</strong><span className="selection-note">от {fmt(changeRows.length)} възможни промени</span></div>
              <div className="selection-actions">
                <button className="link-btn" type="button" onClick={() => setSelected(new Set(changeRows.map((row) => row.variantId as string)))}>Избери всички</button>
                <button className="link-btn" type="button" onClick={() => setSelected(new Set())}>Изчисти</button>
                <Button variant="primary" disabled={!selected.size || applying} onClick={() => setConfirmOpen(true)}>Приложи избраните</Button>
              </div>
            </div>
            <div className="missing-table-wrap">
              <table className="missing-table sku-table">
                <thead><tr><th className="col-check" /><th>Стар SKU</th><th>Нов SKU</th><th>Продукт</th><th>Състояние</th><th>Бележка</th></tr></thead>
                <tbody>
                  {pageRows.map((row, index) => (
                    <tr key={`${row.oldSku}-${index}`} className={row.status === 'change' ? '' : 'is-muted'}>
                      <td className="col-check"><input type="checkbox" aria-label={`Маркирай ${row.oldSku}`} checked={Boolean(row.variantId && selected.has(row.variantId))} disabled={!row.selectable} onChange={() => toggle(row)} /></td>
                      <td className="cell-supplier sku-code">{row.oldSku}</td>
                      <td className="cell-supplier sku-code">{row.newSku}</td>
                      <td className="col-title"><div className="missing-title">{row.shopifyTitle || row.title || '—'}</div></td>
                      <td><span className={`status-pill ${row.status}`}>{statusText[row.status]}</span></td>
                      <td className="col-note">{row.duplicateTarget ? 'Повтарящ се нов SKU' : reasonText[row.reason || ''] || '—'}</td>
                    </tr>
                  ))}
                  {!visibleRows.length ? <tr><td className="empty-cell" colSpan={6}><strong>Няма редове</strong><span>Променете филтъра или търсенето.</span></td></tr> : null}
                </tbody>
              </table>
            </div>
            {visibleRows.length > pageSize ? (
              <div className="pagination-row">
                <span>Страница {fmt(currentPage)} от {fmt(totalPages)} · по {fmt(pageSize)} реда</span>
                <div className="pagination-actions">
                  <Button size="sm" disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Назад</Button>
                  <Button size="sm" disabled={currentPage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>Напред</Button>
                </div>
              </div>
            ) : null}
          </section>
        </>
      ) : null}

      {(applying || results.length > 0) ? (
        <section className={`panel result-panel ${failed ? 'is-warning' : 'is-success'}`}>
          <div className="panel-heading"><h2>{applying ? 'Прилагане на SKU промените…' : 'SKU миграцията приключи'}</h2></div>
          {applying ? <p className="result-sub">Обработва се партида {fmt(activeBatch.current)} от {fmt(activeBatch.total)}. Всяка партида съдържа до {fmt(supplier?.batchSize || 25)} продукта.</p> : null}
          <div className="apply-progress">
            <div className="apply-progress-head"><strong>{fmt(processed)} / {fmt(applyTotal)}</strong><span>{applyTotal ? Math.round((processed / applyTotal) * 100) : 0}%</span></div>
            <div className="apply-bar"><span style={{ width: `${applyTotal ? (processed / applyTotal) * 100 : 0}%` }} /></div>
            <div className="apply-counts"><span className="ok">Успешни: {fmt(succeeded)}</span><span className={failed ? 'err' : ''}>Пропуснати/грешки: {fmt(failed)}</span></div>
          </div>
          {!applying && failedResults.length ? (
            <details className="tech-details" open>
              <summary>Покажи грешките ({fmt(failedResults.length)})</summary>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Стар SKU</th><th>Нов SKU</th><th>Причина</th></tr></thead>
                  <tbody>
                    {failedResults.slice(0, 100).map((item, index) => (
                      <tr key={`${item.variantId}-${index}`}>
                        <td className="sku-code">{item.oldSku}</td>
                        <td className="sku-code">{item.newSku}</td>
                        <td>{item.error || reasonText[item.reason || ''] || item.reason || 'Неизвестна грешка'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {failedResults.length > 100 ? <p className="result-sub">Показани са първите 100 грешки.</p> : null}
            </details>
          ) : null}
          {!applying ? <div className="action-row"><Button variant="secondary" onClick={runPreview}>Нов преглед</Button></div> : null}
        </section>
      ) : null}

      {confirmOpen ? (
        <div className="modal-overlay">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="sku-confirm-title">
            <div className="modal-icon" aria-hidden="true">!</div>
            <h3 id="sku-confirm-title">Да променя ли {fmt(selected.size)} SKU?</h3>
            <p className="modal-body">Ще бъде променено само полето SKU на избраните Shopify варианти за {supplier?.name}.</p>
            <ul className="modal-points">
              <li className="will">Използва се одобреният XML tag &lt;{supplier?.newField}&gt;</li>
              <li className="will">Всеки ред се проверява отново непосредствено преди запис</li>
              <li className="wont">Не се променят цени, наличности, имена, баркодове или категории</li>
            </ul>
            <p className="modal-hint">Продължете само ако сте прегледали mapping-а стар SKU → нов SKU.</p>
            <div className="modal-actions"><Button variant="ghost" onClick={() => setConfirmOpen(false)}>Отказ</Button><Button variant="primary" onClick={applySelected}>Да, промени SKU</Button></div>
          </div>
        </div>
      ) : null}
    </DashboardLayout>
  );
}
