import { useEffect, useMemo, useRef, useState } from 'react';
import { DashboardLayout } from '../components/layout/DashboardLayout';
import { Button } from '../components/ui/Buttons';
import { Progress } from '../components/feedback/Progress';
import { previewInventory, applyInventoryBatch, persistInventoryMappings, getInventoryHistory, discoverInventoryIdentities, runSync, getRuns } from '../lib/api';
import type { InventoryPreview, InventoryHistory, IdentityDiscovery, InventoryBatchResult, SupplierKey, SyncSummary, RecentRun } from '../lib/types';

const suppliers = [{ key: 'megapap' as const, name: 'MegaPap' }, { key: 'b2bmarkt' as const, name: 'B2BMarkt' }, { key: 'symetron' as const, name: 'Symetron' }];
const names = Object.fromEntries(suppliers.map(s => [s.key, s.name]));
const nf = new Intl.NumberFormat('bg-BG');
const date = (s?: string) => s ? new Date(s).toLocaleString('bg-BG', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const labels: Record<string, string> = { change: 'Ще се промени', already: 'Без промяна', unmatched: 'Няма съвпадение', conflict: 'Конфликт', invalid_quantity: 'Невалидна наличност', skipped: 'Пропуснат', verified: 'Потвърден', insufficient: 'Недостатъчни данни', success: 'Обновен', stale: 'Променена наличност', failed: 'Грешка' };
const reasons: Record<string, string> = {
  'missing-persisted-mapping': 'Идентичността трябва да се запише след преглед на съпоставянето.',
  'missing-shopify-variant': 'Артикулът не е намерен в Shopify.',
  'owned-by-other-supplier': 'Наличността се управлява от друг доставчик.',
  'ownership-source-missing-review': 'Собственикът липсва в своя каталог. Нужен е преглед.',
  'duplicate-supplier-identifier': 'Повтарящ се идентификатор в каталога.',
  'duplicate-shopify-destination': 'Идентичността сочи към няколко варианта.',
  'invalid-quantity': 'Наличността е отрицателна или невалидна.',
  'missing-quantity': 'Доставчикът не е посочил наличност.',
  'unsupported-quantity': 'Неподдържана стойност на наличност.',
  'unresolved-ownership': 'Няма потвърден собственик за тази локация.',
  'inventory-not-tracked': 'Вариантът няма активно проследяване на наличност.',
  'location-inventory-unavailable': 'Няма проверена наличност за избраната локация.',
  'ambiguous-evidence': 'Данните сочат към различни продукти.',
  'insufficient-evidence': 'Няма достатъчно независими данни за съпоставяне.',
  'cross-supplier-or-destination-conflict': 'Непотвърдено припокриване на доставчици.',
  'quantity-changed-after-preview': 'Наличността е променена след прегледа. Обновете прегледа.',
  'persisted-identity': 'Записана идентичност', 'corroborated-evidence': 'Потвърдено по независими данни',
};
function download(name: string, body: string, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type })); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url);
}
function csv(rows: Array<Record<string, unknown>>) {
  const fields = ['supplier', 'supplierProductId', 'title', 'shopifyTitle', 'itemCode', 'currentSku', 'variantId', 'currentQuantity', 'quantity', 'delta', 'status', 'reason', 'suggestedResolution'];
  const cell = (value: unknown) => { let s = String(value ?? ''); if (/^[=+@\-\t\r]/.test(s)) s = `'${s}`; return `"${s.replaceAll('"', '""')}"`; };
  return '\uFEFF' + [fields.join(','), ...rows.map(row => fields.map(f => cell(row[f])).join(','))].join('\r\n');
}

export function InventorySyncPage() {
  const [previews, setPreviews] = useState<Partial<Record<SupplierKey, InventoryPreview>>>({});
  const [selected, setSelected] = useState<SupplierKey>('megapap');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState(''); const [error, setError] = useState('');
  const [history, setHistory] = useState<InventoryHistory[]>([]); const [historyError, setHistoryError] = useState('');
  const [portalHistory, setPortalHistory] = useState<RecentRun[]>([]); const [portalVolatile, setPortalVolatile] = useState(false);
  const [portal, setPortal] = useState<Partial<Record<SupplierKey, SyncSummary>>>({});
  const [discovery, setDiscovery] = useState<IdentityDiscovery | null>(null);
  const [showDiscovery, setShowDiscovery] = useState(false);
  const [search, setSearch] = useState(''); const [filter, setFilter] = useState('all'); const [page, setPage] = useState(0);
  const [outcomes, setOutcomes] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<{ supplier: SupplierKey; portal: boolean } | null>(null);
  const [mappingConfirm, setMappingConfirm] = useState(false);
  const stopMapping = useRef(false);
  const [large, setLarge] = useState(false); const [clock, setClock] = useState(Date.now());
  const guard = useRef(false); const dialog = useRef<HTMLDivElement>(null); const previousFocus = useRef<HTMLElement | null>(null);
  async function loadHistory() {
    const results = await Promise.allSettled([getInventoryHistory(), getRuns()]);
    if (results[0].status === 'fulfilled') { setHistory(results[0].value.runs); setHistoryError(''); } else setHistoryError('Историята от Shopify не е достъпна. Опитайте „Обнови“.');
    if (results[1].status === 'fulfilled') { setPortalHistory(results[1].value.runs.filter(r => r.target === 'b2bcenter')); setPortalVolatile(results[1].value.volatile); }
  }
  useEffect(() => { void loadHistory(); const timer = window.setInterval(() => setClock(Date.now()), 15000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    if (!pending && !mappingConfirm) return;
    previousFocus.current = document.activeElement as HTMLElement;
    const first = dialog.current?.querySelector<HTMLElement>('input, button'); first?.focus();
    function keydown(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); setPending(null); setMappingConfirm(false); }
      if (e.key === 'Tab') {
        const list = Array.from(dialog.current?.querySelectorAll<HTMLElement>('input, button:not(:disabled)') || []);
        const first = list[0], last = list.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); previousFocus.current?.focus(); };
  }, [pending, mappingConfirm]);
  const preview = previews[selected];
  const rows = showDiscovery ? discovery?.rows || [] : preview?.rows || [];
  const filtered = useMemo(() => rows.filter(row => {
    const problem = !['change', 'already', 'verified'].includes(row.status);
    return (filter === 'all' || (filter === 'problems' ? problem : row.status === filter)) && `${row.title} ${row.shopifyTitle || ''} ${row.itemCode} ${row.supplierProductId} ${row.currentSku || ''}`.toLowerCase().includes(search.toLowerCase());
  }), [rows, filter, search]);
  const expired = (p?: InventoryPreview) => !p || clock >= new Date(p.expiresAt).getTime();
  async function task(key: string, action: () => Promise<void>) {
    if (guard.current) return; guard.current = true; setBusy(key); setError(''); setMessage('');
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : 'Операцията не бе изпълнена. Обновете прегледа.'); }
    finally { if (key.startsWith('apply-') || key === 'backfill') await loadHistory(); guard.current = false; setBusy(null); setClock(Date.now()); }
  }
  async function inspect(supplier: SupplierKey, allowPartial = false) {
    await task(`preview-${supplier}`, async () => { setSelected(supplier); setShowDiscovery(false); setPage(0); setOutcomes({}); const p = await previewInventory(supplier, allowPartial); setPreviews(prev => ({ ...prev, [supplier]: p })); setMessage(`${names[supplier]}: прегледът е готов. Няма направени промени.${p.partial ? ' Ще се синхронизират само потвърдените продукти; останалите се пропускат.' : ''}`); });
  }
  async function saveMappings() {
    setMappingConfirm(false);
    const report = discovery;
    if (!report || Date.now() >= new Date(report.expiresAt).getTime()) { setError('Прегледът на съпоставянето е изтекъл. Направете нов преглед.'); return; }
    stopMapping.current = false;
    await task('backfill', async () => {
      setPreviews({});
      let saved = 0, skipped = 0, errors = 0;
      for (const [index, token] of report.batches.entries()) {
        if (stopMapping.current) break;
        setMessage(`Съпоставяне: партида ${index + 1} от ${report.batches.length} · ${saved} записани. Наличностите не се променят.`);
        const result = await persistInventoryMappings(token, index === 0);
        saved += result.counts.updated; skipped += result.counts.skipped; errors += result.counts.errors;
      }
      setMessage(`Съпоставяне: ${saved} записани, ${skipped} пропуснати, ${errors} грешки. Наличностите не са променени. Направете преглед на проверените продукти за избрания доставчик.`);
    });
  }
  async function inspectMappings() {
    await task('discovery', async () => { setDiscovery(await discoverInventoryIdentities()); setShowDiscovery(true); setFilter('all'); setPage(0); setMessage('Съпоставянето е прегледано без записи. Записването е отделна, потвърдена операция.'); });
  }
  async function inspectPortal(supplier: SupplierKey) {
    await task(`portal-preview-${supplier}`, async () => {
      const result = await runSync({ supplierKey: supplier, target: 'b2bcenter', dryRun: true });
      if (result.summary) setPortal(prev => ({ ...prev, [supplier]: result.summary! }));
      setMessage(`B2BCenter · ${names[supplier]}: ${result.summary?.planned || 0} промени, ${result.summary?.skipped || 0} пропуснати. Няма записи.`); await loadHistory();
    });
  }
  async function apply() {
    if (!pending) return; const request = pending; setPending(null);
    await task(`apply-${request.supplier}`, async () => {
      if (request.portal) {
        const p = portal[request.supplier];
        const result = await runSync({ supplierKey: request.supplier, target: 'b2bcenter', dryRun: false, confirm: true, allowLargeApply: large, previewToken: p?.previewToken || undefined });
        setMessage(`B2BCenter: ${result.summary?.updated || 0} обновени, ${result.summary?.errors || 0} грешки${result.summary?.safety?.thresholdBlocked ? ' — блокирано от прага' : ''}.`);
        setPortal(prev => ({ ...prev, [request.supplier]: undefined }));
      } else {
        const p = previews[request.supplier]; if (!p || expired(p) || !p.canApply) throw new Error('Направете нов валиден преглед.');
        setSelected(request.supplier); setShowDiscovery(false);
        const counts = { updated: 0, skipped: 0, errors: 0 };
        for (const [index, token] of p.batches.entries()) {
          setMessage(`Партида ${index + 1} от ${p.batches.length} · ${counts.updated} обновени`);
          const result: InventoryBatchResult = await applyInventoryBatch(request.supplier, token, large);
          for (const k of ['updated', 'skipped', 'errors'] as const) counts[k] += result.counts[k];
          setOutcomes(prev => ({ ...prev, ...Object.fromEntries(result.results.filter(r => r.rowId).map(r => [r.rowId!, r.status])) }));
        }
        setMessage(`${names[request.supplier]}: ${counts.updated} обновени, ${counts.skipped} пропуснати, ${counts.errors} грешки. ${counts.errors || counts.skipped ? 'Направете нов преглед за оставащите промени.' : 'Синхронизацията приключи.'}`);
        setPreviews(prev => ({ ...prev, [request.supplier]: { ...p, canApply: false, batches: [] } }));
      }
      await loadHistory();
    });
  }
  const pendingPreview = pending ? previews[pending.supplier] : undefined;
  const needsLarge = pending?.portal ? (portal[pending.supplier]?.safety?.plannedChangePct || 0) > (portal[pending.supplier]?.safety?.maxChangePct || 40) : pendingPreview?.thresholdExceeded;
  const pages = Math.max(1, Math.ceil(filtered.length / 50));
  return <DashboardLayout active="inventory" eyebrow="Оперативен панел" title="Синхронизация на наличности" subtitle="Прегледайте промените и проблемите, след което потвърдете синхронизацията за избрания доставчик и локация.">
    <div className="inventory-v2">
      <div className="inv-workflow"><span>1 · Преглед</span><span>2 · Проверка на промените</span><span>3 · Потвърждение и синхронизация</span><Button size="sm" onClick={() => void inspectMappings()} disabled={!!busy}>Преглед на съпоставянето</Button></div>
      <p className="inv-help">При първо използване: „Преглед на съпоставянето“ → проверете резултата → „Запиши проверените съпоставяния“. След това направете преглед на наличностите и потвърдете синхронизацията.</p>
      {showDiscovery && discovery && <div className="inv-workflow"><Button variant="primary" disabled={!!busy || !discovery.batches.length || discovery.prerequisites.length > 0 || clock >= new Date(discovery.expiresAt).getTime()} onClick={() => setMappingConfirm(true)}>Запиши проверените съпоставяния</Button><span>{nf.format(discovery.proposedMappings)} предложени записи · без промяна на наличности</span></div>}
      {busy === 'backfill' && <Button onClick={() => { stopMapping.current = true; setMessage('Съпоставянето ще спре след текущата партида. Завършените записи се запазват.'); }}>Спри след текущата партида</Button>}
      {busy && <Progress text={busy === 'discovery' ? 'Проверяват се идентичностите в трите каталога и Shopify…' : busy.startsWith('apply') || busy === 'backfill' ? message || 'Проверка и прилагане на партидата…' : 'Четат се каталозите и наличностите. Без записи…'} />}
      <div aria-live="polite">{message && <p className="inv-notice">{message}</p>}</div>
      {error && <p className="inv-notice is-error" role="alert">{error} Завършените партиди остават записани; проверете историята преди повторение.</p>}
      <section aria-labelledby="shopify-title"><div className="section-heading"><div><p className="eyebrow">Онлайн магазин</p><h2 id="shopify-title">Наличности в Shopify</h2></div><p className="section-note">Наличност за конкретната локация · Само потвърдени идентичности</p></div>
        <div className="inv-grid">{suppliers.map(s => {
          const p = previews[s.key]; const last = history.find(h => h.supplier === s.key && h.operation === 'inventory' && h.status === 'complete' && h.totals.errors === 0 && h.totals.updated > 0);
          return <article key={s.key} className={`supplier-card inv-card ${selected === s.key && !showDiscovery ? 'is-selected' : ''}`}>
            <div className="card-head"><div><h3>{s.name}</h3><p className="card-caption">Shopify{p ? ` · ${p.location.name}` : ''}</p></div><span className={`inv-state ${p?.mappingReady ? 'is-verified' : ''}`}>{p ? p.mappingReady ? 'Съпоставен' : 'Нужен преглед' : 'Непроверен'}</span></div>
            <p className="inv-connection">{p ? 'Връзка потвърдена при прегледа' : 'Връзка и идентичности: непроверени'}</p>
            <div className="inv-metrics"><div><strong>{p ? nf.format(p.summary.matched) : '—'}</strong><span>съпоставени</span></div><div><strong>{p ? nf.format(p.summary.changes) : '—'}</strong><span>промени</span></div><div><strong>{p ? nf.format(p.summary.unmatched + p.summary.conflicts + p.summary.invalidQuantities) : '—'}</strong><span>за преглед</span></div></div>
            <dl className="inv-timestamps"><div><dt>Преглед</dt><dd>{date(p?.generatedAt)}{p && expired(p) ? ' · изтекъл' : ''}</dd></div><div><dt>Успешен синхрон</dt><dd>{date(last?.finishedAt)}</dd></div></dl>
            {p?.mappingMissing ? <p className="inv-help">{p.mappingMissing} идентичности чакат потвърдено записване.</p> : null}
            {p?.prerequisites.map(text => <p className="inv-help" key={text}>{text}</p>)}
            {p?.partial && <p className="inv-help">Частичен преглед: само проверените продукти. {p.summary.skipped} проблемни или недопустими реда се пропускат.</p>}
            <div className="card-actions"><Button variant="secondary" disabled={!!busy} onClick={() => void inspect(s.key)}>Преглед на промените</Button><Button variant="primary" disabled={!!busy || !p?.canApply || expired(p)} onClick={() => { setLarge(false); setPending({ supplier: s.key, portal: false }); }}>{p?.partial ? 'Синхронизирай проверените' : 'Синхронизирай'}</Button></div>
            {p && !p.mappingReady && p.prerequisites.length === 0 && <Button size="sm" disabled={!!busy} onClick={() => void inspect(s.key, true)}>Преглед само на проверените</Button>}
            <div className="inv-card-links"><button disabled={!p || !!busy} onClick={() => { setSelected(s.key); setShowDiscovery(false); setFilter('problems'); setPage(0); }}>Виж проблемите</button><a href="#inventory-history">История</a></div>
          </article>;
        })}</div>
      </section>
      {(preview || showDiscovery && discovery) && <section className="panel inv-preview" aria-labelledby="preview-title"><div className="panel-heading"><div><p className="eyebrow">{showDiscovery ? 'Идентичности' : 'Преглед · без промени'}</p><h2 id="preview-title">{showDiscovery ? 'Съпоставяне на доставчиците' : `${names[selected]} · ${preview?.location.name}`}</h2></div><div className="inv-export"><Button size="sm" onClick={() => download('inventory-problems.csv', csv(filtered.filter(r => !['change', 'already', 'verified'].includes(r.status))), 'text/csv;charset=utf-8')}>Експорт на проблемите</Button>{showDiscovery && discovery && <Button size="sm" onClick={() => download('inventory-discovery.json', JSON.stringify(discovery, null, 2), 'application/json')}>Изтегли съпоставянето</Button>}</div></div>
        {showDiscovery && discovery ? <><p className="inv-help">{discovery.proposedMappings} проверени записи са предложени. Записването се прави отделно, след одобрение. Припокриващите се продукти се управляват от B2BMarkt.</p><div className="inv-metrics inv-discovery">{suppliers.map(s => <div key={s.key}><strong>{s.name}: {discovery.summary[s.key].verified}</strong><span>потвърдени · {discovery.summary[s.key].unmatched} липсващи · {discovery.summary[s.key].conflicts + discovery.summary[s.key].insufficient} за преглед</span></div>)}</div>{discovery.prerequisites.map(p => <p key={p} className="inv-help">{p}</p>)}</> : preview && <><div className="inv-summary">{[['Редове', preview.summary.feedRows], ['Валидни', preview.summary.validRows], ['Съпоставени', preview.summary.matched], ['Промени', preview.summary.changes], ['Без промяна', preview.summary.alreadyCorrect], ['Несъпоставени', preview.summary.unmatched], ['Конфликти', preview.summary.conflicts], ['Невалидни', preview.summary.invalidQuantities], ['Пропуснати', preview.summary.skipped], ['Грешки', preview.summary.errors]].map(([label, count]) => <div key={label}><span>{label}</span><strong>{nf.format(Number(count))}</strong></div>)}</div><p className="inv-help">Преглед от {date(preview.generatedAt)} · Валиден до {date(preview.expiresAt)} · {preview.mappingReady ? 'Идентичностите на намерените продукти са проверени.' : 'Синхронизацията е блокирана до потвърждаване на идентичностите.'}</p></>}
        <div className="inv-table-tools"><label>Търсене<input value={search} placeholder="Продукт, SKU или артикулен код" onChange={e => { setSearch(e.target.value); setPage(0); }} /></label><label>Статус<select value={filter} onChange={e => { setFilter(e.target.value); setPage(0); }}><option value="all">Всички</option><option value="problems">Само проблемите</option>{(showDiscovery ? ['verified', 'unmatched', 'conflict', 'insufficient'] : ['change', 'already', 'unmatched', 'conflict', 'invalid_quantity', 'skipped']).map(status => <option key={status} value={status}>{labels[status]}</option>)}</select></label></div>
        <div className="table-wrap"><table><thead><tr><th>Продукт / доставчик</th><th>SKU / артикул</th><th className="num">Текуща</th><th className="num">Доставчик</th><th className="num">Промяна</th><th>Статус</th></tr></thead><tbody>{filtered.slice(page * 50, (page + 1) * 50).map(row => {
          const qty = 'currentQuantity' in row ? row : null; const status = outcomes[row.rowId] || row.status;
          return <tr key={row.rowId}><td><strong>{row.shopifyTitle || row.title}</strong><small className="inv-cell-detail">{names[row.supplier]} · {row.variantId || 'Няма потвърден вариант'}</small></td><td>{row.currentSku || row.itemCode || '—'}<small className="inv-cell-detail">ID: {row.supplierProductId || 'Липсва'}</small></td><td className="num">{qty?.currentQuantity ?? '—'}</td><td className="num">{qty?.quantity ?? '—'}</td><td className="num">{qty?.delta == null ? '—' : `${qty.delta > 0 ? '+' : ''}${qty.delta}`}</td><td><span className={`inv-row-state is-${status}`}>{labels[status] || status}</span><small className="inv-cell-detail">{row.reason ? reasons[row.reason] || row.reason : ''}{'owner' in row && row.overlap ? ` · Собственик: ${names[row.owner || 'b2bmarkt']}` : ''}</small></td></tr>;
        })}{!filtered.length && <tr><td colSpan={6} className="empty-cell">Няма редове за избрания филтър.</td></tr>}</tbody></table></div>
        <div className="inv-pagination"><span>{nf.format(filtered.length)} реда · Страница {Math.min(page + 1, pages)} от {pages}</span><Button size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Назад</Button><Button size="sm" disabled={page + 1 >= pages} onClick={() => setPage(p => p + 1)}>Напред</Button></div>
      </section>}
      <section aria-labelledby="portal-title"><div className="section-heading"><div><p className="eyebrow">Портал за доставчици</p><h2 id="portal-title">B2BCenter</h2></div><p className="section-note">Отделно съпоставяне по артикул, клиент и производител</p></div><div className="inv-portal-grid">{suppliers.filter(s => s.key !== 'symetron').map(s => { const p = portal[s.key]; return <article className="supplier-card inv-portal" key={s.key}><div><h3>{s.name}</h3><p className="card-caption">{p ? `${p.planned} промени · ${p.skipped} пропуснати` : 'Непроверена връзка · нужен е преглед'}</p><small>Последен преглед: {date(p?.finishedAt || undefined)}</small></div><div className="card-actions"><Button disabled={!!busy} onClick={() => void inspectPortal(s.key)}>Преглед</Button><Button variant="primary" disabled={!!busy || !p?.previewToken || !p.planned} onClick={() => { setLarge(false); setPending({ supplier: s.key, portal: true }); }}>Синхронизирай</Button></div></article>; })}</div><p className="inv-help">Symetron в B2BCenter: идентичностите и собствеността не са потвърдени. Синхронизацията не е активирана.</p></section>
      <section id="inventory-history" className="panel"><div className="panel-heading"><div><p className="eyebrow">История</p><h2>Последни операции</h2></div><Button size="sm" disabled={!!busy} onClick={() => void loadHistory()}>Обнови</Button></div>{historyError && <p role="status" className="inv-help">{historyError}</p>}{portalVolatile && <p className="inv-help">Историята на Shopify е постоянна. Логовете на портала във Vercel са временни.</p>}<div className="table-wrap"><table><thead><tr><th>Дестинация · Доставчик</th><th>Операция / статус</th><th>Начало / край</th><th className="num">Обновени</th><th className="num">Пропуснати</th><th className="num">Грешки</th></tr></thead><tbody>{history.map(h => <tr key={h.runId}><td>Shopify · {names[h.supplier] || 'Всички'}</td><td>{h.operation === 'backfill' ? 'Идентичности' : 'Наличности'} · {h.status === 'complete' ? 'Завършено' : 'Частично'}</td><td>{date(h.startedAt)}<small className="inv-cell-detail">{date(h.finishedAt)}</small></td><td className="num">{h.totals.updated}</td><td className="num">{h.totals.skipped}</td><td className="num">{h.totals.errors}</td></tr>)}{portalHistory.map((h, i) => <tr key={`portal-${i}`}><td>{h.supplier}</td><td>{h.mode === 'apply' ? 'Синхронизация' : 'Преглед'}</td><td>{date(h.finishedAt || undefined)}</td><td className="num">{h.updated}</td><td className="num">{h.skipped}</td><td className="num">{h.errors}</td></tr>)}{!history.length && !portalHistory.length && <tr><td colSpan={6} className="empty-cell">Няма записани операции. Прегледът не променя наличностите.</td></tr>}</tbody></table></div></section>
      {pending && <div className="modal-overlay"><div className="modal" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="inv-confirm-title"><h3 id="inv-confirm-title">Потвърдете синхронизацията</h3><p>{names[pending.supplier]} · {pending.portal ? 'B2BCenter' : `Shopify · ${pendingPreview?.location.name}`}<br />{pending.portal ? portal[pending.supplier]?.planned : pendingPreview?.summary.changes} промени само в наличностите.</p>{needsLarge && <label className="inv-large"><input type="checkbox" checked={large} onChange={e => setLarge(e.target.checked)} />Одобрявам промяната на повече от 40% от съпоставените наличности.</label>}<p className="inv-help">Всяка партида проверява отново идентичността, собствеността и наблюдаваната наличност.</p><div className="modal-actions"><Button onClick={() => setPending(null)}>Отказ</Button><Button variant="primary" disabled={!!needsLarge && !large} onClick={() => void apply()}>Потвърди и синхронизирай</Button></div></div></div>}
      {mappingConfirm && discovery && <div className="modal-overlay"><div className="modal" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="inv-mapping-title"><h3 id="inv-mapping-title">Потвърдете записването на съпоставянията</h3><p>{nf.format(discovery.proposedMappings)} проверени съпоставяния в Shopify. Създават се нужните защитени полета за идентичност и собственост. Наличностите, SKU, цените и съдържанието не се променят.</p><p className="inv-help">Конфликтните и недостатъчно потвърдените съпоставяния се пропускат. B2BMarkt управлява потвърдените припокривания със Symetron. Можете да спрете след текущата партида и да продължите с нов преглед.</p><div className="modal-actions"><Button onClick={() => setMappingConfirm(false)}>Отказ</Button><Button variant="primary" onClick={() => void saveMappings()}>Потвърди и запиши съпоставянията</Button></div></div></div>}
    </div>
  </DashboardLayout>;
}
