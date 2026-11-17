import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const built = await build({ entryPoints:["src/meeting-records.ts"],bundle:true,format:"esm",platform:"node",write:false });
const { meetingRecords } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
import { WorkspaceHost, client, general } from "./workspace-host.mjs";
const relay = connection => ({ snapshot:connection.current,subscribe:connection.session.channels.subscribeList });
const transcript = { occurrenceId:"RM_call", roomName:"General Voice", warning:"", base:0, segments:Array.from({length:40},(_,i) => ({ startedAt:Date.now()+i, speakerName:i%2 ? "Riley" : "Alex", text:"Agreed task. ".repeat(200) })) };
const agents = { tasksFor:(channelId,occurrenceId) => channelId === general && occurrenceId === "RM_call" ? [{ title:"Research", status:"done", result:"Notes saved", messageId:"e".repeat(64) }] : [] };
const settle = () => new Promise(resolve => setTimeout(resolve,0));
test("meeting snapshots survive restart, chunk full text, and bind exact saved revisions",async () => {
  const host = new WorkspaceHost(), connection = client(host), records = meetingRecords(relay(connection),connection.storage);
  await records.save(general,transcript,agents); assert.equal(records.snapshot().error,"");
  const id = records.snapshot().saved; assert.ok(id); const text = await records.read(id);
  assert.equal(text.match(/Agreed task/g).length,8000); assert.match(text,/Alex/); assert.match(text,/Riley/);
  assert.ok(records.snapshot().records[0].value.parts.length > 1); records.close();
  const next = meetingRecords(relay(connection),connection.storage); await settle(); assert.match(await next.read(id),/Agreed task/);
  const part = next.snapshot().records[0].value.parts[0]; host.events.set(part.id,{...host.events.get(part.id),id:"f".repeat(64)});
  await assert.rejects(next.read(id),/unavailable/); next.close();connection.close();
});
test("lost meeting save receipts retry identical bytes and revoked access prevents writes",async () => {
  const host = new WorkspaceHost(), connection = client(host), records = meetingRecords(relay(connection),connection.storage);
  host.failPublish="after"; await records.save(general,transcript,agents); assert.equal(records.snapshot().pending,true);
  const first = host.publications[0]; host.failPublish=""; host.failRead=false;
  await records.retry(); assert.equal(records.snapshot().pending,false); assert.deepEqual(host.publications[1],first);
  const count=host.publications.length; host.grant(general,connection.current().viewer,null);
  await records.save(general,transcript,agents); assert.equal(host.publications.length,count); assert.match(records.snapshot().error,/access/);
  records.close();connection.close();
});
test("a failed journal write publishes no transcript",async () => {
  const host = new WorkspaceHost(), connection = client(host), records = meetingRecords(relay(connection),connection.storage);
  host.storageFailure=true; await records.save(general,transcript,agents); assert.equal(host.publications.length,0); assert.match(records.snapshot().error,/Disk/);
  records.close();connection.close();
});
