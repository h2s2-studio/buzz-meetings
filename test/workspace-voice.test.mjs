import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { WorkspaceHost,client,general } from "./workspace-host.mjs";
const built=await build({entryPoints:["src/workspace-voice.ts"],bundle:true,format:"esm",platform:"node",write:false});
const {workspaceProof}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
const raw=JSON.stringify({type:"workspace",community:"https://relay.example",channel:general,room:"General Voice",name:"Alex"});
const digest=createHash("sha256").update(raw).digest("hex"),nonce="a".repeat(32);
test("workspace admission signs only the bound challenge without publishing an artifact",async()=>{
  const host=new WorkspaceHost(),connection=client(host),proof=workspaceProof(connection.current(),connection.current);
  const answer=await proof(nonce,digest,raw,new AbortController().signal);
  assert.equal(host.publications.length,0); assert.equal(answer.event.pubkey,connection.current().viewer);
  assert.equal(answer.event.content,`Meetings admission ${nonce} ${digest}`);
  await assert.rejects(proof(nonce,"f".repeat(64),raw,new AbortController().signal),/changed/);
  host.grant(general,connection.current().viewer,null);
  await assert.rejects(proof(nonce,digest,raw,new AbortController().signal),/Reconnect/);
  connection.close();
});
test("canceled or changed native sessions cannot return an admission proof",async()=>{
  const host=new WorkspaceHost(),connection=client(host),original=connection.current();
  const proof=workspaceProof(original,()=>({...original,session:{...original.session}}));
  await assert.rejects(proof(nonce,digest,raw,new AbortController().signal),/Reconnect/);
  const canceled=new AbortController();canceled.abort();
  await assert.rejects(workspaceProof(original,connection.current)(nonce,digest,raw,canceled.signal));
  connection.close();
});
