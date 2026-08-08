import type { ReactNode } from 'react';
import { logout } from '../../lib/api';
import { appPath } from '../../app/router';
import { BrandLogo } from './BrandLogo';

type Props = {
  active: 'inventory' | 'missing';
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
            className={`nav-item nav-button ${active === 'inventory' ? 'active' : ''}`}
            type="button"
            onClick={() => navigate('/dashboard')}
          >
            <span className="nav-ico">□</span>Наличности
          </button>
          <button
            className={`nav-item nav-button ${active === 'missing' ? 'active' : ''}`}
            type="button"
            onClick={() => navigate('/missing-products')}
          >
            <span className="nav-ico">+</span>Липсващи продукти
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
