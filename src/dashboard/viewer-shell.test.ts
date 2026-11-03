import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SHELL_SECURITY_HEADERS } from "./http-guard.js";
import { DEFAULT_PUBLIC_LIMITS, isViewerSocketPath, ViewerShellServer, viewerTargetPath } from "./viewer-shell.js";

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

async function publicShell(limits?: ConstructorParameters<typeof ViewerShellServer>[0]["limits"], publicMinimap?: () => Promise<unknown>) {
  const viewer = await recordingServer("viewer-body");
  const stats = await recordingServer("FULL-PRIVATE-STATE");
  const port = await freePort();
  const shell = new ViewerShellServer({
    host: "127.0.0.1", port, viewerPort: viewer.port, statsPort: stats.port, mode: "public",
    publicState: async () => ({ public: true, connection: { connected: true } }),
    limits, publicMinimap,
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
      assert.equal(result.status, path.includes("..") || path.includes("%2e") ? 400 : 404, `${method} ${path} → ${result.status}`);
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

test("private /api/chat answers same-origin JSON questions and guards everything else", async () => {
  const asked: unknown[] = [];
  const port = await freePort();
  const shell = new ViewerShellServer({
    host: "127.0.0.1", port, viewerPort: 1, statsPort: 1,
    chat: async (question) => { asked.push(question); return { ok: true, answer: "I'm mining." }; },
  });
  await shell.start();
  try {
    const json = { "content-type": "application/json" };
    const ok = await send(port, "POST", "/api/chat", { ...json, origin: `http://127.0.0.1:${port}` }, JSON.stringify({ question: "what are you doing?" }));
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { answer: "I'm mining." });
    assert.equal(ok.headers["cache-control"], "no-store");

    assert.equal((await send(port, "GET", "/api/chat")).status, 405);
    assert.equal((await send(port, "POST", "/api/chat", { "content-type": "text/plain" }, "{\"question\":\"hi\"}")).status, 415);
    assert.equal((await send(port, "POST", "/api/chat", { ...json, origin: "https://evil.example" }, "{\"question\":\"hi\"}")).status, 403);
    assert.equal((await send(port, "POST", "/api/chat", json, JSON.stringify({ question: "x".repeat(4000) }))).status, 413);
    assert.deepEqual(asked, ["what are you doing?"], "guarded requests never reach the LLM");

    const malformed = await send(port, "POST", "/api/chat", json, "not json");
    assert.equal(malformed.status, 200, "the chat handler validates the (missing) question itself");
    assert.deepEqual(asked.at(-1), undefined);
  } finally {
    shell.stop();
  }
});

test("chat errors keep their status and message", async () => {
  const port = await freePort();
  const shell = new ViewerShellServer({
    host: "127.0.0.1", port, viewerPort: 1, statsPort: 1,
    chat: async () => ({ ok: false, status: 429, error: "slow down" }),
  });
  await shell.start();
  try {
    const result = await send(port, "POST", "/api/chat", { "content-type": "application/json" }, "{\"question\":\"hi\"}");
    assert.equal(result.status, 429);
    assert.deepEqual(JSON.parse(result.body), { error: "slow down" });
  } finally {
    shell.stop();
  }
});

test("public shell never exposes /api/chat even when a chat handler is supplied", async () => {
  let called = false;
  const port = await freePort();
  const shell = new ViewerShellServer({
    host: "127.0.0.1", port, viewerPort: 1, statsPort: 1, mode: "public",
    publicState: async () => ({}),
    chat: async () => { called = true; return { ok: true, answer: "leak" }; },
  });
  await shell.start();
  try {
    const result = await send(port, "POST", "/api/chat", { "content-type": "application/json" }, "{\"question\":\"hi\"}");
    assert.equal(result.status, 404);
    assert.equal(called, false);
  } finally {
    shell.stop();
  }
});

test("private task submission delivers owner instructions and rejects cross-site and public traffic", async () => {
  const commands: unknown[] = [];
  const port = await freePort();
  const shell = new ViewerShellServer({ host: "127.0.0.1", port, viewerPort: 1, statsPort: 1,
    command: async (command) => { commands.push(command); return { ok: true, answer: "Sent." }; },
  });
  await shell.start();
  try {
    const json = { "content-type": "application/json", origin: `https://127.0.0.1:${port}` };
    const body = JSON.stringify({ command: "gather 32 oak logs" });
    const accepted = await send(port, "POST", "/api/command", json, body);
    assert.equal(accepted.status, 200);
    assert.deepEqual(JSON.parse(accepted.body), { answer: "Sent." });
    const rejectedHeaders: Array<Record<string, string>> = [{ origin: "https://evil.example" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }, { "x-blockhead-public": "1" }];
    for (const headers of rejectedHeaders) {
      assert.equal((await send(port, "POST", "/api/command", { ...json, ...headers }, body)).status, 403);
    }
    assert.equal((await send(port, "GET", "/api/command")).status, 405);
    assert.equal((await send(port, "POST", "/api/command", { "content-type": "text/plain" }, body)).status, 415);
    assert.equal((await send(port, "POST", "/api/command", json, JSON.stringify({ command: "x".repeat(3000) }))).status, 413);
    assert.deepEqual(commands, ["gather 32 oak logs"]);
  } finally { shell.stop(); }
});

test("public viewer never exposes task delivery even with a handler supplied", async () => {
  let calls = 0;
  const port = await freePort();
  const shell = new ViewerShellServer({ host: "127.0.0.1", port, viewerPort: 1, statsPort: 1, mode: "public",
    command: async () => { calls++; return { ok: true, answer: "Sent." }; },
  });
  await shell.start();
  try {
    for (const path of ["/api/command", "/api/command?x=1", "/command"]) {
      assert.equal((await send(port, "POST", path, { "content-type": "application/json" }, '{"command":"stop"}')).status, 404);
    }
    assert.equal(calls, 0);
  } finally { shell.stop(); }
});

const BROADCAST_ASSETS: ReadonlyArray<[string, RegExp]> = [
  ["/broadcast", /^text\/html/], ["/broadcast.css", /^text\/css/], ["/broadcast.js", /^text\/javascript/],
  ["/broadcast-panels.mjs", /^text\/javascript/], ["/broadcast-minimap.mjs", /^text\/javascript/], ["/broadcast-scenes.mjs", /^text\/javascript/],
  ["/viewer-session.mjs", /^text\/javascript/],
];

test("broadcast page and its assets are served on both listeners with the shell's security headers", async () => {
  const env = await publicShell();
  const privatePort = await freePort();
  const privateShell = new ViewerShellServer({ host: "127.0.0.1", port: privatePort, viewerPort: env.viewer.port, statsPort: env.stats.port });
  await privateShell.start();
  try {
    for (const port of [env.port, privatePort]) {
      for (const [path, type] of BROADCAST_ASSETS) {
        const result = await send(port, "GET", path);
        assert.equal(result.status, 200, `${port} ${path}`);
        assert.match(String(result.headers["content-type"]), type, path);
        assert.equal(result.headers["cache-control"], "no-store");
        for (const [header, value] of Object.entries(SHELL_SECURITY_HEADERS)) assert.equal(result.headers[header], value, `${path} ${header}`);
      }
    }
    assert.equal(env.stats.seen.length + env.viewer.seen.length, 0, "static assets never reach the dashboard or viewer");
  } finally {
    privateShell.stop();
    await env.close();
  }
});

test("public broadcast routes are exact: no index, directory or method variants", async () => {
  const env = await publicShell();
  try {
    for (const path of ["/broadcast/", "/broadcast.html", "/broadcast/index.html", "/broadcast.js.map", "/broadcast-scenes.js", "/broadcast-scenes.d.mts", "/broadcast-panels.d.mts", "/Broadcast"]) {
      assert.equal((await send(env.port, "GET", path)).status, 404, path);
    }
    for (const method of ["POST", "PUT", "DELETE"]) assert.equal((await send(env.port, method, "/broadcast")).status, 404, method);
    assert.equal(env.stats.seen.length + env.viewer.seen.length, 0);
  } finally {
    await env.close();
  }
});

test("broadcast page keeps the renderer contract and loads only same-origin assets", async () => {
  const dir = fileURLToPath(new URL("./public/", import.meta.url));
  const [html = "", css = "", js = "", panels = "", minimap = "", scenes = ""] = await Promise.all(["broadcast.html", "broadcast.css", "broadcast.js", "broadcast-panels.mjs", "broadcast-minimap.mjs", "broadcast-scenes.mjs"].map(name => readFile(dir + name, "utf8")));
  // tools/stream/renderer.mjs probes `.stage iframe` and `#viewerStatus`; it never presses T, so the page follows by itself.
  assert.match(html, /<section class="stage"[^>]*>\s*<iframe\b/);
  assert.equal(html.match(/<iframe\b/g)?.length, 1, "the rAF probe reads the first .stage iframe");
  assert.match(html, /id="viewerStatus"/);
  assert.match(html, /<span id="followToggle" aria-pressed="true"/);
  // The scene machine picks the camera shot; follow is the fallback and where it starts.
  assert.match(js, /"bob-cam", \{ detail: scenes\.camera \?\? "follow" \}/);
  for (const slot of ["now", "thinking", "build", "brain", "minimap"]) assert.match(html, new RegExp(`data-panel="${slot}"`), slot);
  // No CDN, font or image from anywhere else; the SVG namespace is the only URL.
  for (const [name, source] of [["html", html], ["css", css], ["js", js], ["panels", panels], ["minimap", minimap], ["scenes", scenes]] as const) {
    assert.deepEqual(source.match(/https?:\/\/[^\s"')]+/g)?.filter(url => url !== "http://www.w3.org/2000/svg") ?? [], [], name);
    assert.doesNotMatch(source, /@import|@font-face|\bstyle="/, name);
  }
  assert.deepEqual(html.match(/<script\b[^>]*>/g), ['<script type="module" src="/broadcast.js">'], "no inline script");
  // Every module the page imports is one the server serves.
  const imports = [...js.matchAll(/(?:from |import\()"\.\/([^"]+)"/g)].map(match => `/${match[1]}`);
  assert.deepEqual(imports.sort(), ["/broadcast-minimap.mjs", "/broadcast-panels.mjs", "/broadcast-scenes.mjs", "/viewer-session.mjs"]);
  assert.doesNotMatch(minimap, /\bimport\b/, "the minimap module stands alone");
  // The scene module is pure: it imports only the panel helpers and touches no DOM, network or timers.
  assert.deepEqual([...scenes.matchAll(/\bfrom "([^"]+)"/g)].map(match => match[1]), ["./broadcast-panels.mjs"]);
  assert.doesNotMatch(scenes, /\b(?:document|window|fetch|setTimeout|setInterval|Date\.now)\b/);
  for (const path of imports) assert(BROADCAST_ASSETS.some(([served]) => served === path), path);
});

const MINIMAP = { dimension: "overworld", radius: 12, heading: 4, trail: [[-2, 1], [-1, 0], [0, 0]], home: { bearing: 6 } };

test("public and private /api/public/minimap serve the projection with the shell's headers", async () => {
  let reads = 0;
  const source = async () => { reads++; return MINIMAP; };
  const env = await publicShell(undefined, source);
  const privatePort = await freePort();
  const privateShell = new ViewerShellServer({ host: "127.0.0.1", port: privatePort, viewerPort: env.viewer.port, statsPort: env.stats.port, publicMinimap: source });
  await privateShell.start();
  try {
    for (const port of [env.port, privatePort]) {
      const result = await send(port, "GET", "/api/public/minimap");
      assert.equal(result.status, 200, String(port));
      assert.deepEqual(JSON.parse(result.body), MINIMAP);
      assert.match(String(result.headers["content-type"]), /^application\/json/);
      assert.equal(result.headers["cache-control"], "no-store");
      for (const [header, value] of Object.entries(SHELL_SECURITY_HEADERS)) assert.equal(result.headers[header], value, header);
    }
    assert.equal(reads, 2);
    // Only GET, and only the exact path.
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) assert.equal((await send(env.port, method, "/api/public/minimap", {}, method === "POST" ? "{}" : undefined)).status, 404, method);
    assert.equal((await send(privatePort, "POST", "/api/public/minimap", {}, "{}")).status, 405);
    for (const path of ["/api/public/minimap/", "/api/public/minimap.json", "/api/public/Minimap", "/api/public/map", "/api/map"]) assert.equal((await send(env.port, "GET", path)).status, 404, path);
    assert.equal(reads, 2);
    assert.equal(env.stats.seen.length + env.viewer.seen.length, 0, "the minimap never reaches the dashboard or viewer");
  } finally {
    privateShell.stop();
    await env.close();
  }
});

test("/api/public/minimap answers 503 while unavailable and 404 when not configured", async () => {
  let answer: () => unknown = () => null;
  const env = await publicShell(undefined, async () => answer());
  const bare = await publicShell();
  try {
    let result = await send(env.port, "GET", "/api/public/minimap");
    assert.equal(result.status, 503);
    assert.deepEqual(JSON.parse(result.body), { error: "unavailable" });
    assert.equal(result.headers["cache-control"], "no-store");
    for (const [header, value] of Object.entries(SHELL_SECURITY_HEADERS)) assert.equal(result.headers[header], value, header);
    answer = () => { throw new Error("SELECT failed at x=123457"); };
    result = await send(env.port, "GET", "/api/public/minimap");
    assert.equal(result.status, 503);
    assert.doesNotMatch(result.body, /123457|SELECT/);
    assert.equal((await send(bare.port, "GET", "/api/public/minimap")).status, 404);
  } finally {
    await env.close();
    await bare.close();
  }
});

test("/api/public/minimap shares the public listener's per-client rate limit", async () => {
  let reads = 0;
  const env = await publicShell({ ...DEFAULT_PUBLIC_LIMITS, httpBurst: 2, httpPerSecond: 0.001 }, async () => { reads++; return MINIMAP; });
  try {
    const client = { "x-forwarded-for": "198.51.100.7" };
    assert.equal((await send(env.port, "GET", "/api/public/minimap", client)).status, 200);
    assert.equal((await send(env.port, "GET", "/broadcast", client)).status, 200);
    const limited = await send(env.port, "GET", "/api/public/minimap", client);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers["retry-after"], "30");
    assert.equal(reads, 1, "a limited request never reads the map");
    assert.equal((await send(env.port, "GET", "/api/public/minimap", { "x-forwarded-for": "198.51.100.8" })).status, 200);
  } finally {
    await env.close();
  }
});
