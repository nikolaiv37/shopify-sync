import { useEffect, useMemo, useState } from 'react';
import { LoginPage } from '../pages/LoginPage';
import { getSession } from '../lib/api';
import { appPath, getRoute, renderRoute, type RouteName } from './router';

export function App() {
  const [route, setRoute] = useState<RouteName>(() => getRoute());
  const [sessionReady, setSessionReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    let alive = true;
    getSession()
      .then((session) => {
        if (!alive) return;
        setAuthenticated(session.authenticated);
        setSessionReady(true);
        const current = getRoute();
        if (session.authenticated && current === 'login') {
          window.history.replaceState(null, '', appPath('/dashboard'));
          setRoute('inventory');
        }
        if (!session.authenticated && current !== 'login') {
          window.history.replaceState(null, '', appPath('/'));
          setRoute('login');
        }
      })
      .catch(() => {
        if (!alive) return;
        setAuthenticated(false);
        setSessionReady(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onPop = () => setRoute(getRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    const onNavigate = (event: Event) => {
      const custom = event as CustomEvent<{ href: string }>;
      const href = appPath(custom.detail.href);
      window.history.pushState(null, '', href);
      setRoute(getRoute(href));
    };
    window.addEventListener('app:navigate', onNavigate);
    return () => window.removeEventListener('app:navigate', onNavigate);
  }, []);

  const content = useMemo(() => renderRoute(route), [route]);

  if (!sessionReady) {
    return <div className="screen-loader">Зареждане…</div>;
  }

  if (!authenticated && route !== 'login') {
    return <LoginPage />;
  }

  return content;
}
