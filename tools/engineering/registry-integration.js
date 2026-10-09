"use strict";
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),assert=require("node:assert/strict"),{execFileSync}=require("node:child_process");
const [image,output]=process.argv.slice(2);assert.match(image||"",/^nocturne-engineering-runner:(amd64|arm64)$/);fs.mkdirSync(output,{recursive:true});
const suffix=crypto.randomUUID(),registry="nc-registry-"+suffix,client="nc-registry-client-"+suffix,net="nc-registry-net-"+suffix;
const docker=(...a)=>execFileSync("docker",a,{encoding:"utf8",timeout:120000,stdio:["ignore","pipe","pipe"]}).trim();
try{
 docker("network","create","--internal",net);docker("run","-d","--name",registry,"--network",net,"registry:3");
 docker("create","--name",client,"--network",net,"--entrypoint","node",image,"/tmp/registry-client.js","http://"+registry+":5000");
 docker("cp",path.join(__dirname,"registry-client.js"),client+":/tmp/registry-client.js");docker("cp",path.join(__dirname,"../image-publish-policy.js"),client+":/tmp/image-publish-policy.js");
 const result=docker("start","-a",client);assert.equal(docker("inspect","--format","{{.State.ExitCode}}",client),"0");const parsed=JSON.parse(result);assert.equal(parsed.failed,0);fs.writeFileSync(path.join(output,"registry-integration.json"),result+"\n");console.log("isolated registry integration: "+parsed.passed+" checks passed, no external writes");
}finally{
 try{fs.writeFileSync(path.join(output,"registry.log"),docker("logs",registry)+"\n");}catch{}
 for(const c of [client,registry])try{docker("rm","-f","-v",c);}catch{}
 try{docker("network","rm",net);}catch{}
}
