import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";

// Exercise Axios's actual dependency, even when it is nested rather than hoisted.
const axiosRequire = createRequire(createRequire(import.meta.url).resolve("axios"));
const followRedirects = axiosRequire("follow-redirects");

async function redirectedHeaders(t, headers, sensitiveHeaders = []) {
  let received;
  const target = http.createServer((req, res) => {
    received = req.headers;
    res.end("ok");
  });
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  const origin = http.createServer((req, res) => {
    req.resume();
    res.writeHead(302, { Location: `http://127.0.0.1:${target.address().port}/` });
    res.end();
  });
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  t.after(async () => {
    for (const server of [origin, target]) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
  if (Array.isArray(headers)) {
    headers = ["Host", `127.0.0.1:${origin.address().port}`, ...headers];
  }
  await new Promise((resolve, reject) => {
    const request = followRedirects.http.get({
      protocol: "http:", hostname: "127.0.0.1", port: origin.address().port,
      path: "/", headers, sensitiveHeaders
    }, response => {
      response.resume();
      response.on("end", resolve);
      response.on("error", reject);
    });
    request.on("error", reject);
  });
  assert.ok(received, "the redirected target must receive a request");
  return received;
}

test("redirects strip array-form credentials across origins", { timeout: 5000 }, async t => {
  const headers = await redirectedHeaders(t, ["Authorization", "test-marker", "Cookie", "test-cookie", "Proxy-Authorization", "test-proxy"]);
  for (const name of ["authorization", "cookie", "proxy-authorization"]) {
    assert.equal(headers[name], undefined, `${name} must not cross origins`);
  }
});

test("redirects strip sensitive header names containing regex metacharacters", { timeout: 5000 }, async t => {
  const headers = await redirectedHeaders(t, {
    "X-Api^Key": "test-marker", "X-Token|Secret": "test-marker", "X-Control": "preserved"
  }, ["X-Api^Key", "X-Token|Secret"]);
  assert.equal(headers["x-api^key"], undefined);
  assert.equal(headers["x-token|secret"], undefined);
  assert.equal(headers["x-control"], "preserved");
});
