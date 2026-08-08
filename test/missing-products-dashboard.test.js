import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertSupportedSupplier,
  buildExportFilename,
  exportMissingProductsCsv,
  MAX_EXPORT_IDENTIFIERS,
  makeCategoryId,
  normalizeCategories,
  resolveCategorySelection,
  scanMissingProducts,
} from '../lib/missing-products/dashboard.js';

function fakeClient(existingSkus = []) {
  return () => ({
    async gqlWithRetry() {
      return {
        productVariants: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: existingSkus.map((sku, idx) => ({
            id: `gid://shopify/ProductVariant/${idx + 1}`,
            sku,
            barcode: '',
            price: '10.00',
            product: { id: `gid://shopify/Product/${idx + 1}`, vendor: 'Mebelcenter', title: sku, status: 'ACTIVE' },
          })),
        },
      };
    },
  });
}

const megapapCategory = 'Indoor furniture > Wardrobes';

function megapapFeed(products) {
  return {
    categories: normalizeCategories([{ text: megapapCategory, count: products.length, level: '' }]),
    products,
  };
}

test('dashboard supplier validation rejects unsupported suppliers', () => {
  assert.doesNotThrow(() => assertSupportedSupplier('b2bmarkt'));
  assert.throws(() => assertSupportedSupplier('unknown'), /Unsupported supplier/);
});

test('dashboard category normalization returns stable selectable rows', () => {
  const categories = normalizeCategories([
    { text: 'B', count: 2, level: '1' },
    { text: 'A', count: 5, level: '' },
  ]);

  assert.deepEqual(categories.map((category) => category.name), ['A', 'B']);
  assert.equal(categories[0].productCount, 5);
  assert.equal(categories[0].id, makeCategoryId('A'));
});

test('dashboard category selection rejects unknown ids', () => {
  const categories = normalizeCategories([{ text: 'Cat', count: 1, level: '' }]);
  assert.equal(resolveCategorySelection(categories, makeCategoryId('Cat')).name, 'Cat');
  assert.throws(() => resolveCategorySelection(categories, makeCategoryId('Other')), /not available/);
});

test('dashboard scan normalizes read-only result with injected Shopify client', async () => {
  const result = await scanMissingProducts({
    supplierKey: 'megapap',
    categoryId: makeCategoryId(megapapCategory),
    parsedFeed: megapapFeed([
        {
          model: 'EXISTS',
          sku: 'EXISTS-A',
          ean: '111',
          name: 'Existing wardrobe',
          category: 'Indoor furniture > Wardrobes',
          wholesale_price_without_vat: '100',
          quantity: '2',
          main_image: 'https://example.com/exists.jpg',
        },
        {
          model: 'MISSING',
          sku: 'MISSING-A',
          ean: '222',
          name: 'Missing wardrobe',
          category: 'Indoor furniture > Wardrobes',
          wholesale_price_without_vat: '100',
          quantity: '3',
          main_image: 'https://example.com/missing.jpg',
        },
    ]),
    categoryMapOverride: {
      [megapapCategory]: { type: 'Гардероби', tags: ['Гардероби'] },
    },
    createClient: fakeClient(['EXISTS']),
  });

  assert.equal(result.supplier, 'megapap');
  assert.equal(result.category.name, megapapCategory);
  assert.equal(result.totals.supplierProducts, 2);
  assert.equal(result.totals.alreadyInShopify, 1);
  assert.equal(result.totals.missing, 1);
  assert.equal(result.missingProducts[0].supplierSku, 'MISSING');
  assert.equal(result.missingProducts[0].validationState, 'valid');
  assert.equal(typeof result.durationMs, 'number');
  assert.ok('missingProducts' in result);
  assert.ok('shopifyVariants' in result.totals);
});

test('dashboard export validates request input', async () => {
  await assert.rejects(() => exportMissingProductsCsv({ supplierKey: 'unknown', categoryId: 'x', productIds: ['x'] }), /Unsupported supplier/);
  await assert.rejects(() => exportMissingProductsCsv({ supplierKey: 'megapap', categoryId: '', productIds: ['x'] }), /categoryId is required/);
  await assert.rejects(() => exportMissingProductsCsv({ supplierKey: 'megapap', categoryId: makeCategoryId(megapapCategory), productIds: [] }), /Select at least one/);
});

test('dashboard export default identifier cap supports large category selections', () => {
  assert.equal(MAX_EXPORT_IDENTIFIERS >= 1000, true);
});

test('dashboard export includes warning-only products and excludes blocked products', async () => {
  const result = await exportMissingProductsCsv({
    supplierKey: 'megapap',
    categoryId: makeCategoryId(megapapCategory),
    productIds: ['megapap:GOOD', 'megapap:WARN', 'megapap:BLOCKED', 'megapap:GOOD'],
    parsedFeed: megapapFeed([
      {
        model: 'GOOD',
        sku: 'GOOD-A',
        ean: '111',
        name: 'Good wardrobe',
        description: 'Plain English copy',
        category: megapapCategory,
        wholesale_price_without_vat: '100',
        quantity: '2',
        main_image: 'https://example.com/good.jpg',
      },
      {
        model: 'WARN',
        sku: 'WARN-A',
        ean: '222',
        name: 'Warning wardrobe',
        description: 'English copy without an image',
        category: megapapCategory,
        wholesale_price_without_vat: '120',
        quantity: '0',
      },
      {
        model: 'BLOCKED',
        sku: 'BLOCKED-A',
        ean: '333',
        name: 'Blocked wardrobe',
        description: 'Missing price blocks export',
        category: megapapCategory,
        wholesale_price_without_vat: '',
        quantity: '5',
        main_image: 'https://example.com/blocked.jpg',
      },
    ]),
    categoryMapOverride: { [megapapCategory]: { type: 'Гардероби', tags: ['Гардероби'] } },
    createClient: fakeClient(),
    date: new Date('2026-08-01T10:00:00Z'),
  });

  assert.equal(result.filename, 'missing-products-megapap-indoor-furniture-wardrobes-2026-08-01.csv');
  assert.equal(result.summary.exported, 2);
  assert.equal(result.summary.warningProducts, 1);
  assert.equal(result.summary.zeroStock, 1);
  assert.equal(result.summary.excluded, 1);
  assert.match(result.csv, /^Handle,Title,Body \(HTML\),Vendor,/);
  assert.match(result.csv, /Good wardrobe/);
  assert.match(result.csv, /Warning wardrobe/);
  assert.doesNotMatch(result.csv, /Blocked wardrobe/);
  assert.match(result.csv, /draft/);
  assert.match(result.csv, /FALSE/);
});

test('dashboard export excludes products already in Shopify', async () => {
  await assert.rejects(
    () => exportMissingProductsCsv({
      supplierKey: 'megapap',
      categoryId: makeCategoryId(megapapCategory),
      productIds: ['megapap:EXISTS'],
      parsedFeed: megapapFeed([
        {
          model: 'EXISTS',
          sku: 'EXISTS-A',
          ean: '111',
          name: 'Existing wardrobe',
          category: megapapCategory,
          wholesale_price_without_vat: '100',
          quantity: '2',
          main_image: 'https://example.com/exists.jpg',
        },
      ]),
      categoryMapOverride: { [megapapCategory]: { type: 'Гардероби', tags: ['Гардероби'] } },
      createClient: fakeClient(['EXISTS']),
    }),
    /No selected products are exportable/,
  );
});

test('dashboard export preserves CSV escaping and Megapap English copy', async () => {
  const result = await exportMissingProductsCsv({
    supplierKey: 'megapap',
    categoryId: makeCategoryId(megapapCategory),
    productIds: ['megapap:CSV1'],
    parsedFeed: megapapFeed([
      {
        model: 'CSV1',
        sku: 'CSV1-A',
        ean: '111',
        name: 'Wardrobe, "large"',
        description: 'Line one\nLine two, still English',
        category: megapapCategory,
        wholesale_price_without_vat: '100',
        quantity: '2',
        main_image: 'https://example.com/csv.jpg',
      },
    ]),
    categoryMapOverride: { [megapapCategory]: { type: 'Гардероби', tags: ['Гардероби'] } },
    createClient: fakeClient(),
  });

  assert.match(result.csv, /"Wardrobe, ""large"""/);
  assert.match(result.csv, /"Line one\nLine two, still English"/);
});

test('dashboard export preserves B2BMarkt Greek copy without translation', async () => {
  const category = 'Παιδικό δωμάτιο';
  const result = await exportMissingProductsCsv({
    supplierKey: 'b2bmarkt',
    categoryId: makeCategoryId(category),
    productIds: ['b2bmarkt:HM100'],
    parsedFeed: {
      categories: normalizeCategories([{ text: category, count: 1, level: '2' }]),
      products: [
        {
          ProductCode: 'HM100',
          IdentificationCode: 'ALT100',
          Name: 'Κρεβάτι λευκό',
          ExtendedDescription: '<p>Παιδικό κρεβάτι</p>',
          ZoneFourUnitPrice: '100',
          Stock: '3',
          BarcodeMain: '5200000',
          Weight: '12.5',
          Categories: { Category: { $attrs: { level: '2' }, '#text': category } },
          ImagesLocation: { image: 'https://example.com/b2b.jpg' },
        },
      ],
    },
    categoryMapOverride: { [category]: { type: 'Детска стая', tags: ['Детска стая'] } },
    createClient: fakeClient(),
  });

  assert.match(result.csv, /Κρεβάτι λευκό/);
  assert.match(result.csv, /Παιδικό κρεβάτι/);
  assert.doesNotMatch(result.csv, /Bed/);
  assert.match(result.csv, /Europe/);
});

test('dashboard export excludes duplicate supplier SKUs', async () => {
  await assert.rejects(
    () => exportMissingProductsCsv({
      supplierKey: 'megapap',
      categoryId: makeCategoryId(megapapCategory),
      productIds: ['megapap:DUP'],
      parsedFeed: megapapFeed([
        { model: 'DUP', name: 'Duplicate one', category: megapapCategory, wholesale_price_without_vat: '100', main_image: 'https://example.com/1.jpg' },
        { model: 'DUP', name: 'Duplicate two', category: megapapCategory, wholesale_price_without_vat: '100', main_image: 'https://example.com/2.jpg' },
      ]),
      categoryMapOverride: { [megapapCategory]: { type: 'Гардероби', tags: ['Гардероби'] } },
      createClient: fakeClient(),
    }),
    /No selected products are exportable/,
  );
});

test('dashboard export filename is deterministic and ascii-safe', () => {
  assert.equal(
    buildExportFilename({ supplierKey: 'b2bmarkt', categoryName: 'Παιδικό δωμάτιο', date: new Date('2026-08-01T00:00:00Z') }),
    'missing-products-b2bmarkt-2026-08-01.csv',
  );
});
