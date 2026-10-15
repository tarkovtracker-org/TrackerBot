import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createReportApp } from "../src/web/report-app.js";

const fields = { title: "Test report", discord: "Test reporter", category: "Other", description: "Test observation", reference: "" };
async function fixture(t, githubPost = async () => ({ status: 201 })) {
  let time = 0;
  const calls = [];
  const logs = [];
  const app = createReportApp({
    env: { GITHUB_TOKEN: "test-only-key", REPO_DEV: "example/dev", REPO_DATA_REPORT: "example/data", ALLOWED_ORIGINS: "https://example.test" },
    now: () => time,
    logger: { error(...args) { logs.push(args); } },
    githubPost(...args) { calls.push(args); return githubPost(...args); }
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    app, calls, logs, setTime(value) { time = value; },
    async post(route = "data", body = fields, extra = {}) {
      const response = await fetch(`${base}/${route}`, {
        method: "POST", headers: { "Content-Type": "application/json", Origin: "https://example.test", ...extra },
        body: typeof body === "string" ? body : JSON.stringify(body)
      });
      return { status: response.status, headers: response.headers, body: await response.json() };
    }
  };
}

test("both routes share delivered-report policy and keep destination routing", async t => {
  const api = await fixture(t);
  assert.equal((await api.post()).status, 200);
  const blocked = await api.post("issue");
  assert.equal(blocked.body.error.code, "report_cooldown");
  assert.equal(blocked.headers.get("Retry-After"), "600");
  api.setTime(600000);
  assert.equal((await api.post("issue")).status, 200);
  assert.equal(api.calls[0][0], "https://api.github.com/repos/example/data/issues");
  assert.equal(api.calls[1][0], "https://api.github.com/repos/example/dev/issues");
});

test("HTTP 20th/21st and rolling boundary across mixed routes", async t => {
  const api = await fixture(t);
  for (let index = 0; index < 20; index++) {
    api.setTime(index * 600000);
    assert.equal((await api.post(index % 2 ? "issue" : "data")).status, 200);
  }
  api.setTime(12000000);
  const rejected = await api.post();
  assert.equal(rejected.status, 429);
  assert.equal(rejected.body.error.code, "report_window_limit");
  assert.equal(rejected.headers.get("Retry-After"), "31200");
  assert.equal(api.calls.length, 20);
  api.setTime(43200000);
  assert.equal((await api.post()).status, 200);
});

test("all three budgets overlap: header and reset use the longest wait", async t => {
  const api = await fixture(t);
  for (let index = 0; index < 19; index++) {
    api.setTime(index * 600000);
    await api.post();
  }
  api.setTime(42900000);
  await api.post();
  for (let index = 0; index < 6; index++) {
    const result = await api.post("issue");
    assert.equal(result.body.error.code, "report_window_limit");
    assert.equal(result.headers.get("Retry-After"), "600");
    assert.equal(Date.parse(result.body.resetAt), 43500000);
  }
});

test("a pending GitHub call admits only one concurrent report", async t => {
  let release;
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  const api = await fixture(t, () => { started(); return new Promise(resolve => { release = resolve; }); });
  const first = api.post();
  await waiting;
  const second = await api.post("issue");
  assert.equal(second.body.error.code, "report_in_progress");
  assert.equal(api.calls.length, 1);
  release({ status: 201 });
  assert.equal((await first).status, 200);
});

test("validation, parser and honeypot rejections consume no report allowance", async t => {
  const api = await fixture(t);
  assert.equal((await api.post("data", { ...fields, title: "" })).body.error.code, "invalid_report");
  assert.equal((await api.post("issue", { ...fields, title: { unsafe: true } })).status, 400);
  assert.equal((await api.post("issue", "{invalid")).body.error.code, "invalid_request");
  assert.equal((await api.post("data", { ...fields, company: "bot" })).status, 200);
  assert.equal((await api.post()).status, 200);
  assert.equal(api.calls.length, 1);
});

test("invalid attempts are bounded across both routes", async t => {
  const api = await fixture(t);
  for (let index = 0; index < 5; index++) {
    assert.equal((await api.post(index % 2 ? "issue" : "data", {})).status, 400);
  }
  const blocked = await api.post();
  assert.equal(blocked.body.error.code, "attempt_limit");
  assert.equal(blocked.headers.get("Retry-After"), "60");
  api.setTime(60000);
  assert.equal((await api.post()).status, 200);
});

test("length errors replace truncation and oversized parser errors are safe", async t => {
  const api = await fixture(t);
  const long = await api.post("data", { ...fields, description: "x".repeat(8001) });
  assert.equal(long.body.error.code, "invalid_report");
  assert.match(long.body.error.message, /8000/);
  assert.equal((await api.post("data", { ...fields, description: "x".repeat(33000) })).body.error.code, "report_too_large");
  assert.equal((await api.post("data", { ...fields, description: "x".repeat(8000) })).status, 200);
});

test("origin checks and single-hop trust remain unchanged", async t => {
  const api = await fixture(t);
  assert.equal(api.app.get("trust proxy"), 1);
  assert.equal((await api.post("data", fields, { Origin: "https://example.test.evil.invalid" })).body.error.code, "forbidden_origin");
  assert.equal(api.calls.length, 0);
  assert.equal((await api.post()).status, 200);
});

test("IP normalization covers mapped IPv4, IPv6 notation and existing /56 grouping", async t => {
  const api = await fixture(t);
  assert.equal((await api.post("data", fields, { "X-Forwarded-For": "192.0.2.1" })).status, 200);
  assert.equal((await api.post("issue", fields, { "X-Forwarded-For": "::ffff:c000:201" })).body.error.code, "report_cooldown");
  assert.equal((await api.post("data", fields, { "X-Forwarded-For": "2001:db8:abcd:1200::1" })).status, 200);
  assert.equal((await api.post("issue", fields, { "X-Forwarded-For": "2001:0db8:abcd:12ff:0:0:0:2" })).body.error.code, "report_cooldown");
});

for (const status of [401, 403, 404, 422, 429]) {
  test(`confirmed GitHub ${status} rejection releases report allowance`, async t => {
    let reject = true;
    const api = await fixture(t, async () => {
      if (reject) throw { response: { status, headers: { "retry-after": "120" }, data: "PRIVATE_PROVIDER_BODY" }, message: "PRIVATE_PROVIDER_MESSAGE" };
      return { status: 201 };
    });
    const failure = await api.post();
    assert.notEqual(failure.body.error.code, "delivery_uncertain");
    if (status === 429 || status === 403) assert.equal(failure.headers.get("Retry-After"), "120");
    reject = false;
    assert.equal((await api.post()).status, 200);
    assert.doesNotMatch(JSON.stringify([failure, api.logs]), /PRIVATE_PROVIDER/);
  });
}

for (const failure of [{ code: "ECONNABORTED" }, { code: "ECONNRESET" }, ...[500, 502, 503, 504].map(status => ({ response: { status } }))]) {
  test(`ambiguous ${failure.code ?? failure.response.status} cannot automatically repeat a report`, async t => {
    const api = await fixture(t, async () => { throw { ...failure, message: "PRIVATE_DESCRIPTION", config: { headers: { Authorization: "PRIVATE_SECRET" } } }; });
    const result = await api.post();
    assert.equal(result.body.error.code, "delivery_uncertain");
    api.setTime(600000);
    assert.equal((await api.post()).status, 409);
    assert.equal(api.calls.length, 1);
    assert.doesNotMatch(JSON.stringify([result, api.logs]), /PRIVATE_DESCRIPTION|PRIVATE_SECRET|Test observation|127\.0\.0\.1/);
  });
}

test("proven connection failure releases quota and supplies safe retry guidance", async t => {
  let fail = true;
  const api = await fixture(t, async () => {
    if (fail) throw { code: "ENOTFOUND" };
    return { status: 201 };
  });
  assert.equal((await api.post()).headers.get("Retry-After"), "60");
  fail = false;
  assert.equal((await api.post()).status, 200);
});

test("unexpected successful provider status is not acknowledged as issue creation", async t => {
  const api = await fixture(t, async () => ({ status: 200 }));
  assert.equal((await api.post()).body.error.code, "delivery_uncertain");
});

test("null provider errors release pending state into uncertainty, not a permanent lock", async t => {
  const api = await fixture(t, async () => { throw null; });
  assert.equal((await api.post()).body.error.code, "delivery_uncertain");
  api.setTime(600000);
  assert.equal((await api.post()).status, 409);
});

test("case and trailing slash aliases preserve their matched route destination", async t => {
  const api = await fixture(t);
  assert.equal((await api.post("DATA/")).status, 200);
  assert.equal(api.calls[0][0], "https://api.github.com/repos/example/data/issues");
  api.setTime(600000);
  assert.equal((await api.post("ISSUE/")).status, 200);
  assert.equal(api.calls[1][0], "https://api.github.com/repos/example/dev/issues");
});

test("uncertain dedupe also covers equivalent route spellings", async t => {
  const api = await fixture(t, async () => { throw { code: "ECONNABORTED" }; });
  await api.post();
  api.setTime(600000);
  assert.equal((await api.post("DATA/")).status, 409);
  assert.equal(api.calls.length, 1);
});

for (const scenario of [
  { name: "primary reset", status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "3600" }, seconds: 3600 },
  { name: "full Retry-After", status: 429, headers: { "retry-after": "7200" }, seconds: 7200 },
  { name: "longest provider reset", status: 403, headers: { "retry-after": "120", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "3600" }, seconds: 3600 },
  { name: "secondary throttle without header", status: 403, headers: {}, message: "You have exceeded a secondary rate limit. PRIVATE_PROVIDER_DETAIL", seconds: 60 }
]) {
  test(`GitHub ${scenario.name} returns full safe provider wait`, async t => {
    const api = await fixture(t, async () => { throw { response: { status: scenario.status, headers: scenario.headers, data: { message: scenario.message } } }; });
    const result = await api.post();
    assert.equal(result.body.error.code, "provider_rate_limit");
    assert.equal(result.headers.get("Retry-After"), String(scenario.seconds));
    assert.equal(result.body.retryAfterSeconds, scenario.seconds);
    assert.equal(Date.parse(result.body.resetAt), scenario.seconds * 1000);
    assert.doesNotMatch(JSON.stringify([result, api.logs]), /PRIVATE_PROVIDER_DETAIL/);
  });
}

test("fifth cooldown rejection advertises the newly exhausted attempt wait", async t => {
  const api = await fixture(t);
  await api.post();
  api.setTime(599000);
  for (let index = 0; index < 4; index++) {
    assert.equal((await api.post()).headers.get("Retry-After"), "1");
  }
  const fifth = await api.post();
  assert.equal(fifth.body.error.code, "attempt_limit");
  assert.equal(fifth.headers.get("Retry-After"), "60");
  assert.equal(Date.parse(fifth.body.resetAt), 659000);
  api.setTime(659000);
  assert.equal((await api.post()).status, 200);
});

for (const scenario of [
  { name: "parameter overflow", body: Array.from({ length: 1001 }, (_, index) => `p${index}=x`).join("&"), headers: { "Content-Type": "application/x-www-form-urlencoded" }, status: 413, code: "report_too_large" },
  { name: "unsupported JSON charset", body: "{}", headers: { "Content-Type": "application/json; charset=shift_jis" }, status: 415, code: "unsupported_request" },
  { name: "unsupported form charset", body: "title=test", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=shift_jis" }, status: 415, code: "unsupported_request" },
  { name: "unsupported encoding", body: "{}", headers: { "Content-Encoding": "compress" }, status: 415, code: "unsupported_request" },
  { name: "excessive form nesting", body: `a${"[b]".repeat(40)}=x`, headers: { "Content-Type": "application/x-www-form-urlencoded" }, status: 400, code: "invalid_request" }
]) {
  test(`parser ${scenario.name} is a retryable client error without delivery`, async t => {
    const api = await fixture(t);
    assert.ok(Buffer.byteLength(scenario.body) < 32768);
    const result = await api.post("data", scenario.body, scenario.headers);
    assert.equal(result.status, scenario.status);
    assert.equal(result.body.error.code, scenario.code);
    assert.equal(api.calls.length, 0);
    assert.equal(api.logs.length, 0);
    assert.equal((await api.post()).status, 200);
  });
}
