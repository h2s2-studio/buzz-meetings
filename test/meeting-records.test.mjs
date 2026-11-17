import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const built = await build({ entryPoints:["src/meeting-records.ts"],bundle:true,format:"esm",platform:"node",write:false });
const { meetingRecords } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
import { WorkspaceHost, client, general } from "./workspace-host.mjs";
const relay = connection => ({ snapshot:connection.current,subscribe:connection.session.channels.subscribeList });
const transcript = { occurrenceId:"RM_call", roomName:"General Voice", warning:"", base:0, segments:Array.from({length:40},(_,i) => ({ id:`stream:${i+1}`, seq:i+1, startedAt:Date.now()+i, endedAt:Date.now()+i+500, speakerId:i%2 ? "riley-source" : "alex-source", speakerName:i%2 ? "Riley" : "Alex", text:"Agreed task. ".repeat(200) })) };
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
test("records bind storage only once a community is selected, detach on loss and rebind on switch",async () => {
  const host = new WorkspaceHost(), connection = client(host), listeners = new Set(), opened = [];
  let current = { ...connection.current(), status:"connecting", origin:undefined, scope:undefined };
  // Mirrors Buzz's artifact storage: open() needs an identity and a selected community.
  const storage = { open(definition) { if (!current.viewer || !current.origin) throw new Error("Artifact storage needs a plugin, identity and relay"); opened.push(current.scope); return connection.storage.open(definition); } };
  const relay = { snapshot:() => current, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  const select = next => { current = { ...current, ...next }; for (const fn of listeners) fn(); };
  const records = meetingRecords(relay,storage);
  assert.deepEqual(opened,[]);
  await records.save(general,transcript,agents); assert.match(records.snapshot().error,/Connect to a community/); assert.equal(host.publications.length,0);
  select({ status:"ready", origin:"https://relay.example", scope:connection.current().scope });
  assert.deepEqual(opened,[connection.current().scope]);
  await records.save(general,transcript,agents); assert.equal(records.snapshot().error,""); await settle();
  assert.equal(records.snapshot().records.length,1);
  select({ status:"connecting", origin:undefined, scope:undefined }); await settle();
  assert.deepEqual(records.snapshot().records,[]);
  select({ status:"ready", origin:"https://relay.example", scope:connection.current().scope }); await settle();
  assert.equal(opened.length,2); assert.equal(records.snapshot().records.length,1);
  records.close(); connection.close();
});
test("saved records keep same-name speakers distinct and still read version 1 snapshots",async () => {
  const host = new WorkspaceHost(), connection = client(host), records = meetingRecords(relay(connection),connection.storage);
  const start = Date.UTC(2026,10,17,15,0,0);
  const rows = [["alex-studio-111111","Agreed on Thursday."],["alex-remote-222222","Friday works better."]].map(([speakerId,text],i) => ({ id:`stream:${i+1}`, seq:i+1, speakerId, speakerName:"Alex", startedAt:start+i*1000, endedAt:start+i*1000+500, text }));
  await records.save(general,{ ...transcript, segments:rows },agents);
  const text = await records.read(records.snapshot().saved);
  assert.match(text,/Alex · 111111: Agreed on Thursday\./); assert.match(text,/Alex · 222222: Friday works better\./);
  const [record] = records.snapshot().records; assert.equal(record.value.version,2);
  const part = host.events.get(record.value.parts[0].id);
  assert.deepEqual(JSON.parse(part.content).entries.map(entry => [entry.id,entry.speakerId]),[["stream:1","alex-studio-111111"],["stream:2","alex-remote-222222"]]);
  // A record saved by the previous release.
  const legacyPart = host.sign(connection.current().viewer,{ kind:45010, created_at:1, tags:[["ar","1"],["d","20000000-0000-4000-8000-000000000001"],["h",general],["type","studio.h2s2.meetings.record.part"],["title","Old"],["op","create"]], content:JSON.stringify({ version:1, channelId:general, text:"[2026-01-01T00:00:00.000Z] Alex: Legacy line." }) });
  host.publish(connection.current().viewer,legacyPart);
  host.publish(connection.current().viewer,host.sign(connection.current().viewer,{ kind:45010, created_at:1, tags:[["ar","1"],["d","20000000-0000-4000-8000-000000000002"],["h",general],["type","studio.h2s2.meetings.record"],["title","Old"],["op","create"]], content:JSON.stringify({ version:1, title:"Old", channelId:general, capturedAt:1, warning:"", parts:[{ id:"20000000-0000-4000-8000-000000000001", revision:legacyPart.id }], tasks:[] }) }));
  await settle();
  assert.equal(await records.read("20000000-0000-4000-8000-000000000002"),"[2026-01-01T00:00:00.000Z] Alex: Legacy line.");
  records.close(); connection.close();
});
