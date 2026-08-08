import { useEffect, useRef } from 'react';
import type { MissingProductRow } from '../../lib/types';
import { exportStatus, infoWarnings, meaningfulWarnings, reasonText } from '../../lib/missingStatus';

const eur = new Intl.NumberFormat('bg-BG', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf = new Intl.NumberFormat('bg-BG');

function formatPrice(value: string) {
  const num = Number.parseFloat(String(value || '').replace(',', '.'));
  return Number.isFinite(num) ? eur.format(num) : '—';
}

function htmlToPreview(value: string) {
  if (!value) return '';
  if (typeof window === 'undefined') return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const normalized = value
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*p\s*>/gi, '\n')
    .replace(/<\/\s*li\s*>/gi, '\n');
  const doc = new DOMParser().parseFromString(normalized, 'text/html');
  doc.querySelectorAll('script,style,iframe,object,embed').forEach((node) => node.remove());
  return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

function copyText(value: string) {
  if (!navigator.clipboard) return;
  void navigator.clipboard.writeText(value);
}

type Props = {
  row: MissingProductRow | null;
  categoryDisplay?: string;
  categoryOriginal?: string;
  onClose: () => void;
};

export function ProductDrawer({ row, categoryDisplay, categoryOriginal, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!row) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [row, onClose]);

  useEffect(() => {
    if (row) closeRef.current?.focus();
  }, [row]);

  if (!row) return null;

  const status = exportStatus(row);
  const preview = htmlToPreview(row.description);
  const thumbs = row.imageUrls.slice(0, 6);
  const catDisplay = categoryDisplay || row.categoryDisplay || row.category || '—';
  const catOriginal = categoryOriginal || row.category || '';
  const typesAndTags = [row.typePreview, ...row.tagsPreview].filter(Boolean).join(' · ');
  const stockText = row.stock || row.availability || '—';

  const attention = meaningfulWarnings(row);
  const info = infoWarnings(row);
  const errors = row.validationErrors;

  return (
    <div className="drawer-overlay" onMouseDown={onClose}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`Детайли за ${row.title || row.supplierSku}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="drawer-head">
          <div className="drawer-head-text">
            <h3 className="drawer-title">{row.title || '—'}</h3>
            <p className="drawer-sku">{row.supplierSku}</p>
          </div>
          <button ref={closeRef} type="button" className="drawer-close" aria-label="Затвори" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="drawer-body">
          <div className="drawer-media">
            {row.imageUrls[0] ? (
              <a href={row.imageUrls[0]} target="_blank" rel="noreferrer" className="drawer-hero-link" title="Отвори снимка">
                <img className="drawer-hero" src={row.imageUrls[0]} alt={row.title || row.supplierSku} loading="lazy" />
              </a>
            ) : (
              <div className="drawer-hero drawer-hero-empty">Няма снимка</div>
            )}
            {row.imageUrls.length > 1 ? (
              <div className="drawer-thumbs">
                {thumbs.slice(1).map((url) => (
                  <a key={url} href={url} target="_blank" rel="noreferrer" className="drawer-thumb-link" title="Отвори снимка">
                    <img className="drawer-thumb" src={url} alt="" loading="lazy" />
                  </a>
                ))}
              </div>
            ) : null}
            {row.imageUrls.length ? (
              <div className="drawer-media-meta">
                <span>{nf.format(row.imageUrls.length)} снимки</span>
                <button type="button" className="link-btn" onClick={() => copyText(row.imageUrls.join('\n'))}>
                  Копирай URL адресите
                </button>
              </div>
            ) : null}
          </div>

          <section className={`drawer-status is-${status}`}>
            {status === 'ready' ? (
              <p className="drawer-status-head">✓ Готов за експорт</p>
            ) : status === 'notes' ? (
              <>
                <p className="drawer-status-head">! Има забележки</p>
                <p className="drawer-status-sub">Може да се експортира.</p>
              </>
            ) : (
              <p className="drawer-status-head">Не може да се експортира</p>
            )}
            {errors.length || attention.length ? (
              <ul className="drawer-reason-list">
                {errors.map((reason) => (
                  <li key={reason} className="is-error">{reasonText(reason)}</li>
                ))}
                {attention.map((reason) => (
                  <li key={reason} className="is-attention">{reasonText(reason)}</li>
                ))}
              </ul>
            ) : null}
          </section>

          <section className="drawer-section">
            <h4>Описание</h4>
            <p className="drawer-description">{preview || 'Няма описание.'}</p>
          </section>

          <section className="drawer-section">
            <h4>Информация</h4>
            <dl className="drawer-meta">
              <div className="drawer-meta-wide">
                <dt>Категория</dt>
                <dd>
                  {catDisplay}
                  {catOriginal && catOriginal !== catDisplay ? <span className="drawer-meta-muted">{catOriginal}</span> : null}
                </dd>
              </div>
              <div>
                <dt>Доставна цена</dt>
                <dd>{formatPrice(row.supplierPrice)}</dd>
              </div>
              <div>
                <dt>Shopify цена</dt>
                <dd>{formatPrice(row.shopifyPrice)}</dd>
              </div>
              <div>
                <dt>Наличност</dt>
                <dd>{stockText}</dd>
              </div>
              <div>
                <dt>Тегло</dt>
                <dd>{row.weightKg ? `${row.weightKg} kg` : '—'}</dd>
              </div>
              <div className="drawer-meta-wide">
                <dt>Баркод</dt>
                <dd className="drawer-meta-mono">{row.barcode || '—'}</dd>
              </div>
              <div className="drawer-meta-wide">
                <dt>Тип / тагове</dt>
                <dd>{typesAndTags || '—'}</dd>
              </div>
            </dl>
            {info.length ? (
              <p className="drawer-info-note">{info.map(reasonText).join(' · ')}</p>
            ) : null}
          </section>
        </div>
      </aside>
    </div>
  );
}
