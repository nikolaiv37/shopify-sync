import type { ReactNode } from 'react';
import { logout } from '../../lib/api';
import { appPath } from '../../app/router';
import { BrandLogo } from './BrandLogo';

type Props = {
  active: 'inventory' | 'missing';
  eyebrow: string;
  title: string;
  subtitle: string;
  children: ReactNode;
};

function navigate(href: string) {
  window.dispatchEvent(new CustomEvent('app:navigate', { detail: { href } }));
}

export function DashboardLayout({ active, eyebrow, title, subtitle, children }: Props) {
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
          <p className="nav-label">Работа</p>
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
          <p className="nav-label nav-label-soft">Предстоящи</p>
          <span className="nav-item disabled">Цени</span>
          <span className="nav-item disabled">Преводи</span>
          <span className="nav-item disabled">Почистване</span>
          <span className="nav-item disabled">Логове</span>
          <span className="nav-item disabled">Настройки</span>
        </nav>
        <div className="sidebar-foot">
          <span className="dot-live" aria-hidden="true" />
          Системата е активна
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-text">
            <p className="eyebrow">{eyebrow}</p>
            <h1>{title}</h1>
            <p className="subtitle">{subtitle}</p>
          </div>
          <button className="btn btn-ghost" type="button" onClick={onLogout}>
            Изход
          </button>
        </header>
        {children}
      </main>
    </div>
  );
}
