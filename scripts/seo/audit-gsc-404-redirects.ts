#!/usr/bin/env tsx
/**
 * Audit Google Search Console 404 URLs against the current Shopify catalog.
 *
 * READ-ONLY / DRY-RUN. This script never creates a Shopify URL redirect.
 * It compares old CloudCart 404 paths (/product/, /category/, ...) to the
 * current Shopify products and collections, scores each match by confidence,
 * and writes audit CSVs for a human to review before anything is applied.
 *
 * Usage:
 *   npm run seo:gsc404:audit
 *   npm run seo:gsc404:audit -- --input=data/gsc-404/Table.csv
 *   npm run seo:gsc404:audit -- --route=product --limit=100 --min-confidence=0.9 --verbose
 *
 * Optional old-domain lookup (audit-only — still creates no redirects):
 *   --old-domain=vorno.bg                  scrape the old CloudCart catalog
 *   --old-domain-limit=N                   cap pages scraped (testing)
 *   --old-domain-cache=path/to/cache.json  cache scraped pages (avoid refetch)
 *   For unresolved /product/ paths, fetches https://<old-domain><source_path>,
 *   extracts SKU/JSON-LD signals, and only promotes to redirects-ready.csv when
 *   an extracted code maps to exactly one current Shopify variant SKU.
 *
 * Env (reused from the rest of the repo, see .env.example):
 *   SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET
 *   SHOPIFY_API_VERSION (optional, defaults to 2025-10)
 */

import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Options {
  input: string;
  limit: number | null;
  route: 'product' | 'category' | 'all';
  minConfidence: number;
  verbose: boolean;
  oldDomain: string | null;
  oldDomainLimit: number | null;
  oldDomainCache: string;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    input: 'data/gsc-404/Table.csv',
    limit: null,
    route: 'all',
    minConfidence: 0.9,
    verbose: false,
    oldDomain: null,
    oldDomainLimit: null,
    oldDomainCache: 'data/gsc-404/old-domain-cache.json',
  };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--input=')) opts.input = a.slice('--input='.length);
    else if (a.startsWith('--limit=')) opts.limit = Number(a.slice('--limit='.length)) || null;
    else if (a.startsWith('--route=')) {
      const v = a.slice('--route='.length);
      if (v === 'product' || v === 'category' || v === 'all') opts.route = v;
      else throw new Error(`Invalid --route=${v} (expected product|category|all)`);
    } else if (a.startsWith('--min-confidence=')) {
      opts.minConfidence = Number(a.slice('--min-confidence='.length));
    } else if (a.startsWith('--old-domain=')) {
      // Accept "vorno.bg" or "https://vorno.bg" — store the bare host.
      opts.oldDomain = a.slice('--old-domain='.length).replace(/^https?:\/\//, '').replace(/\/+$/, '');
    } else if (a.startsWith('--old-domain-limit=')) {
      opts.oldDomainLimit = Number(a.slice('--old-domain-limit='.length)) || null;
    } else if (a.startsWith('--old-domain-cache=')) {
      opts.oldDomainCache = a.slice('--old-domain-cache='.length);
    } else if (a === '--verbose') opts.verbose = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!(opts.minConfidence > 0 && opts.minConfidence <= 1)) {
    throw new Error(`--min-confidence must be in (0, 1], got ${opts.minConfidence}`);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Shopify Admin GraphQL client (reuses the repo's client-credentials pattern)
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface ShopifyProduct {
  id: string;
  handle: string;
  title: string;
  vendor: string;
  productType: string;
  tags: string[];
  status: string;
  skus: string[];
}

interface ShopifyCollection {
  id: string;
  handle: string;
  title: string;
}

interface PageInfo { hasNextPage: boolean; endCursor: string | null }

interface ProductsResponse {
  products: {
    pageInfo: PageInfo;
    nodes: Array<{
      id: string; handle: string; title: string; vendor: string;
      productType: string; tags: string[]; status: string;
      variants: { nodes: Array<{ sku: string | null }> };
    }>;
  };
}

interface CollectionsResponse {
  collections: {
    pageInfo: PageInfo;
    nodes: Array<{ id: string; handle: string; title: string }>;
  };
}

function createShopifyClient() {
  const {
    SHOPIFY_STORE_DOMAIN,
    SHOPIFY_CLIENT_ID,
    SHOPIFY_CLIENT_SECRET,
    SHOPIFY_API_VERSION = '2025-10',
  } = process.env;
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
    throw new Error('Missing SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, or SHOPIFY_CLIENT_SECRET in .env');
  }
  const endpoint = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const tokenUrl = `https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`;
  let accessToken: string | null = null;

  async function ensureToken(): Promise<void> {
    if (accessToken) return;
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: SHOPIFY_CLIENT_ID!,
        client_secret: SHOPIFY_CLIENT_SECRET!,
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Access-token request failed: HTTP ${res.status} ${text.slice(0, 400)}`);
    const json = JSON.parse(text);
    if (!json.access_token) throw new Error(`Access-token response missing access_token: ${text.slice(0, 400)}`);
    accessToken = json.access_token as string;
  }

  async function gql<T>(query: string, variables: Record<string, unknown>, label: string): Promise<T> {
    await ensureToken();
    const maxTries = 6;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': accessToken!,
            Accept: 'application/json',
          },
          body: JSON.stringify({ query, variables }),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 600)}`);
        const json = JSON.parse(text);
        if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors).slice(0, 600)}`);
        return json.data as T;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (attempt > maxTries) throw e;
        const throttled = msg.includes('THROTTLED') || msg.includes('rate limit') || msg.includes('HTTP 429');
        const wait = throttled ? 5000 : Math.min(1000 * 2 ** (attempt - 1), 15000);
        console.warn(`[${label}] retry ${attempt}/${maxTries} after ${wait}ms: ${msg.slice(0, 160)}`);
        await sleep(wait);
      }
    }
  }

  async function fetchAllProducts(): Promise<ShopifyProduct[]> {
    const out: ShopifyProduct[] = [];
    let cursor: string | null = null;
    let page = 0;
    for (;;) {
      page++;
      const data: ProductsResponse = await gql<ProductsResponse>(
        `query products($cursor: String) {
          products(first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id handle title vendor productType tags status
              variants(first: 25) { nodes { sku } }
            }
          }
        }`,
        { cursor },
        `products page ${page}`,
      );
      for (const p of data.products.nodes) {
        out.push({
          id: p.id,
          handle: p.handle,
          title: p.title,
          vendor: p.vendor || '',
          productType: p.productType || '',
          tags: p.tags || [],
          status: p.status,
          skus: (p.variants?.nodes || []).map((v) => v.sku || '').filter(Boolean),
        });
      }
      if (page % 10 === 0) console.log(`  ...fetched ${out.length} products`);
      if (!data.products.pageInfo.hasNextPage) break;
      cursor = data.products.pageInfo.endCursor;
      await sleep(150);
    }
    return out;
  }

  async function fetchAllCollections(): Promise<ShopifyCollection[]> {
    const out: ShopifyCollection[] = [];
    let cursor: string | null = null;
    let page = 0;
    for (;;) {
      page++;
      const data: CollectionsResponse = await gql<CollectionsResponse>(
        `query collections($cursor: String) {
          collections(first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { id handle title }
          }
        }`,
        { cursor },
        `collections page ${page}`,
      );
      for (const c of data.collections.nodes) {
        out.push({ id: c.id, handle: c.handle, title: c.title });
      }
      if (!data.collections.pageInfo.hasNextPage) break;
      cursor = data.collections.pageInfo.endCursor;
      await sleep(150);
    }
    return out;
  }

  return { fetchAllProducts, fetchAllCollections, domain: SHOPIFY_STORE_DOMAIN };
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

/** Minimal RFC-4180-ish CSV parser (handles quoted fields and embedded commas). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* ignore */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

function csvCell(value: string | number): string {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(path: string, header: string[], rows: Array<Record<string, string | number>>): void {
  const lines = [header.join(',')];
  for (const r of rows) lines.push(header.map((h) => csvCell(r[h] ?? '')).join(','));
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Normalisation & matching
// ---------------------------------------------------------------------------

const CYRILLIC_MAP: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's',
  т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sht',
  ъ: 'a', ь: 'y', ю: 'yu', я: 'ya',
};

/** Lowercase, transliterate Cyrillic, collapse everything else to single dashes. */
function normalizeSlug(input: string): string {
  let s = input.toLowerCase();
  s = s.replace(/[а-я]/g, (ch) => CYRILLIC_MAP[ch] ?? '');
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s;
}

const DIMENSION_RE = /^\d+(x\d+)+[a-z]*$/; // 110x40x82ec, 100x60
const STOPWORDS = new Set(['cvyat', 'cm', 'hcm', 's', 'i', 'za', 'na', 'v', 'sm', 'copy']);

/** Tokens used for fuzzy title/slug similarity (dimensions and stopwords dropped). */
function contentTokens(slug: string): string[] {
  return slug
    .split('-')
    .filter((t) => t.length > 1 && !DIMENSION_RE.test(t) && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

/** Tokens that look like SKUs / model codes (contain a digit, length >= 4). */
function skuLikeTokens(slug: string): string[] {
  return slug
    .split('-')
    .filter((t) => t.length >= 4 && /\d/.test(t) && !DIMENSION_RE.test(t));
}

/** Sorensen-Dice coefficient over two token sets. */
function dice(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let inter = 0;
  for (const t of new Set(a)) if (setB.has(t)) inter++;
  return (2 * inter) / (new Set(a).size + setB.size);
}

interface MatchResult {
  targetPath: string;
  targetType: 'product' | 'collection';
  confidence: number;
  reason: string;
  shopifyId: string;
  shopifyTitle: string;
  shopifyHandle: string;
}

/**
 * Generic index: normalized-handle -> entity, plus a token inverted index for
 * fuzzy search. Handles are normalized first because Shopify collection handles
 * can be Cyrillic — they must be transliterated to compare with old Latin slugs.
 */
function buildIndex<T extends { handle: string; title: string }>(items: T[]) {
  const byHandle = new Map<string, T>();
  const tokenIndex = new Map<string, number[]>();
  const itemTokens: string[][] = [];
  items.forEach((item, i) => {
    byHandle.set(normalizeSlug(item.handle), item);
    const toks = new Set([
      ...contentTokens(normalizeSlug(item.handle)),
      ...contentTokens(normalizeSlug(item.title)),
    ]);
    itemTokens.push([...toks]);
    for (const t of toks) {
      const arr = tokenIndex.get(t);
      if (arr) arr.push(i);
      else tokenIndex.set(t, [i]);
    }
  });
  return { byHandle, tokenIndex, itemTokens };
}

// ---------------------------------------------------------------------------
// Old-domain (vorno.bg) lookup — optional, audit-only
// ---------------------------------------------------------------------------

/** Product signals scraped from an old-domain product page. */
interface OldDomainSignals {
  url: string;
  httpStatus: number;
  finalUrl: string;        // after redirects
  samePath: boolean;       // final/canonical path still equals the requested path
  title: string;
  h1: string;
  metaTitle: string;
  metaDescription: string;
  jsonLdSku: string;
  jsonLdMpn: string;
  jsonLdName: string;
  jsonLdBrand: string;
  visibleSku: string;      // from "SKU:" / "Код:" / "Модел:" labels
  breadcrumb: string;
  fetchedAt: string;
}

type OldDomainCache = Record<string, OldDomainSignals>;

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ').trim();
}

function firstMatch(html: string, re: RegExp): string {
  const m = re.exec(html);
  return m ? m[1].trim() : '';
}

/** Walk a JSON-LD value (object / array / @graph) collecting Product nodes. */
function collectProducts(node: unknown, out: Record<string, unknown>[]): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) collectProducts(n, out); return; }
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj['@graph'])) collectProducts(obj['@graph'], out);
  const type = obj['@type'];
  const isProduct = type === 'Product'
    || (Array.isArray(type) && (type as unknown[]).includes('Product'));
  if (isProduct) out.push(obj);
}

function collectBreadcrumb(node: unknown): string {
  const found: string[] = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const x of n) walk(x); return; }
    const obj = n as Record<string, unknown>;
    if (Array.isArray(obj['@graph'])) walk(obj['@graph']);
    if (obj['@type'] === 'BreadcrumbList' && Array.isArray(obj.itemListElement)) {
      for (const el of obj.itemListElement as Record<string, unknown>[]) {
        const name = typeof el.name === 'string' ? el.name
          : (el.item && typeof (el.item as Record<string, unknown>).name === 'string'
            ? (el.item as Record<string, unknown>).name as string : '');
        if (name) found.push(name);
      }
    }
  };
  walk(node);
  return found.join(' > ');
}

/** Parse the useful product signals out of an old-domain HTML page. */
function extractSignals(url: string, finalUrl: string, status: number, html: string): OldDomainSignals {
  const sig: OldDomainSignals = {
    url, httpStatus: status, finalUrl,
    samePath: true, title: '', h1: '', metaTitle: '', metaDescription: '',
    jsonLdSku: '', jsonLdMpn: '', jsonLdName: '', jsonLdBrand: '',
    visibleSku: '', breadcrumb: '', fetchedAt: new Date().toISOString(),
  };

  sig.title = stripTags(firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i));
  sig.h1 = stripTags(firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i));
  sig.metaTitle = firstMatch(html, /<meta[^>]+(?:property|name)=["']og:title["'][^>]*content=["']([^"']*)["']/i)
    || firstMatch(html, /<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']og:title["']/i);
  sig.metaDescription = firstMatch(html, /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)
    || firstMatch(html, /<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i);

  const canonical = firstMatch(html, /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']*)["']/i)
    || firstMatch(html, /<meta[^>]+property=["']og:url["'][^>]*content=["']([^"']*)["']/i);
  const requestedPath = (() => { try { return new URL(url).pathname.replace(/\/+$/, ''); } catch { return url; } })();
  for (const candidate of [finalUrl, canonical]) {
    if (!candidate) continue;
    try {
      const p = new URL(candidate, url).pathname.replace(/\/+$/, '');
      if (p && p !== requestedPath) sig.samePath = false;
    } catch { /* ignore unparseable */ }
  }

  // JSON-LD blocks.
  const ldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const products: Record<string, unknown>[] = [];
  let m: RegExpExecArray | null;
  while ((m = ldRe.exec(html)) !== null) {
    let parsed: unknown;
    try { parsed = JSON.parse(m[1].trim()); } catch { continue; }
    collectProducts(parsed, products);
    if (!sig.breadcrumb) sig.breadcrumb = collectBreadcrumb(parsed);
  }
  if (products.length > 0) {
    const p = products[0];
    const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
    sig.jsonLdSku = str(p.sku);
    sig.jsonLdMpn = str(p.mpn);
    sig.jsonLdName = str(p.name);
    const brand = p.brand;
    sig.jsonLdBrand = typeof brand === 'string' ? brand.trim()
      : (brand && typeof (brand as Record<string, unknown>).name === 'string'
        ? (brand as Record<string, unknown>).name as string : '');
  }

  // Visible SKU / product-code label, if the page renders one. Search the
  // tag-stripped text so HTML tag names can't be mistaken for codes, require a
  // digit in the code, and only accept unambiguous product-code labels — bare
  // "Код"/"code" is excluded because CloudCart promo banners say "Използвайте
  // код: WELCOME10", which is a discount code, not a product code.
  const flat = stripTags(html);
  const labelRe = /(?:SKU|Артикул|Код\s+на\s+продукта|Product\s*code)\s*[:#№]?\s*([A-Za-z0-9][A-Za-z0-9.,_\-/]{2,})/i;
  const vm = labelRe.exec(flat);
  if (vm && /\d/.test(vm[1])) sig.visibleSku = vm[1].replace(/[.,]+$/, '');
  return sig;
}

/** Polite sequential fetcher with on-disk cache (concurrency 1). */
function createOldDomainFetcher(host: string, cachePath: string) {
  let cache: OldDomainCache = {};
  if (existsSync(cachePath)) {
    try { cache = JSON.parse(readFileSync(cachePath, 'utf8')) as OldDomainCache; }
    catch { console.warn(`  (could not parse cache ${cachePath} — starting fresh)`); }
  }
  const cacheHitsAtStart = Object.keys(cache).length;
  let dirty = false;

  function persist(): void {
    if (!dirty) return;
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cache, null, 2) + '\n', 'utf8');
    dirty = false;
  }

  async function lookup(sourcePath: string): Promise<OldDomainSignals> {
    const url = `https://${host}${sourcePath}`;
    if (cache[url]) return cache[url];

    let sig: OldDomainSignals;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const res = await fetch(url, {
        redirect: 'follow',
        signal: ctrl.signal,
        headers: { 'User-Agent': 'MebelCenter-SEO-Audit/1.0 (+redirect migration)', Accept: 'text/html' },
      });
      clearTimeout(timer);
      const html = res.status === 200 ? await res.text() : '';
      sig = res.status === 200
        ? extractSignals(url, res.url || url, res.status, html)
        : {
            url, httpStatus: res.status, finalUrl: res.url || url, samePath: false,
            title: '', h1: '', metaTitle: '', metaDescription: '',
            jsonLdSku: '', jsonLdMpn: '', jsonLdName: '', jsonLdBrand: '',
            visibleSku: '', breadcrumb: '', fetchedAt: new Date().toISOString(),
          };
    } catch (e) {
      sig = {
        url, httpStatus: 0, finalUrl: url, samePath: false,
        title: '', h1: '', metaTitle: '', metaDescription: '',
        jsonLdSku: '', jsonLdMpn: '', jsonLdName: '', jsonLdBrand: '',
        visibleSku: '', breadcrumb: `fetch error: ${e instanceof Error ? e.message : String(e)}`,
        fetchedAt: new Date().toISOString(),
      };
    }
    cache[url] = sig;
    dirty = true;
    await sleep(800); // polite throttle between live fetches
    return sig;
  }

  return { lookup, persist, cacheHitsAtStart };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface UrlRecord {
  sourceUrl: string;
  sourcePath: string;
  routeType: string;
  oldSlug: string;
  lastCrawled: string;
}

const ROUTE_TYPES = ['product', 'category', 'vendor', 'selection', 'article', 'other'];

function classify(path: string): { routeType: string; oldSlug: string } {
  const seg = path.replace(/^\/+/, '').split('/');
  const first = seg[0] || '';
  if (ROUTE_TYPES.includes(first) && first !== 'other' && seg.length > 1) {
    return { routeType: first, oldSlug: seg.slice(1).join('/') };
  }
  return { routeType: 'other', oldSlug: seg.slice(1).join('/') || first };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  const startedAt = new Date();
  console.log('=== GSC 404 redirect audit (DRY-RUN — no redirects will be created) ===');
  console.log(`Input:          ${opts.input}`);
  console.log(`Route filter:   ${opts.route}`);
  console.log(`Limit:          ${opts.limit ?? '(none)'}`);
  console.log(`Min confidence: ${opts.minConfidence}`);
  if (opts.oldDomain) {
    console.log(`Old-domain:     ${opts.oldDomain} (limit ${opts.oldDomainLimit ?? 'none'}, cache ${opts.oldDomainCache})`);
  }
  console.log('');

  // --- 1. Parse CSV --------------------------------------------------------
  const raw = readFileSync(opts.input, 'utf8');
  const rows = parseCsv(raw);
  if (rows.length === 0) throw new Error(`No rows in ${opts.input}`);
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const urlIdx = header.indexOf('url');
  const crawledIdx = header.indexOf('last crawled');
  if (urlIdx === -1) throw new Error(`CSV missing "URL" column. Found: ${header.join(', ')}`);

  const seen = new Set<string>();
  const records: UrlRecord[] = [];
  for (const r of rows.slice(1)) {
    const url = (r[urlIdx] || '').trim();
    if (!url) continue;
    let path: string;
    try {
      path = new URL(url).pathname;
    } catch {
      path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    }
    path = path.replace(/\/+$/, '') || '/';
    if (seen.has(path)) continue; // de-dupe (GSC exports many query-string variants)
    seen.add(path);
    const { routeType, oldSlug } = classify(path);
    records.push({
      sourceUrl: url,
      sourcePath: path,
      routeType,
      oldSlug,
      lastCrawled: crawledIdx >= 0 ? (r[crawledIdx] || '').trim() : '',
    });
  }

  const groupCounts: Record<string, number> = {};
  for (const t of ROUTE_TYPES) groupCounts[t] = 0;
  for (const rec of records) groupCounts[rec.routeType]++;

  console.log(`Parsed ${records.length} unique 404 paths (from ${rows.length - 1} CSV rows).`);
  for (const t of ROUTE_TYPES) console.log(`  ${t.padEnd(10)} ${groupCounts[t]}`);
  console.log('');

  // Which records to actually try matching, honouring --route and --limit.
  let toMatch = records.filter((r) => {
    if (opts.route === 'product') return r.routeType === 'product';
    if (opts.route === 'category') return r.routeType === 'category';
    return r.routeType === 'product' || r.routeType === 'category';
  });
  if (opts.limit !== null) toMatch = toMatch.slice(0, opts.limit);
  const productRecords = toMatch.filter((r) => r.routeType === 'product');
  const categoryRecords = toMatch.filter((r) => r.routeType === 'category');

  // --- 2. Fetch Shopify catalog -------------------------------------------
  const client = createShopifyClient();
  let products: ShopifyProduct[] = [];
  let collections: ShopifyCollection[] = [];

  if (productRecords.length > 0) {
    console.log(`Fetching Shopify products from ${client.domain}...`);
    products = await client.fetchAllProducts();
    console.log(`  ${products.length} products fetched.`);
  }
  if (categoryRecords.length > 0) {
    console.log(`Fetching Shopify collections from ${client.domain}...`);
    collections = await client.fetchAllCollections();
    console.log(`  ${collections.length} collections fetched.`);
  }
  console.log('');

  const productIndex = buildIndex(products);
  const collectionIndex = buildIndex(collections);
  const skuIndex = new Map<string, ShopifyProduct>();
  // skuToProducts keeps ALL products per SKU so old-domain matching can require
  // a code to resolve to exactly one Shopify variant before promoting to ready.
  const skuToProducts = new Map<string, ShopifyProduct[]>();
  for (const p of products) {
    for (const sku of p.skus) {
      const key = normalizeSlug(sku);
      if (!key) continue;
      skuIndex.set(key, p);
      const arr = skuToProducts.get(key);
      if (arr) arr.push(p);
      else skuToProducts.set(key, [p]);
    }
  }

  // --- 3. Match products ---------------------------------------------------
  function matchProduct(oldSlug: string): MatchResult | null {
    const norm = normalizeSlug(oldSlug);

    // (a) exact handle match — very high confidence
    const exact = productIndex.byHandle.get(norm);
    if (exact) {
      return {
        targetPath: `/products/${exact.handle}`,
        targetType: 'product',
        confidence: 1,
        reason: 'exact-handle',
        shopifyId: exact.id,
        shopifyTitle: exact.title,
        shopifyHandle: exact.handle,
      };
    }

    // (b) SKU embedded in the old slug matches a Shopify variant SKU
    for (const tok of skuLikeTokens(norm)) {
      const p = skuIndex.get(normalizeSlug(tok));
      if (p) {
        return {
          targetPath: `/products/${p.handle}`,
          targetType: 'product',
          confidence: 0.97,
          reason: `sku-match:${tok}`,
          shopifyId: p.id,
          shopifyTitle: p.title,
          shopifyHandle: p.handle,
        };
      }
    }

    // (c) fuzzy title/slug similarity via the token inverted index
    const queryTokens = contentTokens(norm);
    const candidates = new Set<number>();
    for (const t of queryTokens) {
      for (const idx of productIndex.tokenIndex.get(t) || []) candidates.add(idx);
    }
    let best: { score: number; p: ShopifyProduct } | null = null;
    for (const idx of candidates) {
      const score = dice(queryTokens, productIndex.itemTokens[idx]);
      if (!best || score > best.score) best = { score, p: products[idx] };
    }
    if (!best || best.score < 0.6) return null;

    // Vendor token agreement is only a supporting signal — a small bonus.
    const vendorNorm = normalizeSlug(best.p.vendor);
    const vendorBonus = vendorNorm && norm.includes(vendorNorm) ? 0.03 : 0;
    const confidence = Math.min(0.96, best.score + vendorBonus);
    return {
      targetPath: `/products/${best.p.handle}`,
      targetType: 'product',
      confidence,
      reason: `title-similarity:${best.score.toFixed(2)}${vendorBonus ? `+vendor:${vendorNorm}` : ''}`,
      shopifyId: best.p.id,
      shopifyTitle: best.p.title,
      shopifyHandle: best.p.handle,
    };
  }

  function matchCollection(oldSlug: string): MatchResult | null {
    const norm = normalizeSlug(oldSlug);
    const exact = collectionIndex.byHandle.get(norm);
    if (exact) {
      return {
        targetPath: `/collections/${exact.handle}`,
        targetType: 'collection',
        confidence: 1,
        reason: 'exact-handle',
        shopifyId: exact.id,
        shopifyTitle: exact.title,
        shopifyHandle: exact.handle,
      };
    }
    const queryTokens = contentTokens(norm);
    const candidates = new Set<number>();
    for (const t of queryTokens) {
      for (const idx of collectionIndex.tokenIndex.get(t) || []) candidates.add(idx);
    }
    let best: { score: number; c: ShopifyCollection } | null = null;
    for (const idx of candidates) {
      const score = dice(queryTokens, collectionIndex.itemTokens[idx]);
      if (!best || score > best.score) best = { score, c: collections[idx] };
    }
    if (!best || best.score < 0.6) return null;
    return {
      targetPath: `/collections/${best.c.handle}`,
      targetType: 'collection',
      confidence: Math.min(0.96, best.score),
      reason: `title-similarity:${best.score.toFixed(2)}`,
      shopifyId: best.c.id,
      shopifyTitle: best.c.title,
      shopifyHandle: best.c.handle,
    };
  }

  // --- 3b. Optional old-domain (vorno.bg) lookup pass ----------------------
  const normalMatches = new Map<string, MatchResult | null>();
  for (const rec of toMatch) {
    normalMatches.set(rec.sourcePath,
      rec.routeType === 'product' ? matchProduct(rec.oldSlug) : matchCollection(rec.oldSlug));
  }

  interface OldDomainMatch {
    signals: OldDomainSignals;
    kind: 'sku-ready' | 'title-manual' | 'none';
    reason: string;
    product: ShopifyProduct | null;
    confidence: number;
  }

  // Match a scraped old-domain page to a Shopify product. A SKU/model/code that
  // resolves to EXACTLY ONE Shopify variant is the only path to "ready"; a mere
  // title similarity is capped at manual-review (rule 8).
  function matchViaOldDomain(sig: OldDomainSignals): OldDomainMatch {
    const none: OldDomainMatch = { signals: sig, kind: 'none', reason: '', product: null, confidence: 0 };
    if (sig.httpStatus !== 200) return none;

    const codes: Array<{ code: string; kind: 'jsonld' | 'visible' }> = [
      { code: sig.jsonLdSku, kind: 'jsonld' },
      { code: sig.jsonLdMpn, kind: 'jsonld' },
      { code: sig.visibleSku, kind: 'visible' },
    ];
    for (const { code, kind } of codes) {
      const key = normalizeSlug(code);
      if (!key) continue;
      const hits = skuToProducts.get(key);
      // ready requires: page exists, code resolves to exactly one variant,
      // and the page is still clearly the requested source_path.
      if (hits && hits.length === 1 && sig.samePath) {
        return {
          signals: sig,
          kind: 'sku-ready',
          reason: kind === 'jsonld'
            ? `old_domain_jsonld_sku_to_shopify_variant:${code}`
            : `old_domain_visible_sku_to_shopify_variant:${code}`,
          product: hits[0],
          confidence: 0.99,
        };
      }
    }

    const titleText = sig.jsonLdName || sig.h1 || sig.metaTitle || sig.title;
    const queryTokens = contentTokens(normalizeSlug(titleText));
    const cand = new Set<number>();
    for (const t of queryTokens) {
      for (const idx of productIndex.tokenIndex.get(t) || []) cand.add(idx);
    }
    let best: { score: number; p: ShopifyProduct } | null = null;
    for (const idx of cand) {
      const score = dice(queryTokens, productIndex.itemTokens[idx]);
      if (!best || score > best.score) best = { score, p: products[idx] };
    }
    if (best && best.score >= 0.6) {
      return {
        signals: sig,
        kind: 'title-manual',
        reason: `old_domain_title_similarity_manual:${best.score.toFixed(2)}`,
        product: best.p,
        confidence: best.score,
      };
    }
    return none;
  }

  const oldDomainMatches = new Map<string, OldDomainMatch>();
  const odStats = {
    oldDomainLookupsAttempted: 0,
    oldDomainPagesFound: 0,
    oldDomainSkuExtracted: 0,
    oldDomainReadyRedirects: 0,
    oldDomainManualReview: 0,
  };
  const oldDomainExamples: string[] = [];

  if (opts.oldDomain) {
    // Only look up product paths the normal matcher could not confidently resolve.
    const candidates = toMatch.filter((r) => {
      if (r.routeType !== 'product') return false;
      const m = normalMatches.get(r.sourcePath);
      return !m || Number(m.confidence.toFixed(4)) < opts.minConfidence;
    });
    const slice = opts.oldDomainLimit !== null ? candidates.slice(0, opts.oldDomainLimit) : candidates;
    console.log(`Old-domain lookup: https://${opts.oldDomain} — scraping ${slice.length} product page(s)`
      + ` of ${candidates.length} unresolved (limit ${opts.oldDomainLimit ?? 'none'}).`);
    const fetcher = createOldDomainFetcher(opts.oldDomain, opts.oldDomainCache);
    if (fetcher.cacheHitsAtStart > 0) {
      console.log(`  cache: ${fetcher.cacheHitsAtStart} page(s) already cached in ${opts.oldDomainCache}`);
    }

    for (let i = 0; i < slice.length; i++) {
      const rec = slice[i];
      odStats.oldDomainLookupsAttempted++;
      const sig = await fetcher.lookup(rec.sourcePath);
      if (sig.httpStatus === 200) odStats.oldDomainPagesFound++;
      if (sig.jsonLdSku || sig.jsonLdMpn || sig.visibleSku) odStats.oldDomainSkuExtracted++;
      const m = matchViaOldDomain(sig);
      oldDomainMatches.set(rec.sourcePath, m);
      if (m.kind === 'sku-ready') odStats.oldDomainReadyRedirects++;
      if (m.kind === 'title-manual') odStats.oldDomainManualReview++;
      if (opts.verbose && oldDomainExamples.length < 12 && sig.httpStatus === 200) {
        oldDomainExamples.push(
          `  [HTTP ${sig.httpStatus}] ${rec.sourcePath}\n`
          + `      jsonld: sku="${sig.jsonLdSku}" mpn="${sig.jsonLdMpn}" name="${(sig.jsonLdName).slice(0, 70)}"\n`
          + `      visibleSku="${sig.visibleSku}" brand="${sig.jsonLdBrand}" samePath=${sig.samePath}\n`
          + `      breadcrumb="${sig.breadcrumb.slice(0, 80)}"\n`
          + `      => ${m.kind}${m.product ? ` (${m.reason}) -> /products/${m.product.handle}` : ''}`,
        );
      }
      if ((i + 1) % 10 === 0) {
        fetcher.persist();
        console.log(`  ...looked up ${i + 1}/${slice.length}`);
      }
    }
    fetcher.persist();
    console.log(`  old-domain results: ${odStats.oldDomainPagesFound}/${odStats.oldDomainLookupsAttempted} pages found,`
      + ` ${odStats.oldDomainSkuExtracted} with a SKU, ${odStats.oldDomainReadyRedirects} ready,`
      + ` ${odStats.oldDomainManualReview} manual.`);
    console.log('');
  }

  // --- 4. Classify every record into ready / manual-review / unmatched -----
  const ready: Array<Record<string, string | number>> = [];
  const manual: Array<Record<string, string | number>> = [];
  const unmatched: Array<Record<string, string | number>> = [];
  const verboseExamples: string[] = [];

  for (const rec of toMatch) {
    // An old-domain SKU/title result takes precedence for product paths.
    const od = oldDomainMatches.get(rec.sourcePath);
    if (od && od.kind === 'sku-ready' && od.product) {
      ready.push({
        source_url: rec.sourceUrl,
        source_path: rec.sourcePath,
        target_path: `/products/${od.product.handle}`,
        target_type: 'product',
        match_confidence: Number(od.confidence.toFixed(4)),
        match_reason: od.reason,
        shopify_id: od.product.id,
        shopify_title: od.product.title,
        shopify_handle: od.product.handle,
        last_crawled: rec.lastCrawled,
      });
      if (verboseExamples.length < 20) {
        verboseExamples.push(`  READY  ${rec.sourcePath}  ->  /products/${od.product.handle}  (0.99, ${od.reason})`);
      }
      continue;
    }
    if (od && od.kind === 'title-manual' && od.product) {
      manual.push({
        source_url: rec.sourceUrl,
        source_path: rec.sourcePath,
        suggested_target_path: `/products/${od.product.handle}`,
        target_type: 'product',
        match_confidence: Number(od.confidence.toFixed(4)),
        match_reason: od.reason,
        shopify_id: od.product.id,
        shopify_title: od.product.title,
        shopify_handle: od.product.handle,
        last_crawled: rec.lastCrawled,
      });
      continue;
    }

    const match = normalMatches.get(rec.sourcePath) ?? null;

    if (!match) {
      unmatched.push({
        source_url: rec.sourceUrl,
        source_path: rec.sourcePath,
        route_type: rec.routeType,
        old_slug: rec.oldSlug,
        last_crawled: rec.lastCrawled,
        reason: `no ${rec.routeType === 'product' ? 'product' : 'collection'} above 0.60 similarity`,
      });
      continue;
    }

    const conf = Number(match.confidence.toFixed(4));
    if (conf >= opts.minConfidence) {
      ready.push({
        source_url: rec.sourceUrl,
        source_path: rec.sourcePath,
        target_path: match.targetPath,
        target_type: match.targetType,
        match_confidence: conf,
        match_reason: match.reason,
        shopify_id: match.shopifyId,
        shopify_title: match.shopifyTitle,
        shopify_handle: match.shopifyHandle,
        last_crawled: rec.lastCrawled,
      });
      if (verboseExamples.length < 20) {
        verboseExamples.push(`  READY  ${rec.sourcePath}  ->  ${match.targetPath}  (${conf}, ${match.reason})`);
      }
    } else if (conf >= 0.6) {
      manual.push({
        source_url: rec.sourceUrl,
        source_path: rec.sourcePath,
        suggested_target_path: match.targetPath,
        target_type: match.targetType,
        match_confidence: conf,
        match_reason: match.reason,
        shopify_id: match.shopifyId,
        shopify_title: match.shopifyTitle,
        shopify_handle: match.shopifyHandle,
        last_crawled: rec.lastCrawled,
      });
    } else {
      unmatched.push({
        source_url: rec.sourceUrl,
        source_path: rec.sourcePath,
        route_type: rec.routeType,
        old_slug: rec.oldSlug,
        last_crawled: rec.lastCrawled,
        reason: `best match confidence ${conf} below 0.60`,
      });
    }
  }

  // Records skipped by --route/--limit are reported as unmatched-not-evaluated.
  const evaluated = new Set(toMatch.map((r) => r.sourcePath));
  for (const rec of records) {
    if (evaluated.has(rec.sourcePath)) continue;
    unmatched.push({
      source_url: rec.sourceUrl,
      source_path: rec.sourcePath,
      route_type: rec.routeType,
      old_slug: rec.oldSlug,
      last_crawled: rec.lastCrawled,
      reason: rec.routeType === 'product' || rec.routeType === 'category'
        ? 'not evaluated (excluded by --route/--limit)'
        : `route "${rec.routeType}" not auto-matched — needs manual mapping`,
    });
  }

  // --- 5. Write outputs ----------------------------------------------------
  const ts = startedAt.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const outDir = join('logs', 'gsc-404-redirect-audit', ts);
  mkdirSync(outDir, { recursive: true });

  writeCsv(join(outDir, 'redirects-ready.csv'),
    ['source_url', 'source_path', 'target_path', 'target_type', 'match_confidence',
      'match_reason', 'shopify_id', 'shopify_title', 'shopify_handle', 'last_crawled'],
    ready);

  writeCsv(join(outDir, 'manual-review.csv'),
    ['source_url', 'source_path', 'suggested_target_path', 'target_type', 'match_confidence',
      'match_reason', 'shopify_id', 'shopify_title', 'shopify_handle', 'last_crawled'],
    manual);

  writeCsv(join(outDir, 'unmatched.csv'),
    ['source_url', 'source_path', 'route_type', 'old_slug', 'last_crawled', 'reason'],
    unmatched);

  writeCsv(join(outDir, 'grouped-counts.csv'),
    ['route_type', 'count'],
    ROUTE_TYPES.map((t) => ({ route_type: t, count: groupCounts[t] })));

  const summary = {
    generatedAt: startedAt.toISOString(),
    dryRun: true,
    input: opts.input,
    shopDomain: client.domain,
    options: opts,
    totals: {
      csvRows: rows.length - 1,
      uniquePaths: records.length,
      groupedCounts: groupCounts,
      evaluated: toMatch.length,
      productUrls: groupCounts.product,
      categoryUrls: groupCounts.category,
      readyRedirects: ready.length,
      manualReview: manual.length,
      unmatched: unmatched.length,
    },
    oldDomain: opts.oldDomain
      ? {
          host: opts.oldDomain,
          cache: opts.oldDomainCache,
          oldDomainLookupsAttempted: odStats.oldDomainLookupsAttempted,
          oldDomainPagesFound: odStats.oldDomainPagesFound,
          oldDomainSkuExtracted: odStats.oldDomainSkuExtracted,
          oldDomainReadyRedirects: odStats.oldDomainReadyRedirects,
          oldDomainManualReview: odStats.oldDomainManualReview,
        }
      : null,
    catalog: { products: products.length, collections: collections.length },
    outputDir: outDir,
  };
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');

  // --- 6. Console summary --------------------------------------------------
  if (opts.verbose && oldDomainExamples.length > 0) {
    console.log('Example old-domain pages scraped:');
    for (const line of oldDomainExamples) console.log(line);
    console.log('');
  }
  if (opts.verbose && verboseExamples.length > 0) {
    console.log('Example matches:');
    for (const line of verboseExamples) console.log(line);
    console.log('');
  }
  console.log('=== Audit summary ===');
  console.log(`Total 404 URLs (unique):  ${records.length}`);
  console.log(`Product URLs:             ${groupCounts.product}`);
  console.log(`Category URLs:            ${groupCounts.category}`);
  console.log(`Evaluated this run:       ${toMatch.length}`);
  console.log(`Ready redirects:          ${ready.length}`);
  console.log(`Manual review:            ${manual.length}`);
  console.log(`Unmatched:                ${unmatched.length}`);
  if (opts.oldDomain) {
    console.log('');
    console.log(`Old-domain (${opts.oldDomain}) lookup:`);
    console.log(`  oldDomainLookupsAttempted: ${odStats.oldDomainLookupsAttempted}`);
    console.log(`  oldDomainPagesFound:       ${odStats.oldDomainPagesFound}`);
    console.log(`  oldDomainSkuExtracted:     ${odStats.oldDomainSkuExtracted}`);
    console.log(`  oldDomainReadyRedirects:   ${odStats.oldDomainReadyRedirects}`);
    console.log(`  oldDomainManualReview:     ${odStats.oldDomainManualReview}`);
  }
  console.log('');
  console.log(`Output written to: ${outDir}/`);
  console.log('  summary.json  redirects-ready.csv  manual-review.csv  unmatched.csv  grouped-counts.csv');
  console.log('');
  console.log('DRY-RUN complete. No Shopify redirects were created. Review the CSVs before applying.');
}

main().catch((e: unknown) => {
  console.error('FATAL:', e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
