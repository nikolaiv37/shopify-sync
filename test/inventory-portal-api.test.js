import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { applyGuardedUpdates } from '../lib/b2bcenterSync.js';
import { handleDashboardRequest } from '../lib/dashboardApp.js';

const logger={info:()=>{}};
test('portal writes only quantity with tenant, manufacturer, SKU, version, visibility and old quantity guards',async()=>{
 const calls=[];
 const client={from(table){calls.push(['from',table]);return{update(values){calls.push(['update',values]);return this;},eq(column,value){calls.push(['eq',column,value]);return this;},async select(){return{data:[{id:'portal1',sku:'001',quantity:7}],error:null};}};}};
 const result=await applyGuardedUpdates({supabase:client,tenantId:'tenant',plan:[{id:'portal1',sku:'001',manufacturer:'Mebelcenter',currentQuantity:3,newQuantity:7,updatedAt:'2026-10-10T00:00:00Z'}]},logger);
 assert.equal(result.updated,1);assert.deepEqual(calls.find(c=>c[0]==='update'),['update',{quantity:7}]);
 for(const column of ['id','tenant_id','manufacturer','sku','updated_at','quantity','is_visible']) assert.ok(calls.some(c=>c[0]==='eq'&&c[1]===column));
 assert.equal(calls.some(c=>JSON.stringify(c).includes('ProductVariant')),false);
});
test('portal stale rows and API errors are counted accurately',async()=>{
 let index=0;const client={from(){return{update(){return this;},eq(){return this;},async select(){return ++index===1?{data:[],error:null}:{data:null,error:{message:'rejected'}};}};}};
 const result=await applyGuardedUpdates({supabase:client,tenantId:'t',plan:[{id:'1',sku:'A'},{id:'2',sku:'B'}]},logger);
 assert.equal(result.updated,0);assert.equal(result.conflictSkipped,1);assert.equal(result.errors,1);
});
function response(){return{statusCode:null,body:null,writeHead(code,headers){this.statusCode=code;this.headers=headers;},end(body){this.body=body;}};}
const cookie=password=>`mebelcenter_ops_auth=${crypto.createHash('sha256').update(password).digest('hex')}`;
test('inventory APIs require authenticated dashboard session',async()=>{
 const old=process.env.DASHBOARD_PASSWORD;process.env.DASHBOARD_PASSWORD='test-local';
 try{for(const route of ['preview','discovery','backfill-batch','apply-batch','history']){const res=response();await handleDashboardRequest({url:`/api/inventory/${route}`,method:route==='history'?'GET':'POST',headers:{host:'localhost'},body:{}},res);assert.equal(res.statusCode,401);}}finally{if(old==null)delete process.env.DASHBOARD_PASSWORD;else process.env.DASHBOARD_PASSWORD=old;}
});
test('legacy Shopify apply endpoint cannot bypass signed Preview authorization',async()=>{
 const old=process.env.DASHBOARD_PASSWORD;process.env.DASHBOARD_PASSWORD='test-local';
 try{const res=response();await handleDashboardRequest({url:'/api/sync',method:'POST',headers:{host:'localhost',cookie:cookie('test-local')},body:{target:'shopify',supplierKey:'megapap',dryRun:false,confirm:true}},res);assert.equal(res.statusCode,409);assert.match(String(res.body),/signed Inventory V2 preview/);}finally{if(old==null)delete process.env.DASHBOARD_PASSWORD;else process.env.DASHBOARD_PASSWORD=old;}
});

test('streamed inventory errors use compressed NDJSON and finish the authenticated response',async()=>{
 const {Writable}=await import('node:stream');const {once}=await import('node:events');const {gunzipSync}=await import('node:zlib');
 const keys=['DASHBOARD_PASSWORD','SHOPIFY_STORE_DOMAIN','SHOPIFY_CLIENT_ID','SHOPIFY_CLIENT_SECRET'];const old=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 for(const key of keys)process.env[key]='test-only';
 const chunks=[];const res=new Writable({write(chunk,_encoding,callback){chunks.push(chunk);callback();}});res.writeHead=function(code,headers){this.statusCode=code;this.headers=headers;};res.flushHeaders=()=>{};
 try{
  const finished=once(res,'finish');
  await handleDashboardRequest({url:'/api/inventory/preview',method:'POST',headers:{host:'localhost',cookie:cookie('test-only')},body:{supplier:'invalid',stream:true}},res);await finished;
  assert.equal(res.statusCode,200);assert.equal(res.headers['Content-Encoding'],'gzip');assert.match(res.headers['Content-Type'],/ndjson/);
  const events=gunzipSync(Buffer.concat(chunks)).toString().trim().split('\n').map(line=>JSON.parse(line));assert.equal(events[0].progress.stage,'feed');assert.match(events.at(-1).error,/доставчик/);
 }finally{for(const key of keys)if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key];}
});
