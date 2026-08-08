import { FormEvent, useState } from 'react';
import { login } from '../lib/api';
import { BrandLogo } from '../components/layout/BrandLogo';
import { Button } from '../components/ui/Buttons';
import { appPath } from '../app/router';

export function LoginPage() {
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setMessage('');
    try {
      await login(password);
      window.location.href = appPath('/dashboard');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Невалидна парола.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-body">
      <section className="login-shell">
        <div className="login-panel">
          <div className="login-logo">
            <BrandLogo />
          </div>
          <p className="eyebrow">Оперативен панел</p>
          <h1>Вход в системата</h1>
          <p className="login-copy">Вътрешен панел за управление на наличностите от доставчиците към онлайн магазина.</p>
          <form className="login-form" onSubmit={onSubmit}>
            <label htmlFor="password">Парола за достъп</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <Button className="btn-block" variant="primary" type="submit" disabled={submitting}>
              {submitting ? 'Влизане…' : 'Влизане'}
            </Button>
            <div className="form-message" role="alert">
              {message}
            </div>
          </form>
        </div>
        <p className="login-foot">Достъпът е ограничен само за оторизиран персонал на Mebelcenter.</p>
      </section>
    </main>
  );
}
