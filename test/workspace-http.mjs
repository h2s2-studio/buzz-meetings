// Test-only HTTP/SSE adapter. It models host contracts; it is not the Buzz relay.
import { WorkspaceHost, identities } from "./workspace-host.mjs";

export function workspaceFixturePlugin() {
  const hosts = new Map(), streams = new Set();
  const hostFor = realm => {
    if (!hosts.has(realm)) hosts.set(realm, new WorkspaceHost());
    return hosts.get(realm);
  };
  const snapshot = (host, viewer) => {
    const state = host.state(viewer);
    const allowed = new Set(state.channels.map(channel => channel.id));
    const records = [...host.events.values()].filter(event => allowed.has(event.tags.find(tag => tag[0] === "h")?.[1]));
    return { ...state, records, canvases: Object.fromEntries(state.channels.map(channel => [channel.id, host.canvas(viewer, channel.id) ?? null])), messages: Object.fromEntries(state.channels.map(channel => [channel.id, host.chat(viewer, channel.id)])) };
  };
  return {
    name: "meetings-workspace-contract-fixture",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url, "http://fixture.local");
        if (!url.pathname.startsWith("/__workspace/")) return next();
        const host = hostFor(url.searchParams.get("realm") || "default");
        const viewer = url.searchParams.get("viewer") || identities.Alex;
        if (!Object.values(identities).includes(viewer)) { response.statusCode = 403; response.end("Unknown fixture identity"); return; }
        response.setHeader("Cache-Control", "no-store");
        if (url.pathname === "/__workspace/events") {
          response.setHeader("Content-Type", "text/event-stream"); response.setHeader("Connection", "keep-alive"); response.flushHeaders();
          const send = () => response.write(`data: ${JSON.stringify(snapshot(host, viewer))}\n\n`);
          host.listeners.add(send); streams.add(response); send();
          response.on("close", () => { host.listeners.delete(send); streams.delete(response); }); return;
        }
        response.setHeader("Content-Type", "application/json");
        try {
          let raw = ""; for await (const chunk of request) { raw += chunk; if (raw.length > 1024 * 1024) throw new Error("Fixture request too large"); }
          const input = raw ? JSON.parse(raw) : {};
          let result;
          switch (url.pathname.slice("/__workspace/".length)) {
            case "state": result = snapshot(host, viewer); break;
            case "read": result = host.read(viewer, input.filters); break;
            case "sign": result = host.sign(viewer, input.template); break;
            case "publish": result = host.publish(viewer, input.event); break;
            case "details": result = host.details(viewer, input.id); break;
            case "rename": result = host.rename(viewer, input.base, input.draft); break;
            case "create": result = host.create(viewer, input); break;
            case "canvas": result = host.saveCanvas(viewer, input.id, input.content, input.expected); break;
            case "message": result = host.send(viewer, input.id, input.text); break;
            // Explicit fixture controls, reachable only on the local test server.
            case "control":
              if (input.grant) host.grant(input.grant.id, input.grant.viewer, input.grant.role);
              if ("failPublish" in input) host.failPublish = input.failPublish;
              if ("failRead" in input) host.failRead = input.failRead;
              result = { publications: host.publications, creations: host.creations, events: [...host.events.values()] }; break;
            default: throw new Error("Unknown fixture operation");
          }
          response.end(JSON.stringify({ result: result ?? null, state: snapshot(host, viewer) }));
        } catch (error) { response.statusCode = 409; response.end(JSON.stringify({ error: error.message, state: snapshot(host, viewer) })); }
      });
    },
    closeBundle() { for (const response of streams) response.end(); streams.clear(); },
  };
}
