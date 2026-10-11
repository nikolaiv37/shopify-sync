import test from 'node:test';
import assert from 'node:assert/strict';
import { createInventoryService } from '../lib/inventory/service.js';
import { fingerprint } from '../lib/inventory/feeds.js';
import { verifyPreview, signPreview } from '../lib/inventory/authorization.js';
import { createInventoryStore, VARIANT_QUERY } from '../lib/inventory/shopify.js';
import { PREVIEW_TTL_MS } from '../lib/inventory/config.js';
const locationId='gid://shopify/Location/1';const key='test-only-secret';
function fixture({mapped=true,count=1}={}) {
  const records=Array.from({length:count},(_,i)=>({rowId:`megapap:${i}`,supplier:'megapap',supplierProductId:`00${i}`,itemCode:`NEW-${i}`,platformId:'',barcode:`52000000000${String(i).padStart(2,'0')}`,title:'Chair',quantity:7,quantityError:null}));
  const variants=records.map((r,i)=>({variantId:`gid://shopify/ProductVariant/${i}`,productId:`p${i}`,sku:r.itemCode,barcode:r.barcode,handle:`mc-${r.supplierProductId}`,vendor:'Mebelcenter',title:'Chair',inventoryItemId:`i${i}`,tracked:true,available:3,identityDigest:mapped?`d${i}`:null,ownershipDigest:mapped?`o${i}`:null,identityValue:mapped?JSON.stringify({version:1,suppliers:{megapap:r.supplierProductId}}):null,ownershipValue:mapped?JSON.stringify({version:1,locations:{[locationId]:{supplier:'megapap',supplierProductId:r.supplierProductId,reason:'verified'}}}):null}));
  let locked=false;let clock=100000; const journals=new Map();const writes=[];let uncertain=false;
  const store={
    appInfo:async()=>({id:'app1',scopes:['write_products','write_inventory']}),location:async()=>({id:locationId,name:'Sofia'}),readVariants:async()=>structuredClone(variants),readVariant:async id=>structuredClone(variants.find(v=>v.variantId===id)),requireDefinitions:async()=>{},
    withWriterLock:async callback=>{if(locked)throw new Error('locked');locked=true;try{return await callback({app:{id:'app1'},markUncertain:()=>{uncertain=true;}});}finally{if(!uncertain)locked=false;}},
    readJournal:async(_,id)=>({value:journals.get(id)?structuredClone(journals.get(id)):null,digest:null}),saveJournal:async(_,id,v)=>{journals.set(id,structuredClone(v));},history:async()=>[...journals.values()],
    persistProposal:async p=>{writes.push({type:'mapping',proposal:p});const v=variants.find(v=>v.variantId===p.variantId);v.identityValue=JSON.stringify(p.identity);v.ownershipValue=JSON.stringify(p.ownership);v.identityDigest='new-identity';v.ownershipDigest='new-owner';},
    setQuantity:async(row,location,run)=>{writes.push({type:'inventory',row,location,run});variants.find(v=>v.variantId===row.variantId).available=row.quantity;return {status:'success'};},
  };
  const getFeeds=async()=>Object.fromEntries(['megapap','b2bmarkt','symetron'].map(s=>{const rows=records.filter(r=>r.supplier===s);return[s,{records:structuredClone(rows),fingerprint:fingerprint(rows)}];}));
  const service=createInventoryService({store,getFeeds,auth:{key},now:()=>clock});
  return {service,store,writes,variants,records,journals,setClock:v=>{clock=v;},locked:()=>locked};
}
test('Preview and mapping discovery perform no external writes',async()=>{const f=fixture();await f.service.preview({supplier:'megapap'});await f.service.discovery();assert.equal(f.writes.length,0);assert.equal(f.journals.size,0);assert.equal(f.locked(),false);});
test('Apply requires explicit confirmation, valid signature, supplier and destination binding',async()=>{
 const f=fixture();const p=await f.service.preview({supplier:'megapap'});
 await assert.rejects(f.service.applyBatch({supplier:'megapap',token:p.batches[0]}),/потвърждение/);
 await assert.rejects(f.service.applyBatch({supplier:'megapap',token:p.batches[0]+'x',confirm:true}),/невалиден/);
 await assert.rejects(f.service.applyBatch({supplier:'symetron',token:p.batches[0],confirm:true}),/supplier/);
 assert.throws(()=>verifyPreview(p.batches[0],{target:'b2bcenter'},{key,now:100000}));assert.equal(f.writes.length,0);
});
test('expired previews are rejected',async()=>{const f=fixture();const p=await f.service.preview({supplier:'megapap'});f.setClock(100000+PREVIEW_TTL_MS);await assert.rejects(f.service.applyBatch({supplier:'megapap',token:p.batches[0],confirm:true,allowLargeApply:true}),/изтекъл/);});
test('large applies need separate explicit authorization',async()=>{const f=fixture();const p=await f.service.preview({supplier:'megapap'});await assert.rejects(f.service.applyBatch({supplier:'megapap',token:p.batches[0],confirm:true}),/40%/);assert.equal(f.writes.length,0);});
test('correct apply changes only selected location and quantities; replay is idempotent',async()=>{
 const f=fixture();const original=structuredClone(f.variants[0]);const p=await f.service.preview({supplier:'megapap'});
 const input={supplier:'megapap',token:p.batches[0],confirm:true,allowLargeApply:true};const r=await f.service.applyBatch(input);assert.equal(r.counts.updated,1);assert.equal(f.writes[0].location,locationId);assert.deepEqual({...f.variants[0],available:original.available},original);
 const again=await f.service.applyBatch(input);assert.equal(again.replayed,true);assert.equal(f.writes.length,1);
});
test('live quantity changed after Preview is stale',async()=>{const f=fixture();const p=await f.service.preview({supplier:'megapap'});f.variants[0].available=4;const r=await f.service.applyBatch({supplier:'megapap',token:p.batches[0],confirm:true,allowLargeApply:true});assert.equal(r.results[0].status,'stale');assert.equal(f.writes.length,0);});
test('inventory reaching target after Preview is already correct',async()=>{const f=fixture();const p=await f.service.preview({supplier:'megapap'});f.variants[0].available=7;const r=await f.service.applyBatch({supplier:'megapap',token:p.batches[0],confirm:true,allowLargeApply:true});assert.equal(r.results[0].status,'already');assert.equal(f.writes.length,0);});
test('changed ownership invalidates affected update',async()=>{const f=fixture();const p=await f.service.preview({supplier:'megapap'});f.variants[0].ownershipDigest='changed';const r=await f.service.applyBatch({supplier:'megapap',token:p.batches[0],confirm:true,allowLargeApply:true});assert.equal(r.results[0].status,'conflict');assert.equal(f.writes.length,0);});
test('changed feed fingerprint invalidates apply',async()=>{const f=fixture();const p=await f.service.preview({supplier:'megapap'});f.records[0].quantity=99;await assert.rejects(f.service.applyBatch({supplier:'megapap',token:p.batches[0],confirm:true,allowLargeApply:true}),/каталогът/);assert.equal(f.writes.length,0);});
test('changed selected location invalidates apply',async()=>{const f=fixture();const p=await f.service.preview({supplier:'megapap'});f.store.location=async()=>({id:'gid://shopify/Location/2'});await assert.rejects(f.service.applyBatch({supplier:'megapap',token:p.batches[0],confirm:true,allowLargeApply:true}),/Локацията/);});
test('partial API rejections are counted as failures, never successes',async()=>{const f=fixture({count:2});let index=0;f.store.setQuantity=async()=>++index===1?{status:'success'}:{status:'failed',reason:'API rejected'};const p=await f.service.preview({supplier:'megapap'});const r=await f.service.applyBatch({supplier:'megapap',token:p.batches[0],confirm:true,allowLargeApply:true});assert.deepEqual(r.counts,{updated:1,skipped:0,errors:1});assert.equal(r.run.status,'partial_failure');});
test('unknown write result stops and keeps writer lock for reconciliation',async()=>{const f=fixture();f.store.setQuantity=async()=>{throw new Error('network timeout');};const p=await f.service.preview({supplier:'megapap'});await assert.rejects(f.service.applyBatch({supplier:'megapap',token:p.batches[0],confirm:true,allowLargeApply:true}),/Неясен/);assert.equal(f.locked(),true);});
test('concurrent writers cannot interleave ownership and inventory changes',async()=>{const f=fixture();let release;const gate=new Promise(r=>{release=r;});f.store.setQuantity=async()=>{await gate;return {status:'success'};};const p=await f.service.preview({supplier:'megapap'});const input={supplier:'megapap',token:p.batches[0],confirm:true,allowLargeApply:true};const first=f.service.applyBatch(input);await new Promise(r=>setTimeout(r,5));await assert.rejects(f.service.applyBatch(input),/locked/);release();await first;});
test('missing mappings disable synchronization while discovery can propose verified identities',async()=>{const f=fixture({mapped:false});const p=await f.service.preview({supplier:'megapap'});assert.equal(p.canApply,false);assert.equal(p.mappingMissing,1);assert.equal(p.batches.length,0);const d=await f.service.discovery();assert.equal(d.proposedMappings,1);});
test('backfill is separately authorized, verified, and resumable',async()=>{const f=fixture({mapped:false});const d=await f.service.discovery();await assert.rejects(f.service.persistBatch({token:d.batches[0]}),/потвърждение/);const r=await f.service.persistBatch({token:d.batches[0],confirm:true});assert.equal(r.counts.updated,1);const again=await f.service.persistBatch({token:d.batches[0],confirm:true});assert.equal(again.replayed,true);assert.equal(f.writes.length,1);assert.equal(f.writes[0].type,'mapping');});
test('backfill rejects changed corroborating evidence',async()=>{const f=fixture({mapped:false});const d=await f.service.discovery();f.variants[0].sku='edited';f.variants[0].barcode='edited';const r=await f.service.persistBatch({token:d.batches[0],confirm:true});assert.equal(r.results[0].status,'conflict');assert.equal(f.writes.length,0);});
test('configuration/version tampering fails signature validation',()=>{const token=signPreview({kind:'inventory',supplier:'megapap',target:'shopify'},{key,now:10});const [encoded,sig]=token.split('.');const value=JSON.parse(Buffer.from(encoded,'base64url'));value.version='old';assert.throws(()=>verifyPreview(`${Buffer.from(JSON.stringify(value)).toString('base64url')}.${sig}`,{}, {key,now:20}));});
test('Shopify mutation user errors reject the whole quantity operation',async()=>{
 const calls=[];const client={gql:async(q,v)=>{calls.push(v);return {inventorySetQuantities:{inventoryAdjustmentGroup:null,userErrors:[{message:'batch failed',code:'INVALID_QUANTITY_TOO_LOW'}]}};},gqlWithRetry:async()=>{throw new Error('not used');}};
 const r=await createInventoryStore(client).setQuantity({inventoryItemId:'i1',quantity:7,currentQuantity:3},locationId,'run');assert.equal(r.status,'failed');assert.deepEqual(calls[0].input.quantities,[{inventoryItemId:'i1',locationId,quantity:7,compareQuantity:3}]);assert.equal('ignoreCompareQuantity' in calls[0].input,false);assert.doesNotMatch(VARIANT_QUERY,/inventoryQuantity/);
});

test('actual Shopify writer lock uses compareDigest and remains held on unknown outcomes',async()=>{
 let lock=null;let nextDigest=0;const writes=[];
 const client={gqlWithRetry:async()=>({currentAppInstallation:{id:'app1',accessScopes:[],lock}}),gql:async(_q,{metafields})=>{
   const m=metafields[0];writes.push(m);assert.equal(m.compareDigest,lock?.compareDigest??null);
   lock={value:m.value,compareDigest:`digest-${++nextDigest}`};return{metafieldsSet:{metafields:[{...m,compareDigest:lock.compareDigest}],userErrors:[]}};
 }};
 const store=createInventoryStore(client);await store.withWriterLock(async()=>42);assert.equal(JSON.parse(lock.value).holder,null);assert.equal(writes.length,2);
 await assert.rejects(store.withWriterLock(async({markUncertain})=>{markUncertain();throw new Error('timeout');}),/timeout/);
 assert.ok(JSON.parse(lock.value).holder);assert.equal(writes.length,3);await assert.rejects(store.withWriterLock(async()=>{}),/активна или прекъсната/);
});

test('negative Shopify available can be safely corrected to nonnegative supplier stock',async()=>{
 const f=fixture();f.variants[0].available=-2;const p=await f.service.preview({supplier:'megapap'});assert.equal(p.rows[0].status,'change');const r=await f.service.applyBatch({supplier:'megapap',token:p.batches[0],confirm:true,allowLargeApply:true});assert.equal(r.counts.updated,1);assert.equal(f.writes[0].row.currentQuantity,-2);
});

test('missing protected definitions block preview readiness and Apply before any writes',async()=>{
 const f=fixture();const p=await f.service.preview({supplier:'megapap'});
 f.store.requireDefinitions=async()=>{throw Object.assign(new Error('Initialize protected definitions'),{statusCode:409});};
 const blocked=await f.service.preview({supplier:'megapap'});assert.equal(blocked.mappingReady,false);assert.equal(blocked.canApply,false);assert.equal(blocked.batches.length,0);assert.equal(blocked.prerequisites.length,1);
 await assert.rejects(f.service.applyBatch({supplier:'megapap',token:p.batches[0],confirm:true,allowLargeApply:true}),/definitions/);assert.equal(f.writes.length,0);assert.equal(f.locked(),false);
});

test('explicit partial preview signs only eligible persisted rows; unresolved rows never write',async()=>{
 const f=fixture({count:2});f.variants[1].identityValue=null;f.variants[1].identityDigest=null;f.variants[1].ownershipValue=null;f.variants[1].ownershipDigest=null;
 const normal=await f.service.preview({supplier:'megapap'});assert.equal(normal.canApply,false);assert.equal(normal.batches.length,0);
 const partial=await f.service.preview({supplier:'megapap',allowPartial:true});assert.equal(partial.mappingReady,false);assert.equal(partial.canApply,true);assert.equal(partial.partial,true);assert.equal(partial.mappingMissing,1);
 const payload=verifyPreview(partial.batches[0],{kind:'inventory'},{key,now:100000});assert.equal(payload.partial,true);assert.equal(payload.items.length,1);
 const result=await f.service.applyBatch({supplier:'megapap',token:partial.batches[0],confirm:true,allowLargeApply:true});assert.equal(result.counts.updated,1);assert.equal(f.writes.length,1);assert.equal(f.writes[0].row.variantId,f.variants[0].variantId);
});
test('partial mode requires boolean true and cannot bypass missing protected definitions',async()=>{
 const f=fixture({mapped:false});assert.equal((await f.service.preview({supplier:'megapap',allowPartial:'true'})).partial,false);
 f.store.requireDefinitions=async()=>{throw Object.assign(new Error('definitions required'),{statusCode:409});};
 const p=await f.service.preview({supplier:'megapap',allowPartial:true});assert.equal(p.canApply,false);assert.equal(p.batches.length,0);
});
test('partial inventory apply skips unrelated canonical conflicts while validating selected rows',async()=>{
 const f=fixture({count:2});f.records.push({...f.records[1],rowId:'megapap:2'});
 const p=await f.service.preview({supplier:'megapap',allowPartial:true});assert.equal(p.summary.conflicts,2);assert.equal(p.batches.length,1);
 const r=await f.service.applyBatch({supplier:'megapap',token:p.batches[0],confirm:true,allowLargeApply:true});assert.equal(r.counts.updated,1);assert.equal(f.writes.length,1);assert.equal(f.writes[0].row.variantId,f.variants[0].variantId);
});
test('browser backfill initializes definitions only after signed mapping authorization and confirmation',async()=>{
 const f=fixture({mapped:false});const definitions=[];
 f.store.read=async()=>({metafieldDefinitions:{nodes:[]}});f.store.setDefinition=async d=>{definitions.push(d);return{id:d.key};};
 const d=await f.service.discovery();
 await assert.rejects(f.service.persistBatch({token:'tampered',confirm:true,initializeDefinitions:true}));assert.equal(definitions.length,0);
 await assert.rejects(f.service.persistBatch({token:d.batches[0],initializeDefinitions:true}));assert.equal(definitions.length,0);
 const r=await f.service.persistBatch({token:d.batches[0],confirm:true,initializeDefinitions:true});assert.equal(r.counts.updated,1);assert.equal(definitions.length,2);assert.equal(f.writes[0].type,'mapping');assert.ok(definitions.every(d=>d.access.admin==='MERCHANT_READ'));
});
test('mapping discovery retains Shopify title, current SKU, and selected location quantity for review',async()=>{
 const f=fixture({mapped:false});f.variants[0].title='Shopify title';const d=await f.service.discovery();assert.equal(d.rows[0].shopifyTitle,'Shopify title');assert.equal(d.rows[0].currentSku,'NEW-0');assert.equal(d.rows[0].currentQuantity,3);assert.equal(d.rows[0].quantity,7);
});

test('vendor setup preserves known B2BMarkt ownership without downloading other feeds',async()=>{
 const f=fixture({mapped:false,count:3});
 f.records[1].supplier='b2bmarkt';f.records[1].platformId='platform-overlap';
 f.records[2].supplier='symetron';f.variants[1].vendor='Europe';f.variants[2].vendor='Europe';
 f.records.push({...f.records[1],supplier:'symetron',rowId:'symetron:overlap'});
 const all=await f.service.discovery();assert.equal(all.proposedMappings,3);
 const sharedProposal=verifyPreview(all.batches[0],{}, {key,now:100000}).items.find(p=>p.variantId===f.variants[1].variantId);
 f.variants[1].identityValue=JSON.stringify(sharedProposal.identity);f.variants[1].ownershipValue=JSON.stringify(sharedProposal.ownership);
 const sym=await f.service.discovery({supplier:'symetron'});
 assert.equal(sym.supplier,'symetron');assert.equal(sym.rows.length,2);assert.equal(sym.proposedMappings,1);
 const payload=verifyPreview(sym.batches[0],{}, {key,now:100000});
 assert.equal(payload.items.length,1);assert.equal(payload.items[0].ownership.locations[locationId].supplier,'symetron');
 const b2b=await f.service.discovery({supplier:'b2bmarkt'});assert.equal(b2b.proposedMappings,0);
 assert.equal(sym.rows.find(r=>r.rowId==='symetron:overlap').owner,'b2bmarkt');
 await f.service.persistBatch({token:sym.batches[0],confirm:true});
 assert.equal(f.writes.length,1);assert.equal(f.writes[0].proposal.variantId,f.variants[2].variantId);
 const preview=await f.service.preview({supplier:'symetron',allowPartial:true});assert.equal(preview.canApply,true);
 assert.equal(f.writes.every(w=>w.type==='mapping'),true);
});
test('vendor setup rejects unknown supplier rather than falling back to every supplier',async()=>{
 const f=fixture({mapped:false});await assert.rejects(f.service.discovery({supplier:'unknown'}));assert.equal(f.writes.length,0);
});

test('vendor preview and apply fetch only selected feed and never scan the catalog per batch',async()=>{
 const f=fixture({count:205});let scans=0;const lookups=[],feedKeys=[];
 const originalScan=f.store.readVariants;
 f.store.readVariants=async(...args)=>{scans++;return originalScan(...args);};
 f.store.readVariantBatch=async ids=>{lookups.push(ids);return structuredClone(f.variants.filter(v=>ids.includes(v.variantId)));};
 const service=createInventoryService({store:f.store,getFeeds:async({supplier})=>{feedKeys.push(supplier);return Object.fromEntries(['megapap','b2bmarkt','symetron'].map(key=>[key,{records:key==='megapap'?structuredClone(f.records):[],fingerprint:key==='megapap'?fingerprint(f.records):'empty'}]));},auth:{key},now:()=>100000});
 let calls=0;f.store.setQuantities=async rows=>{calls++;for(const row of rows)f.variants.find(v=>v.variantId===row.variantId).available=row.quantity;return rows.map(row=>({variantId:row.variantId,rowId:row.rowId,status:'success'}));};
 const preview=await service.preview({supplier:'megapap'});assert.equal(preview.batches.length,3);
 for(const token of preview.batches)await service.applyBatch({supplier:'megapap',token,confirm:true,allowLargeApply:true});
 assert.equal(scans,1);assert.equal(calls,3);assert.deepEqual(lookups.map(ids=>ids.length),[100,100,5]);assert.deepEqual(feedKeys,['megapap','megapap','megapap','megapap']);
});
test('mapping setup is reused from preview; metadata writes are grouped and verified in batches',async()=>{
 const f=fixture({mapped:false,count:25});let scanCount=0;const original=f.store.readVariants;
 f.store.readVariants=async()=>{scanCount++;return original();};const groups=[];
 f.store.persistProposals=async proposals=>{groups.push(proposals.length);for(const p of proposals)await f.store.persistProposal(p);};
 f.store.readVariantBatch=async ids=>structuredClone(f.variants.filter(v=>ids.includes(v.variantId)));
 const preview=await f.service.preview({supplier:'megapap'});assert.equal(preview.setup.proposedMappings,25);
 const result=await f.service.persistBatch({token:preview.setup.batches[0],confirm:true});
 assert.equal(result.counts.updated,25);assert.deepEqual(groups,[12,12,1]);assert.equal(scanCount,1);assert.equal(f.writes.every(w=>w.type==='mapping'),true);
});
test('Shopify batch quantity mutation preserves compare quantities and rejects uncertain mixed results',async()=>{
 const calls=[];let response={inventoryAdjustmentGroup:{id:'adjustment'},userErrors:[]};
 const store=createInventoryStore({gql:async(_q,args)=>{calls.push(args);return {inventorySetQuantities:response};}});
 const rows=[{variantId:'v1',rowId:'r1',inventoryItemId:'i1',quantity:7,currentQuantity:3},{variantId:'v2',rowId:'r2',inventoryItemId:'i2',quantity:0,currentQuantity:8}];
 assert.equal((await store.setQuantities(rows,locationId,'run')).filter(r=>r.status==='success').length,2);
 assert.deepEqual(calls[0].input.quantities,rows.map(r=>({inventoryItemId:r.inventoryItemId,locationId,quantity:r.quantity,compareQuantity:r.currentQuantity})));
 assert.equal('ignoreCompareQuantity' in calls[0].input,false);
 response={inventoryAdjustmentGroup:null,userErrors:[{code:'COMPARE_QUANTITY_STALE',message:'changed'}]};assert.equal((await store.setQuantities(rows,locationId,'run')).every(r=>r.status==='stale'),true);
 response={inventoryAdjustmentGroup:{id:'mixed'},userErrors:[{message:'partial?'}]};await assert.rejects(store.setQuantities(rows,locationId,'run'),/both an adjustment/);
});

test('lightweight vendor index fetches location quantities only for relevant candidates and retains duplicate identities',async()=>{
 const calls=[],progress=[];
 const raw=(id,sku,identity=null)=>({id,sku,barcode:'',product:{id:`product-${id}`,title:id,handle:'unrelated',vendor:'Europe'},identity:identity?{value:JSON.stringify(identity),compareDigest:'d'}:null,ownership:null});
 const rows=[raw('v1','selected-sku'),raw('v2','unrelated-sku',{version:1,suppliers:{symetron:'selected-id'}}),raw('v3','other-sku',{version:1,suppliers:{b2bmarkt:'other-id'}})];
 const client={gqlWithRetry:async(q,args)=>{calls.push({q,args});if(q.includes('productVariants('))return {productVariants:{nodes:rows,pageInfo:{hasNextPage:false}}};return {nodes:rows.filter(v=>args.ids.includes(v.id)).map(v=>({...v,inventoryItem:{id:`item-${v.id}`,tracked:true,inventoryLevel:{quantities:[{name:'available',quantity:4}]}}}))};}};
 const result=await createInventoryStore(client).readVariants(locationId,v=>progress.push(v),'symetron',[{supplierProductId:'selected-id',itemCode:'selected-sku',barcode:'',platformId:''}]);
 assert.equal(calls.length,2);assert.match(calls[0].args.query,/vendor:"Europe"/);assert.doesNotMatch(calls[0].q,/inventoryLevel|\$location/);assert.deepEqual(calls[1].args.ids,['v1','v2']);
 assert.equal(result.length,3);assert.equal(result[0].available,4);assert.equal(result[2].available,null);assert.equal(progress[0],3);assert.deepEqual(progress[1],{stage:'quantities',processed:2,total:2});
});

test('post-setup preview rereads journaled variants instead of scanning Shopify again and binds vendor/location',async()=>{
 const f=fixture({mapped:false,count:3});let scans=0;const original=f.store.readVariants;
 f.store.readVariants=async()=>{scans++;return original();};
 f.store.readVariantBatch=async ids=>structuredClone(f.variants.filter(v=>ids.includes(v.variantId)));
 const preview=await f.service.preview({supplier:'megapap'});await f.service.persistBatch({token:preview.setup.batches[0],confirm:true});
 const refreshed=await f.service.preview({supplier:'megapap',allowPartial:true,setupRunId:preview.setup.runId});
 assert.equal(scans,1);assert.equal(refreshed.summary.changes,3);assert.equal(refreshed.canApply,true);
 await assert.rejects(f.service.preview({supplier:'symetron',setupRunId:preview.setup.runId}),/Няма завършено/);
 await assert.rejects(f.service.preview({supplier:'megapap',setupRunId:'unknown'}),/Няма завършено/);
});
