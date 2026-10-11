import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRecords, parseQuantity, fingerprint, loadFeeds } from '../lib/inventory/feeds.js';
import { discoverIdentities, classifyInventory, decodeIdentity } from '../lib/inventory/identity.js';
import { parsePortalFeed } from '../lib/b2bcenterSync.js';

const locationId = 'gid://shopify/Location/1';
const rec = (supplier = 'megapap', id = '001', extra = {}) => ({ rowId: `${supplier}:${id}`, supplier, supplierProductId: id, itemCode: 'NEW', platformId: '', barcode: '5200000000001', title: 'Chair', quantity: 7, quantityError: null, ...extra });
const feeds = (rows) => Object.fromEntries(['megapap', 'b2bmarkt', 'symetron'].map(s => { const records = rows.filter(r => r.supplier === s); return [s, { records, fingerprint: fingerprint(records) }]; }));
const variant = (supplier = 'megapap', id = '001', extra = {}) => ({ variantId: 'gid://shopify/ProductVariant/1', productId: 'product:1', vendor: supplier === 'megapap' ? 'Mebelcenter' : 'Europe', sku: 'NEW', barcode: '5200000000001', handle: `mc-${id}`, title: 'Chair', inventoryItemId: 'item:1', tracked: true, available: 3, identityValue: JSON.stringify({ version: 1, suppliers: { [supplier]: id } }), ownershipValue: JSON.stringify({ version: 1, locations: { [locationId]: { supplier, supplierProductId: id, reason: 'verified', decision: 'default' } } }), identityDigest: 'identity:1', ownershipDigest: 'ownership:1', ...extra });
const classify = (rows, variants, supplier = 'megapap') => classifyInventory({ feeds: feeds(rows), variants, supplier, locationId });

for (const [input, expected] of [['0',0],['003',3],['42',42],[' 8 ',8]]) test(`strict quantity accepts ${JSON.stringify(input)}`, () => assert.equal(parseQuantity(input).quantity, expected));
for (const input of ['',undefined,'-1','1.5','1x','NaN','Infinity','+1','1,000','9007199254740992',true,['1','2']]) test(`strict quantity rejects ${JSON.stringify(input)}`, () => assert.equal(parseQuantity(input).quantity, null));
for (const supplier of ['megapap', 'b2bmarkt', 'symetron']) test(`${supplier}: canonical identity survives arbitrary Shopify SKU changes`, () => {
  const result = classify([rec(supplier)], [variant(supplier, '001', { sku: 'CUSTOMER-FACING-NEWER' })], supplier);
  assert.equal(result.rows[0].status, 'change'); assert.equal(result.rows[0].quantity, 7); assert.equal(result.rows[0].currentQuantity, 3);
});
test('adapter normalization preserves canonical leading zeros and zero', () => {
  assert.equal(normalizeRecords('megapap', [{ model: '0086733', sku: 'GP011-0014', quantity: '0' }])[0].supplierProductId, '0086733');
  const b = normalizeRecords('b2bmarkt', [{ ProductCode: '0612089', ItemCode: 'HM6006', Stock: '0' }])[0]; assert.equal(b.supplierProductId, '0612089'); assert.equal(b.quantity, 0);
});
test('a duplicate ItemCode does not merge distinct canonical identities', () => {
  const rows = [rec('b2bmarkt','0612089', {itemCode:'HM6006',quantity:21}),rec('b2bmarkt','0597486',{itemCode:'HM6006',quantity:0})];
  const variants = [variant('b2bmarkt','0612089',{sku:'HM6006'}),variant('b2bmarkt','0597486',{sku:'HM6006',variantId:'v2',productId:'p2',inventoryItemId:'i2'})];
  const result = classify(rows,variants,'b2bmarkt'); assert.deepEqual(result.rows.map(r=>r.quantity),[21,0]); assert.equal(result.summary.changes,2);
});
test('discovery disambiguates duplicate ItemCodes using single-variant legacy handles', () => {
  const rows = [rec('b2bmarkt','0612089',{itemCode:'HM6006'}),rec('b2bmarkt','0597486',{itemCode:'HM6006',barcode:''})];
  const variants = [variant('b2bmarkt','0612089',{sku:'HM6006',identityValue:null,ownershipValue:null}),variant('b2bmarkt','0597486',{sku:'HM6006',variantId:'v2',productId:'p2',identityValue:null,ownershipValue:null,barcode:''})];
  const d=discoverIdentities({feeds:feeds(rows),variants,locationId});assert.equal(d.summary.b2bmarkt.verified,2);assert.equal(d.proposals.length,2);
});
test('missing identifiers, duplicates, missing mappings, duplicate registry destinations are blocked', () => {
  assert.equal(classify([rec('megapap','')],[variant()]).rows[0].reason,'missing-identifier');
  assert.ok(classify([rec(),rec()],[variant()]).rows.every(r=>r.reason==='duplicate-supplier-identifier'));
  assert.equal(classify([rec()],[variant('megapap','other')]).rows[0].reason,'missing-persisted-mapping');
  assert.equal(classify([rec()],[variant(),variant('megapap','001',{variantId:'v2'})]).rows[0].reason,'duplicate-shopify-destination');
});
test('unmatched feed products and destination products absent from feeds never generate zeros', () => {
  const result=classify([rec('megapap','missing')],[variant()]); assert.equal(result.summary.changes,0);assert.equal(result.rows.length,1);assert.equal(result.rows[0].status,'unmatched');
  assert.equal(classify([], [variant()]).rows.length,0);
});
test('supplier isolation ignores shared vendors', () => {
  const result=classify([rec('symetron')],[variant('b2bmarkt')],'symetron');assert.equal(result.rows[0].status,'unmatched');
});
test('product-level handles cannot resolve multi-variant products', () => {
  const v1=variant('megapap','001',{identityValue:null,ownershipValue:null,sku:'NEW',barcode:''});const v2={...v1,variantId:'v2',sku:'SECOND'};
  const d=discoverIdentities({feeds:feeds([rec('megapap','001',{barcode:''})]),variants:[v1,v2],locationId});assert.equal(d.proposals.length,0);assert.equal(d.rows[0].status,'insufficient');
});
test('multiple independently corroborated Shopify variants are ambiguous', () => {
  const v=variant('megapap','001',{identityValue:null,ownershipValue:null});const d=discoverIdentities({feeds:feeds([rec()]),variants:[v,{...v,variantId:'v2',productId:'p2'}],locationId});assert.equal(d.rows[0].status,'conflict');assert.equal(d.proposals.length,0);
});
test('a SKU alone is insufficient evidence for backfill', () => {
  const v=variant('megapap','001',{identityValue:null,ownershipValue:null,handle:'edited',barcode:''});const d=discoverIdentities({feeds:feeds([rec('megapap','001',{barcode:''})]),variants:[v],locationId});assert.equal(d.rows[0].status,'insufficient');
});
function overlap() {
  const rows=[rec('b2bmarkt','0612644',{platformId:'73498'}),rec('symetron','0612644',{platformId:'73498'})];
  const v=variant('b2bmarkt','0612644',{identityValue:null,ownershipValue:null});return {rows,v};
}
test('B2BMarkt owns verified overlap; identities and location ownership are separate', () => {
  const {rows,v}=overlap();const d=discoverIdentities({feeds:feeds(rows),variants:[v],locationId});assert.equal(d.proposals.length,1);const p=d.proposals[0];
  assert.deepEqual(p.identity.suppliers,{b2bmarkt:'0612644',symetron:'0612644'});assert.equal(p.ownership.locations[locationId].supplier,'b2bmarkt');
  const persisted={...v,identityValue:JSON.stringify(p.identity),ownershipValue:JSON.stringify(p.ownership)};
  assert.equal(classify(rows,[persisted],'b2bmarkt').rows[0].status,'change');assert.equal(classify(rows,[persisted],'symetron').rows[0].reason,'owned-by-other-supplier');
});
test('Symetron-only products are independently owned', () => {
  const v=variant('symetron','001',{identityValue:null,ownershipValue:null});const d=discoverIdentities({feeds:feeds([rec('symetron')]),variants:[v],locationId});assert.equal(d.proposals[0].ownership.locations[locationId].supplier,'symetron');
});
test('explicit, reasoned ownership override wins verified overlap', () => {
  const {rows,v}=overlap();const d=discoverIdentities({feeds:feeds(rows),variants:[v],locationId,overrides:{[`${v.variantId}:${locationId}`]:{supplier:'symetron',reason:'Business approved source'}}});assert.equal(d.proposals[0].ownership.locations[locationId].supplier,'symetron');
});
test('unverified cross-supplier collisions cannot be assigned ownership', () => {
  const {rows,v}=overlap();rows[1].platformId='different';const d=discoverIdentities({feeds:feeds(rows),variants:[v],locationId});assert.equal(d.proposals.length,0);assert.ok(d.rows.every(r=>r.status==='conflict'));
});
test('missing B2BMarkt source does not silently transfer recorded ownership to Symetron', () => {
  const v=variant('b2bmarkt','0612644');v.identityValue=JSON.stringify({version:1,suppliers:{b2bmarkt:'0612644',symetron:'0612644'}});
  const rows=[rec('symetron','0612644',{platformId:'73498'})];assert.equal(classify(rows,[v],'symetron').rows[0].reason,'ownership-source-missing-review');
  const d=discoverIdentities({feeds:feeds(rows),variants:[v],locationId});assert.equal(d.proposals.length,0);
});
test('MegaPap identity cannot become a Europe supplier by shared evidence', () => {
  const result=classify([rec()],[variant('b2bmarkt')]);assert.equal(result.summary.changes,0);
});
test('missing location ownership, untracked inventory, and missing location inventory are skipped', () => {
  assert.equal(classify([rec()],[variant('megapap','001',{ownershipValue:null})]).rows[0].reason,'unresolved-ownership');
  assert.equal(classify([rec()],[variant('megapap','001',{tracked:false})]).rows[0].reason,'inventory-not-tracked');
  assert.equal(classify([rec()],[variant('megapap','001',{available:null})]).rows[0].reason,'location-inventory-unavailable');
});
test('unchanged stock and legitimate zero avoid unnecessary writes', () => {
  assert.equal(classify([rec('megapap','001',{quantity:0})],[variant('megapap','001',{available:0})]).rows[0].status,'already');
});
test('invalid metadata fails closed',()=>assert.equal(decodeIdentity('{broken'),null));
test('portal shares strict parsing and legacy IDs, blocks duplicates, preserves valid zero', () => {
  const xml='<root><Product><ProductCode>001</ProductCode><ItemCode>HM6006</ItemCode><Stock>0</Stock></Product><Product><ProductCode>002</ProductCode><ItemCode>HM6006</ItemCode><Stock>21</Stock></Product><Product><ProductCode>003</ProductCode><Stock>-1</Stock></Product><Product><ProductCode>004</ProductCode><Stock>2</Stock></Product><Product><ProductCode>004</ProductCode><Stock>4</Stock></Product></root>';
  const p=parsePortalFeed(xml,'b2bmarkt');assert.equal(p.map.get('001'),0);assert.equal(p.map.get('002'),21);assert.equal(p.map.has('003'),false);assert.equal(p.map.has('004'),false);assert.equal(p.invalid,1);assert.equal(p.dupes,1);
});

test('repeated XML identifier fields cannot select an arbitrary supplier identity',()=>{
 const rows=normalizeRecords('b2bmarkt',[{ProductCode:['001','002'],ItemCode:'SKU',ProductId:['10','20'],Stock:'4'}]);
 assert.equal(rows[0].supplierProductId,'');assert.equal(rows[0].platformId,'');assert.equal(rows[0].quantity,4);
});


test('selected vendor feed does not fetch or require the other supplier URLs',async()=>{
 const urls=[];const result=await loadFeeds({supplier:'megapap',env:{MEGAPAP_FEED_URL:'https://supplier.test/selected'},fetchImpl:async url=>{urls.push(url);return {ok:true,text:async()=>'<products><product><model>001</model><sku>NEW</sku><quantity>7</quantity></product></products>'};}});
 assert.deepEqual(urls,['https://supplier.test/selected']);assert.deepEqual(Object.keys(result),['megapap']);assert.equal(result.megapap.records[0].supplierProductId,'001');
});
