import { HomePage } from '../pages/HomePage';
import { InventorySyncPage } from '../pages/InventorySyncPage';
import { LoginPage } from '../pages/LoginPage';
import { MissingProductsPage } from '../pages/MissingProductsPage';
import { PricesPage } from '../pages/PricesPage';
import { SkuMigrationPage } from '../pages/SkuMigrationPage';

export type RouteName = 'login' | 'home' | 'inventory' | 'missing' | 'prices' | 'sku';

export function getRoute(pathname = window.location.pathname): RouteName {
  const normalized = pathname.startsWith('/app/') ? pathname.slice('/app'.length) : pathname;
  if (normalized === '/' || normalized === '/login') return 'login';
  if (normalized.startsWith('/missing-products')) return 'missing';
  if (normalized.startsWith('/inventory')) return 'inventory';
  if (normalized.startsWith('/prices')) return 'prices';
  if (normalized.startsWith('/sku-migration')) return 'sku';
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
  if (route === 'sku') return <SkuMigrationPage />;
  return <HomePage />;
}
