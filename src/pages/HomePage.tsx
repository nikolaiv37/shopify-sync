import { useEffect, useState } from 'react';
import { DashboardLayout } from '../components/layout/DashboardLayout';
import { InventoryIcon, MissingIcon, PricesIcon } from '../components/layout/NavIcons';
import { getMissingSuppliers } from '../lib/api';
import type { MissingSupplier } from '../lib/types';

function navigate(href: string) {
  window.dispatchEvent(new CustomEvent('app:navigate', { detail: { href } }));
}

export function HomePage() {
  const [suppliers, setSuppliers] = useState<MissingSupplier[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    getMissingSuppliers()
      .then((data) => {
        if (!alive) return;
        setSuppliers(data.suppliers.filter((item) => item.available));
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const supplierCount = loaded ? suppliers.length : '—';

  return (
    <DashboardLayout
      active="home"
      eyebrow="Операции"
      title="Табло"
      subtitle="Оперативен център за управление на каталога и доставчиците на Mebelcenter към онлайн магазина."
    >
      <section className="home-stats">
        <div className="home-stat">
          <span className="home-stat-label">Активни доставчици</span>
          <strong className="home-stat-value">{supplierCount}</strong>
          <span className="home-stat-hint">
            {suppliers.length ? suppliers.map((s) => s.name).join(' · ') : 'Зареждане…'}
          </span>
        </div>
        <div className="home-stat">
          <span className="home-stat-label">Оперативни модула</span>
          <strong className="home-stat-value">3</strong>
          <span className="home-stat-hint">Наличности · Липсващи продукти · Цени</span>
        </div>
        <div className="home-stat">
          <span className="home-stat-label">Състояние на системата</span>
          <strong className="home-stat-value home-stat-ok">
            <span className="dot-live" aria-hidden="true" />
            Активна
          </strong>
          <span className="home-stat-hint">Готова за работа</span>
        </div>
      </section>

      <section className="home-modules">
        <h2 className="home-section-title">Модули</h2>
        <div className="home-module-grid">
          <button type="button" className="home-module" onClick={() => navigate('/inventory')}>
            <span className="home-module-ico">
              <InventoryIcon />
            </span>
            <span className="home-module-body">
              <span className="home-module-name">Наличности</span>
              <span className="home-module-desc">
                Обновявайте складовите количества от доставчиците към Shopify. Първо преглед, след това прилагане на промените.
              </span>
              <span className="home-module-cta">Отвори →</span>
            </span>
          </button>

          <button type="button" className="home-module" onClick={() => navigate('/missing-products')}>
            <span className="home-module-ico">
              <MissingIcon />
            </span>
            <span className="home-module-body">
              <span className="home-module-name">Липсващи продукти</span>
              <span className="home-module-desc">
                Проверете кои продукти от доставчиците липсват в Shopify по категория и подгответе CSV за импорт. Само преглед — без промени.
              </span>
              <span className="home-module-cta">Отвори →</span>
            </span>
          </button>

          <button type="button" className="home-module" onClick={() => navigate('/prices')}>
            <span className="home-module-ico">
              <PricesIcon />
            </span>
            <span className="home-module-body">
              <span className="home-module-name">Цени</span>
              <span className="home-module-desc">
                Преглед и безопасна актуализация на Shopify цените спрямо актуалните доставни цени от feed-а. Първо преглед, след това потвърждение.
              </span>
              <span className="home-module-cta">Отвори →</span>
            </span>
          </button>
        </div>
      </section>

      <section className="home-suppliers">
        <h2 className="home-section-title">Поддържани доставчици</h2>
        <div className="home-supplier-row">
          {suppliers.length ? (
            suppliers.map((s) => (
              <div className="home-supplier-chip" key={s.key}>
                <span className="home-supplier-name">{s.name}</span>
                <span className="home-supplier-meta">
                  {s.vendor}
                  {s.priceMultiplier ? ` · × ${s.priceMultiplier}` : ''}
                </span>
              </div>
            ))
          ) : (
            <p className="home-empty">{loaded ? 'Няма достъпни доставчици в текущата среда.' : 'Зареждане…'}</p>
          )}
        </div>
      </section>
    </DashboardLayout>
  );
}
