import { FormEvent, useState } from 'react';
import { login } from '../lib/api';
import { BrandLogo } from '../components/layout/BrandLogo';
import { Button } from '../components/ui/Buttons';
import { appPath } from '../app/router';

const HIGHLIGHTS = [
  'Синхронизация на наличности от доставчиците',
  'Проверка на липсващи продукти по категория',
  'Подготовка на Shopify CSV без автоматични промени',
];

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
    <main className="login-split">
      <aside className="login-brand" aria-hidden="true">
        <div className="login-brand-top">
          <BrandLogo />
        </div>
        <div className="login-brand-mid">
          <p className="login-brand-eyebrow">Оперативен панел</p>
          <h2 className="login-brand-headline">Управлявайте каталога и доставчиците на едно място.</h2>
          <p className="login-brand-copy">
            Вътрешен инструмент за екипа на Mebelcenter — от наличности до липсващи продукти, спокойно и под контрол.
          </p>
          <ul className="login-brand-list">
            {HIGHLIGHTS.map((item) => (
              <li key={item}>
                <span className="login-brand-tick">✓</span>
                {item}
              </li>
            ))}
          </ul>
        </div>
        <div className="login-brand-foot">mebelcenter.bg · Оперативен панел</div>
      </aside>

      <section className="login-formside">
        <div className="login-card">
          <div className="login-card-logo">
            <BrandLogo />
          </div>
          <p className="eyebrow">Вход в системата</p>
          <h1 className="login-card-title">Добре дошли</h1>
          <p className="login-copy">Въведете паролата за достъп, за да продължите към оперативния панел.</p>
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
          <p className="login-foot">Достъпът е ограничен само за оторизиран персонал на Mebelcenter.</p>
        </div>
      </section>
    </main>
  );
}
