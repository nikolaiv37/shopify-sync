import type { ReactNode } from 'react';
import { logout } from '../../lib/api';
import { appPath } from '../../app/router';
import { BrandLogo } from './BrandLogo';
import { HomeIcon, InventoryIcon, MissingIcon, PricesIcon } from './NavIcons';

type Props = {
  active: 'home' | 'inventory' | 'missing' | 'prices';
  eyebrow: string;
  title: string;
  subtitle: string;
  wide?: boolean;
  children: ReactNode;
};

function navigate(href: string) {
  window.dispatchEvent(new CustomEvent('app:navigate', { detail: { href } }));
}

export function DashboardLayout({ active, eyebrow, title, subtitle, wide = false, children }: Props) {
  async function onLogout() {
    await logout().catch(() => undefined);
    window.location.href = appPath('/');
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <BrandLogo />
        </div>
        <nav className="nav" aria-label="Навигация">
          <button
            className={`nav-item nav-button ${active === 'home' ? 'active' : ''}`}
            type="button"
            aria-current={active === 'home' ? 'page' : undefined}
            onClick={() => navigate('/dashboard')}
          >
            <HomeIcon className="nav-ico" />Табло
          </button>
          <button
            className={`nav-item nav-button ${active === 'inventory' ? 'active' : ''}`}
            type="button"
            aria-current={active === 'inventory' ? 'page' : undefined}
            onClick={() => navigate('/inventory')}
          >
            <InventoryIcon className="nav-ico" />Наличности
          </button>
          <button
            className={`nav-item nav-button ${active === 'missing' ? 'active' : ''}`}
            type="button"
            aria-current={active === 'missing' ? 'page' : undefined}
            onClick={() => navigate('/missing-products')}
          >
            <MissingIcon className="nav-ico" />Липсващи продукти
          </button>
          <button
            className={`nav-item nav-button ${active === 'prices' ? 'active' : ''}`}
            type="button"
            aria-current={active === 'prices' ? 'page' : undefined}
            onClick={() => navigate('/prices')}
          >
            <PricesIcon className="nav-ico" />Цени
          </button>
        </nav>
        <div className="sidebar-foot">
          <span className="dot-live" aria-hidden="true" />
          Системата е активна
        </div>
      </aside>

      <main className={`main${wide ? ' main-wide' : ''}`}>
        <header className="topbar">
          <div className="topbar-text">
            <p className="eyebrow">{eyebrow}</p>
            <h1>{title}</h1>
            <p className="subtitle">{subtitle}</p>
          </div>
          <button className="btn btn-ghost logout-btn" type="button" onClick={onLogout}>
            <svg className="logout-ico" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            Изход
          </button>
        </header>
        {children}
      </main>
    </div>
  );
}
