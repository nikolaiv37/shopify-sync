import { useEffect, useMemo, useState } from 'react';
import { DashboardLayout } from '../components/layout/DashboardLayout';
import { Button } from '../components/ui/Buttons';
import { Progress } from '../components/feedback/Progress';
import { StatusBadge } from '../components/feedback/StatusBadge';
import { getRuns, getStatus, runSync } from '../lib/api';
import type { RecentRun, SupplierKey, SyncSummary, SyncTarget } from '../lib/types';

const SUPPLIERS = [
  { key: 'megapap' as const, name: 'Megapap', vendor: 'Mebelcenter' },
  { key: 'b2bmarkt' as const, name: 'B2BMarkt', vendor: 'Europe' },
];

const nf = new Intl.NumberFormat('bg-BG');
const fmt = (n: unknown) => nf.format(Number(n) || 0);
const prod = (n: unknown) => (Number(n) === 1 ? 'продукт' : 'продукта');

function formatDate(value: string | null | undefined) {
  if (!value) return '—';
  return new Date(value).toLocaleString('bg-BG', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function joinBg(parts: string[]) {
  if (parts.length <= 1) return parts[0] || '';
  return `${parts.slice(0, -1).join(', ')} и ${parts[parts.length - 1]}`;
}

function buildSentence(s: SyncSummary) {
  if (s.dryRun) {
    if (Number(s.planned) === 0 && Number(s.errors) === 0) {
      return 'Прегледът приключи. Няма промени за прилагане — количествата са актуални.';
    }
    const parts = [`${fmt(s.planned)} ${prod(s.planned)} за обновяване`, `${fmt(s.skipped)} пропуснати`];
    if (s.errors > 0) parts.push(`${fmt(s.errors)} изискват внимание`);
    return `Прегледът е готов. Готови са ${joinBg(parts)}. Все още не са направени промени.`;
  }
  if (Number(s.updated) === 0 && Number(s.errors) === 0) {
    return 'Синхронизацията приключи. Няма нови промени — количествата са актуални.';
  }
  const parts = [`${fmt(s.updated)} ${prod(s.updated)} обновени`, `${fmt(s.skipped)} пропуснати`];
  if (s.errors > 0) parts.push(`${fmt(s.errors)} с грешки`);
  return `Синхронизацията приключи. ${joinBg(parts)}.${s.errors > 0 ? ' Прегледайте техническите детайли по-долу.' : ''}`;
}

function RunCard({
  target,
  supplier,
  running,
  lastText,
  onRun,
}: {
  target: SyncTarget;
  supplier: (typeof SUPPLIERS)[number];
  running: boolean;
  lastText: string;
  onRun: (supplierKey: SupplierKey, dryRun: boolean, target: SyncTarget) => void;
}) {
  const isPortal = target === 'b2bcenter';
  return (
    <article className={`supplier-card ${isPortal ? 'is-portal' : ''} ${running ? 'is-running' : ''}`}>
      <header className="card-head">
        <div className="card-title">
          <h3>{supplier.name}</h3>
          <p className="card-caption">
            {isPortal ? `Портал B2BCenter · ${supplier.vendor}` : `Магазин · Марка ${supplier.vendor}`}
          </p>
        </div>
        <span className={`health-dot ${running ? 'running' : 'ok'}`}>
          <span className="dot" aria-hidden="true" />
          {running ? 'Изпълнява се…' : 'В готовност'}
        </span>
      </header>
      <p className="card-desc">
        {isPortal
          ? `Обновява количествата на артикулите на ${supplier.name} в портала B2BCenter.`
          : `Обновява складовите количества в онлайн магазина по данни от ${supplier.name}.`}
      </p>
      <div className="last-result">{lastText}</div>
      <div className="card-actions">
        <Button variant="secondary" disabled={running} onClick={() => onRun(supplier.key, true, target)}>
          Преглед
        </Button>
        <Button variant="primary" disabled={running} onClick={() => onRun(supplier.key, false, target)}>
          Синхронизирай
        </Button>
      </div>
      <p className="card-foot">
        {isPortal ? 'Съпоставяне по артикул · Само количествата' : 'Ръчно стартиране · Обновяват се само количествата'}
      </p>
    </article>
  );
}

function ConfirmModal({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: { target: SyncTarget; supplierKey: SupplierKey } | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!pending) return null;
  const supplier = SUPPLIERS.find((s) => s.key === pending.supplierKey)?.name || pending.supplierKey;
  const portal = pending.target === 'b2bcenter';
  return (
    <div className="modal-overlay">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <div className="modal-icon" aria-hidden="true">
          !
        </div>
        <h3 id="confirm-title">{portal ? 'Синхронизация към портала?' : 'Да приложа ли синхронизацията?'}</h3>
        <p className="modal-body">
          {portal
            ? `Ще бъдат обновени количествата в портала B2BCenter за ${supplier}.`
            : `Ще бъдат обновени складовите количества в онлайн магазина (Shopify) за ${supplier}.`}
        </p>
        <ul className="modal-points">
          <li className="will">Обновява наличните количества на продуктите</li>
          <li className="wont">Не променя цени, имена, категории, снимки или видимост</li>
        </ul>
        <p className="modal-hint">Уверете се, че първо сте направили „Преглед“ и числата са очаквани.</p>
        <div className="modal-actions">
          <Button variant="ghost" onClick={onCancel}>
            Отказ
          </Button>
          <Button variant="primary" onClick={onConfirm}>
            Да, приложи
          </Button>
        </div>
      </div>
    </div>
  );
}

export function InventorySyncPage() {
  const [running, setRunning] = useState(false);
  const [runningKey, setRunningKey] = useState<string | null>(null);
  const [summary, setSummary] = useState<SyncSummary | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [runs, setRuns] = useState<RecentRun[]>([]);
  const [statusTone, setStatusTone] = useState<'idle' | 'running' | 'success' | 'warning' | 'error'>('idle');
  const [statusText, setStatusText] = useState('В готовност');
  const [pendingApply, setPendingApply] = useState<{ target: SyncTarget; supplierKey: SupplierKey } | null>(null);

  async function loadRuns() {
    const data = await getRuns();
    setRuns(data.runs || []);
  }

  useEffect(() => {
    loadRuns().catch(() => setRuns([]));
    const timer = window.setInterval(async () => {
      try {
        const data = await getStatus();
        setRunning(data.running);
        if (data.running && data.run) {
          setRunningKey(`${data.run.target}-${data.run.supplierKey}`);
          setLogs(data.run.logs || []);
          setStatusTone('running');
          setStatusText('Изпълнява се…');
          if (data.run.summary) setSummary(data.run.summary);
        } else {
          setRunningKey(null);
          if (statusTone === 'running') {
            setStatusTone('idle');
            setStatusText('В готовност');
          }
        }
      } catch {
        setStatusTone('error');
        setStatusText('Грешка при връзката');
      }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [statusTone]);

  const lastByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const run of runs) {
      const key = `${run.target}-${run.supplierKey}`;
      if (map.has(key)) continue;
      const dry = run.mode !== 'apply';
      const text = dry
        ? `Последен преглед: ${fmt(run.planned)} за обновяване, ${fmt(run.skipped)} пропуснати.`
        : `Последна синхронизация: ${fmt(run.updated)} обновени, ${fmt(run.skipped)} пропуснати.`;
      map.set(key, text);
    }
    return map;
  }, [runs]);

  async function executeRun(supplierKey: SupplierKey, dryRun: boolean, target: SyncTarget) {
    if (!dryRun) {
      setPendingApply({ supplierKey, target });
      return;
    }
    await performRun(supplierKey, dryRun, target);
  }

  async function performRun(supplierKey: SupplierKey, dryRun: boolean, target: SyncTarget) {
    const supplier = SUPPLIERS.find((s) => s.key === supplierKey)?.name || supplierKey;
    setPendingApply(null);
    setRunning(true);
    setRunningKey(`${target}-${supplierKey}`);
    setSummary(null);
    setLogs([`Стартиране на ${supplier} — ${dryRun ? 'преглед…' : 'синхронизация…'}`]);
    setStatusTone('running');
    setStatusText('Изпълнява се…');
    try {
      const payload = {
        target,
        supplierKey,
        dryRun,
        confirm: target === 'b2bcenter' && !dryRun ? true : undefined,
        allowLargeApply: target === 'b2bcenter' && !dryRun ? true : undefined,
      };
      const data = await runSync(payload);
      if (data.summary) {
        setSummary(data.summary);
        setStatusTone(data.summary.errors > 0 ? 'warning' : 'success');
        setStatusText(data.summary.dryRun ? 'Прегледът е готов' : 'Синхронизацията приключи');
      }
      setLogs(data.logs || []);
      await loadRuns();
    } catch (error) {
      setStatusTone('error');
      setStatusText('Неуспешно');
      setSummary(null);
      setLogs([error instanceof Error ? error.message : 'Заявката не бе изпълнена.']);
    } finally {
      setRunning(false);
      setRunningKey(null);
    }
  }

  return (
    <DashboardLayout
      active="inventory"
      eyebrow="Оперативен панел"
      title="Синхронизация на наличности"
      subtitle="Обновявайте складовите количества от доставчиците. Първо направете преглед, след което приложете промените."
    >
      <ol className="rail" aria-label="Как работи">
        {['Изберете доставчик', 'Направете преглед', 'Проверете резултата', 'Приложете промените'].map((step, idx) => (
          <li className={`rail-step ${idx === 0 ? 'is-current' : ''}`} key={step}>
            <span className="rail-dot">{idx + 1}</span>
            <span className="rail-text">{step}</span>
          </li>
        ))}
      </ol>

      <section>
        <div className="section-heading">
          <div>
            <p className="eyebrow">Онлайн магазин</p>
            <h2>Наличности в Shopify</h2>
          </div>
          <p className="section-note">Обновява складовите количества на продуктите в онлайн магазина по данни от доставчика.</p>
        </div>
        <div className="supplier-grid">
          {SUPPLIERS.map((supplier) => (
            <RunCard
              key={supplier.key}
              target="shopify"
              supplier={supplier}
              running={running && runningKey === `shopify-${supplier.key}`}
              lastText={lastByKey.get(`shopify-${supplier.key}`) || 'Все още няма данни от изпълнение.'}
              onRun={executeRun}
            />
          ))}
        </div>
      </section>

      <section>
        <div className="section-heading">
          <div>
            <p className="eyebrow">Портал за доставчици</p>
            <h2>Синхронизация към B2BCenter</h2>
          </div>
          <p className="section-note">
            Обновява <strong>само количествата</strong> на артикулите в портала B2BCenter. Не променя цени, имена, категории или снимки.
          </p>
        </div>
        <div className="supplier-grid">
          {SUPPLIERS.map((supplier) => (
            <RunCard
              key={supplier.key}
              target="b2bcenter"
              supplier={supplier}
              running={running && runningKey === `b2bcenter-${supplier.key}`}
              lastText={lastByKey.get(`b2bcenter-${supplier.key}`) || 'Все още няма данни от изпълнение.'}
              onRun={executeRun}
            />
          ))}
        </div>
      </section>

      <section className={`panel result-panel is-${statusTone}`}>
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Резултат</p>
            <h2>Текущ резултат</h2>
          </div>
          <StatusBadge tone={statusTone}>{statusText}</StatusBadge>
        </div>
        {running ? <Progress text="Изпълнението се обработва…" /> : null}
        {!summary ? (
          <div className="idle-hint">
            <div className="idle-ico" aria-hidden="true">
              i
            </div>
            <div>
              <p className="idle-title">Все още няма изпълнение</p>
              <p className="idle-body">
                Изберете доставчик и стартирайте <strong>Преглед</strong> — промени няма да бъдат направени, просто ще видите какво предстои.
              </p>
            </div>
          </div>
        ) : (
          <div>
            <p className="result-summary">{buildSentence(summary)}</p>
            <div className="stat-row">
              <div className="stat">
                <span className="stat-label">{summary.dryRun ? 'Готови за обновяване' : 'Обновени'}</span>
                <strong className="stat-value">{fmt(summary.dryRun ? summary.planned : summary.updated)}</strong>
              </div>
              <div className="stat">
                <span className="stat-label">Пропуснати</span>
                <strong className="stat-value">{fmt(summary.skipped)}</strong>
              </div>
              <div className={`stat ${summary.errors > 0 ? (summary.dryRun ? 'is-attention' : 'is-error') : ''}`}>
                <span className="stat-label">{summary.dryRun ? 'Изискват внимание' : 'Грешки'}</span>
                <strong className="stat-value">{fmt(summary.errors)}</strong>
              </div>
            </div>
            <dl className="result-meta">
              <div>
                <dt>Доставчик</dt>
                <dd>{summary.supplier}</dd>
              </div>
              <div>
                <dt>Режим</dt>
                <dd>{summary.dryRun ? 'Преглед' : 'Приложено'}</dd>
              </div>
              <div>
                <dt>Продължителност</dt>
                <dd>{summary.elapsed ?? '—'} сек</dd>
              </div>
              <div>
                <dt>Приключено</dt>
                <dd>{formatDate(summary.finishedAt)}</dd>
              </div>
            </dl>
            <details className="tech-details">
              <summary>Технически детайли (лог)</summary>
              <pre>{logs.length ? logs.join('\n') : 'Няма записан лог.'}</pre>
            </details>
          </div>
        )}
      </section>

      <section className="panel recent-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">История</p>
            <h2>Последни изпълнения</h2>
          </div>
          <Button variant="ghost" size="sm" onClick={() => loadRuns().catch(() => setRuns([]))}>
            Обнови
          </Button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Дестинация · Доставчик</th>
                <th>Режим</th>
                <th className="num">Обновени</th>
                <th className="num">Пропуснати</th>
                <th className="num">Грешки</th>
                <th>Приключено</th>
              </tr>
            </thead>
            <tbody>
              {runs.length ? (
                runs.map((run, idx) => (
                  <tr key={`${run.target}-${run.supplierKey}-${run.finishedAt}-${idx}`}>
                    <td className="cell-supplier">{run.supplier}</td>
                    <td>
                      <span className={`mode-pill ${run.mode === 'apply' ? 'apply' : 'preview'}`}>{run.mode === 'apply' ? 'Приложено' : 'Преглед'}</span>
                    </td>
                    <td className="num">{fmt(run.updated)}</td>
                    <td className="num">{fmt(run.skipped)}</td>
                    <td className="num">{fmt(run.errors)}</td>
                    <td className="cell-date">{formatDate(run.finishedAt)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="empty-cell" colSpan={6}>
                    <strong>Няма записани изпълнения</strong>
                    <span>Стартирайте „Преглед“ за някой доставчик, за да се появи тук.</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <ConfirmModal
        pending={pendingApply}
        onCancel={() => setPendingApply(null)}
        onConfirm={() => {
          if (pendingApply) void performRun(pendingApply.supplierKey, false, pendingApply.target);
        }}
      />
    </DashboardLayout>
  );
}
