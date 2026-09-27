import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { createServer as createTcpServer } from "node:net";
import test from "node:test";
import { isViewerSocketPath, ViewerShellServer, viewerTargetPath } from "./viewer-shell.js";

test("viewer proxy preserves Socket.IO query parameters", () => {
  assert.equal(
    viewerTargetPath("/viewer/socket.io/?EIO=4&transport=polling&t=abc"),
    "/socket.io/?EIO=4&transport=polling&t=abc",
  );
});

test("viewer proxy maps its document routes to the upstream root", () => {
  assert.equal(viewerTargetPath("/viewer"), "/");
  assert.equal(viewerTargetPath("/viewer/"), "/");
  assert.equal(viewerTargetPath("/viewer/worker.js?v=1"), "/worker.js?v=1");
});

test("recognizes proxied and direct Socket.IO transport paths", () => {
  assert.equal(isViewerSocketPath("/viewer/socket.io/"), true);
  assert.equal(isViewerSocketPath("/socket.io/"), true);
  assert.equal(isViewerSocketPath("/viewer/worker.js"), false);
});

test("proxies Socket.IO POST bodies and query parameters without caching", async () => {
  const upstream = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=60" });
      res.end(JSON.stringify({ method: req.method, url: req.url, body }));
    });
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress !== "string");
  const shellPort = await freePort();
  const shell = new ViewerShellServer({ host: "127.0.0.1", port: shellPort, viewerPort: upstreamAddress.port, statsPort: 1 });
  await shell.start();
  try {
    const result = await new Promise<{ status: number; cache: string | undefined; body: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: shellPort, method: "POST", path: "/viewer/socket.io/?EIO=4&transport=polling&sid=test" }, res => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", chunk => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, cache: res.headers["cache-control"], body }));
      });
      req.once("error", reject);
      req.end("40");
    });
    assert.equal(result.status, 200);
    assert.equal(result.cache, "no-store");
    assert.deepEqual(JSON.parse(result.body), {
      method: "POST",
      url: "/socket.io/?EIO=4&transport=polling&sid=test",
      body: "40",
    });
  } finally {
    shell.stop();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

async function freePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

interface Recorded { method: string; url: string; headers: Record<string, unknown> }

async function recordingServer(body: string, extraHeaders: Record<string, string> = {}): Promise<{ port: number; seen: Recorded[]; close(): Promise<void> }> {
  const seen: Recorded[] = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", headers: { ...req.headers } });
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/plain", "x-powered-by": "Express", ...extraHeaders });
      res.end(body);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  return { port: address.port, seen, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

async function send(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.once("error", reject);
    req.end(body);
  });
}

async function publicShell(limits?: ConstructorParameters<typeof ViewerShellServer>[0]["limits"]) {
  const viewer = await recordingServer("viewer-body");
  const stats = await recordingServer("FULL-PRIVATE-STATE");
  const port = await freePort();
  const shell = new ViewerShellServer({
    host: "127.0.0.1", port, viewerPort: viewer.port, statsPort: stats.port, mode: "public",
    publicState: async () => ({ public: true, connection: { connected: true } }),
    limits,
  });
  await shell.start();
  return {
    port, viewer, stats,
    async close() { shell.stop(); await viewer.close(); await stats.close(); },
  };
}

test("public shell 404s everything outside the viewer allowlist and never reaches the dashboard", async () => {
  const env = await publicShell();
  try {
    const denied: Array<[string, string]> = [
      ["GET", "/health"], ["GET", "/status"], ["POST", "/command"], ["GET", "/command"],
      ["GET", "/ws"], ["GET", "/dashboard.js"], ["GET", "/index.html"], ["GET", "/unknown"],
      ["POST", "/api/state"], ["GET", "/api/state/extra"],
      ["GET", "/viewer/%2e%2e/%2e%2e/package.json"], ["GET", "/viewer/textures/../../../../etc/passwd.png"],
      ["GET", "/viewer/secret.txt"], ["GET", "/viewer/index.html"], ["GET", "/socket.io/socket.io.js"],
      ["PUT", "/viewer/index.js"], ["DELETE", "/"], ["OPTIONS", "/"],
    ];
    for (const [method, path] of denied) {
      const result = await send(env.port, method, path, {}, method === "POST" ? "go home" : undefined);
      assert.equal(result.status, 404, `${method} ${path} → ${result.status}`);
      assert.equal(result.body, "not found");
    }
    assert.equal(env.stats.seen.length, 0, "public shell must never proxy to the dashboard");
    assert.equal(env.viewer.seen.length, 0);
  } finally {
    await env.close();
  }
});

test("public /api/state returns only the redacted payload", async () => {
  const env = await publicShell();
  try {
    const result = await send(env.port, "GET", "/api/state");
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body), { public: true, connection: { connected: true } });
    assert.equal(env.stats.seen.length, 0);
  } finally {
    await env.close();
  }
});

test("public proxy strips client headers, marks requests public and sets security headers", async () => {
  const env = await publicShell();
  try {
    const result = await send(env.port, "GET", "/viewer/", { cookie: "session=1", authorization: "Bearer x", "x-blockhead-owner": "1", "x-forwarded-for": "203.0.113.5" });
    assert.equal(result.status, 200);
    assert.equal(result.headers["x-powered-by"], undefined);
    assert.equal(result.headers["x-content-type-options"], "nosniff");
    assert.match(String(result.headers["content-security-policy"]), /frame-ancestors 'self'/);
    const upstream = env.viewer.seen[0];
    assert.equal(upstream?.url, "/");
    assert.equal(upstream?.headers["x-blockhead-public"], "1");
    for (const header of ["cookie", "authorization", "x-blockhead-owner", "x-forwarded-for"]) assert.equal(upstream?.headers[header], undefined, header);

    const worker = await send(env.port, "GET", "/viewer/worker.js");
    assert.match(String(worker.headers["content-security-policy"]), /'unsafe-eval'/);
    assert.doesNotMatch(String(result.headers["content-security-policy"]), /unsafe-eval/);
    assert.equal((await send(env.port, "GET", "/viewer/textures/1.20.1.png")).status, 200);
    assert.equal((await send(env.port, "GET", "/socket.io/?EIO=4&transport=polling")).status, 200);
    assert.equal((await send(env.port, "GET", "/socket.io/?transport=polling")).status, 404);
    assert.deepEqual(env.viewer.seen.slice(1).map(entry => entry.url), ["/worker.js", "/textures/1.20.1.png", "/socket.io/?EIO=4&transport=polling"]);

    const page = await send(env.port, "GET", "/");
    assert.match(String(page.headers["content-security-policy"]), /frame-ancestors 'none'/);
    assert.equal(page.headers["x-frame-options"], "DENY");
  } finally {
    await env.close();
  }
});

test("public socket POST bodies are size-capped", async () => {
  const env = await publicShell();
  try {
    const big = "x".repeat(9000);
    assert.equal((await send(env.port, "POST", "/socket.io/?EIO=4&transport=polling&sid=a", { "content-length": String(big.length) }, big)).status, 413);
    assert.equal((await send(env.port, "POST", "/socket.io/?EIO=4&transport=polling&sid=a", { "content-length": "2" }, "40")).status, 200);
  } finally {
    await env.close();
  }
});

test("public shell rate-limits HTTP and new socket sessions per client", async () => {
  const env = await publicShell({ httpBurst: 3, httpPerSecond: 0.001, handshakeBurst: 1, handshakePerSecond: 0.001, socketsPerIp: 1, socketsTotal: 1 });
  try {
    const first = await send(env.port, "GET", "/socket.io/?EIO=4&transport=polling", { "x-forwarded-for": "198.51.100.1" });
    const second = await send(env.port, "GET", "/socket.io/?EIO=4&transport=polling", { "x-forwarded-for": "198.51.100.1" });
    assert.deepEqual([first.status, second.status], [200, 429]);
    assert.equal((await send(env.port, "GET", "/", { "x-forwarded-for": "198.51.100.1" })).status, 200);
    assert.equal((await send(env.port, "GET", "/", { "x-forwarded-for": "198.51.100.1" })).status, 429);
    assert.equal((await send(env.port, "GET", "/", { "x-forwarded-for": "198.51.100.2" })).status, 200);
  } finally {
    await env.close();
  }
});
