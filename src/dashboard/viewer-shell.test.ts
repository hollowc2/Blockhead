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
