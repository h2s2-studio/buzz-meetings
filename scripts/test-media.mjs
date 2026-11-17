import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const host = "127.0.0.1";
const key = "local-test-creation-key-only";
const proxyKey = "5".repeat(64);
const processes = [];
const repository = fileURLToPath(new URL("../", import.meta.url));

async function reservePort() {
  const server = createServer();
  server.listen(0, host);
  await once(server, "listening");
  return server;
}

function start(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: repository, env: { ...process.env, ...env }, stdio: "inherit",
  });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  closed.catch(() => {});
  processes.push({ child, closed });
  return closed;
}

async function ready(url, closed) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const result = await Promise.race([
      closed.then(({ code }) => { throw new Error(`Service exited before ${url} was ready (${code})`); }),
      fetch(url, { signal: AbortSignal.timeout(2000) }).catch(() => undefined),
    ]);
    if (result?.ok) return;
    await setTimeout(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const reserved = await Promise.all([reservePort(), reservePort(), reservePort(), reservePort()]);
const [liveKitPort, brokerPort, tcpPort, udpPort] = reserved.map((server) => server.address().port);
await Promise.all(reserved.map((server) => new Promise((resolve) => server.close(resolve))));
const stop = () => {
  for (const { child } of processes) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  const liveKit = start(process.env.LIVEKIT_SERVER_BIN || "livekit-server", [
    "--dev", "--bind", host, "--node-ip", host,
    "--config-body", `port: ${liveKitPort}
rtc:
  tcp_port: ${tcpPort}
  udp_port: ${udpPort}
  use_external_ip: false
  enable_loopback_candidate: true
logging:
  level: error`,
  ]);
  const broker = start(process.env.ROOM_SERVICE_BIN || "./target/debug/buzz-meetings-server", [], {
    BUZZ_MEETINGS_BIND_ADDR: `${host}:${brokerPort}`,
    LIVEKIT_URL: `ws://${host}:${liveKitPort}`,
    LIVEKIT_API_KEY: "devkey",
    LIVEKIT_API_SECRET: "secret",
    MEETING_ACCESS_KEY: key,
    MEETING_PROXY_KEY: proxyKey,
  });
  await Promise.all([
    ready(`http://${host}:${liveKitPort}/`, liveKit),
    ready(`http://${host}:${brokerPort}/health`, broker),
  ]);
  const test = await start(process.execPath, [
    "node_modules/@playwright/test/cli.js", "test", ...process.argv.slice(2),
  ], {
    BUZZ_TEST_UPSTREAM_URL: `ws://${host}:${brokerPort}`,
    BUZZ_TEST_PROXY_KEY: proxyKey,
  });
  process.exitCode = test.code ?? 1;
} finally {
  stop();
  await Promise.race([
    Promise.allSettled(processes.map(({ closed }) => closed)),
    setTimeout(5000, undefined, { ref: false }),
  ]);
  for (const { child } of processes) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}
