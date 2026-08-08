import { InventorySyncPage } from '../pages/InventorySyncPage';
import { LoginPage } from '../pages/LoginPage';
import { MissingProductsPage } from '../pages/MissingProductsPage';

export type RouteName = 'login' | 'inventory' | 'missing';

export function getRoute(pathname = window.location.pathname): RouteName {
  const normalized = pathname.startsWith('/app/') ? pathname.slice('/app'.length) : pathname;
  if (normalized === '/' || normalized === '/login') return 'login';
  if (normalized.startsWith('/missing-products')) return 'missing';
  return 'inventory';
}

export function appPath(pathname: string) {
  if (!import.meta.env.DEV) return pathname;
  if (pathname === '/') return '/app/';
  return `/app${pathname}`;
}

export function renderRoute(route: RouteName) {
  if (route === 'login') return <LoginPage />;
  if (route === 'missing') return <MissingProductsPage />;
  return <InventorySyncPage />;
}
