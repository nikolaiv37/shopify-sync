import { HomePage } from '../pages/HomePage';
import { InventorySyncPage } from '../pages/InventorySyncPage';
import { LoginPage } from '../pages/LoginPage';
import { MissingProductsPage } from '../pages/MissingProductsPage';
import { PricesPage } from '../pages/PricesPage';

export type RouteName = 'login' | 'home' | 'inventory' | 'missing' | 'prices';

export function getRoute(pathname = window.location.pathname): RouteName {
  const normalized = pathname.startsWith('/app/') ? pathname.slice('/app'.length) : pathname;
  if (normalized === '/' || normalized === '/login') return 'login';
  if (normalized.startsWith('/missing-products')) return 'missing';
  if (normalized.startsWith('/inventory')) return 'inventory';
  if (normalized.startsWith('/prices')) return 'prices';
  return 'home';
}

export function appPath(pathname: string) {
  if (!import.meta.env.DEV) return pathname;
  if (pathname === '/') return '/app/';
  return `/app${pathname}`;
}

export function renderRoute(route: RouteName) {
  if (route === 'login') return <LoginPage />;
  if (route === 'missing') return <MissingProductsPage />;
  if (route === 'inventory') return <InventorySyncPage />;
  if (route === 'prices') return <PricesPage />;
  return <HomePage />;
}
