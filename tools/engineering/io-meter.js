"use strict";
// 测试/基准预加载：计数 Node 文件 API 调用及耗时，不改生产响应，不写生产数据。
const fs=require("node:fs"),fsp=require("node:fs/promises"),{performance}=require("node:perf_hooks");
let values={};const count=(k,n=1)=>{values[k]=(values[k]||0)+n;};const bytes=b=>Buffer.isBuffer(b)?b.length:Buffer.byteLength(String(b));
for(const k of ["lstatSync","statSync","readdirSync","renameSync","unlinkSync","rmSync","mkdirSync"]){const f=fs[k];fs[k]=function(...a){count(k);return f.apply(this,a);};}
const read=fs.readFileSync;fs.readFileSync=function(...a){count("readFileSync");const r=read.apply(this,a);count("readBytes",bytes(r));return r;};
const write=fs.writeSync;fs.writeSync=function(...a){count("writeSync");const n=write.apply(this,a);count("writeBytes",n);return n;};
const sync=fs.fsyncSync;fs.fsyncSync=function(...a){count("fsync");const s=performance.now();try{return sync.apply(this,a);}finally{count("fsyncMs",performance.now()-s);}};
const open=fsp.open;fsp.open=async function(...a){count("asyncOpen");const h=await open.apply(this,a);return new Proxy(h,{get(t,k){if(k==="writeFile")return async b=>{count("asyncWriteFile");count("writeBytes",bytes(b));return t.writeFile(b);};if(k==="sync")return async()=>{count("fsync");const s=performance.now();try{return await t.sync();}finally{count("fsyncMs",performance.now()-s);}};const v=Reflect.get(t,k,t);return typeof v==="function"?v.bind(t):v;}});};
const snapshot=()=>({...values}),reset=()=>{values={};};
process.on("message",m=>{if(m?.nocturneIo){if(m.nocturneIo==="reset")reset();process.send?.({nocturneIo:m.id,values:snapshot()});}});
module.exports={snapshot,reset};
