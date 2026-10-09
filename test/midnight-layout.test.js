"use strict";
// V2.1 的排版只读视图：不改变账户配置、项目顺序、空间引用和编辑撤销。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { seedAccount, startServer, client } = require("./helpers");
const { openPage, SKIP } = require("./browser");
const FIX = require("./fixtures/v1.1-config.json");
const plain = v => JSON.parse(JSON.stringify(v));
async function boot(t, data) {
  const srv = await startServer({ seed(dir) {
    seedAccount(dir); fs.mkdirSync(path.join(dir,"config"), {recursive:true});
    fs.writeFileSync(path.join(dir,"config/admin.json"),JSON.stringify({version:3,data}));
  }});
  t.after(()=>srv.stop());
  const c=client(srv.base); assert.equal((await c.post("/api/login",{name:"admin",password:"admin-pass-1"})).status,200);
  const p=await openPage(srv.base,c); t.after(()=>p.close()); await p.idle(500);
  assert.deepEqual(p.errors,[]); return {p,c};
}
function data() { const d=structuredClone(FIX); delete d.settings.net; delete d.recent; return d; }
const options={skip:SKIP,timeout:30000};

test("Midnight layout leaves old config and order unchanged, including empty groups, classic and edit/undo",options,async t=>{
  const d=data(), {p,c}=await boot(t,d), {A,win}=p;
  const before=plain(A.state), diskBefore=(await c.get('/api/config')).json.data, puts=p.puts().length, doc=win.document;
  const order=()=>[...doc.querySelectorAll('#x-groups > .x-group')].map(e=>e.dataset.gid);
  assert.deepEqual(order(),d.groups.map(g=>g.id));
  A.render(); A.appearance.set('classic'); A.appearance.set('v2');
  A.emit('edit',{handled:false});
  assert.ok(doc.body.classList.contains('editing'));
  assert.ok(doc.querySelector('[data-gid="emptygrp001"] [data-add]'), 'empty group remains editable');
  assert.deepEqual(plain(A.state),before); assert.equal(p.puts().length,puts);
  A.commit(s=>s.groups[0].items.push(...[1,2].map(n=>({id:'new'+n,title:'Added '+n,lan:'http://127.0.0.1',wan:'',icon:{type:'text',value:'N'}}))),'add');
  assert.equal(doc.querySelector('#x-groups > .x-group').dataset.size,'large');
  assert.ok(A.undo()); assert.equal(doc.querySelector('#x-groups > .x-group').dataset.size,'small');
  assert.deepEqual(plain(A.state),before); assert.deepEqual(order(),d.groups.map(g=>g.id));
  await p.idle(); assert.deepEqual((await c.get('/api/config')).json.data,diskBefore);
  assert.deepEqual(p.errors,[]);
});

test("Midnight group sizes follow the visible space subset, preserve hidden items and reclassify on switching",options,async t=>{
  const d=data(); d.groups[0].items.push(...[1,2].map(n=>({id:'extra'+n,title:'Extra '+n,lan:'http://127.0.0.1',wan:'',icon:{type:'text',value:'X'}})));
  d.spacesVersion=2; d.spaces=[{id:'s-one',name:'工作',groupIds:[d.groups[0].id],excludeItemIds:['extra1','extra2']}];
  const {p}=await boot(t,d), {A,win}=p, before=plain(A.state), puts=p.puts().length;
  const first=()=>win.document.querySelector('#x-groups > .x-group');
  assert.equal(first().dataset.size,'large');
  A.spaces.select('s-one'); assert.equal(first().dataset.size,'small');
  assert.equal(first().querySelectorAll('.x-tile[data-id]').length,3);
  A.spaces.select('all'); assert.equal(first().dataset.size,'large');
  assert.equal(first().querySelectorAll('.x-tile[data-id]').length,5);
  await p.idle(300); assert.deepEqual(plain(A.state),before); assert.equal(p.puts().length,puts); assert.deepEqual(p.errors,[]);
});
