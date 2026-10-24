import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { ipKeyGenerator } from "express-rate-limit";

// Exercise the limiter's actual dependency, including a nested installation.
const limiterRequire = createRequire(createRequire(import.meta.url).resolve("express-rate-limit"));
const { Address6 } = limiterRequire("ip-address");

// Run potentially blocking validation outside the test runner. The vulnerable
// version takes many seconds on this input; the patch rejects it in milliseconds.
test("oversized IPv6 zones with line terminators are rejected without stalling", () => {
  const result = spawnSync(process.execPath, ["-e", `
    const assert = require('node:assert/strict');
    const { Address6 } = require(${JSON.stringify(limiterRequire.resolve("ip-address"))});
    for (const terminator of ['\\n', '\\r', '\\u2028', '\\u2029']) {
      assert.equal(Address6.isValid('%'.repeat(200000) + terminator), false);
    }
    console.log('rejected all oversized zones');
  `], { cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 2000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /rejected all oversized zones/);
});

test("IPv6 zone parsing and existing limiter address grouping remain compatible", () => {
  assert.equal(new Address6("fe80::1%eth0").zone, "%eth0");
  assert.equal(ipKeyGenerator("::ffff:192.0.2.1"), "192.0.2.1");
  assert.equal(ipKeyGenerator("2001:db8:abcd:1200::1"), ipKeyGenerator("2001:db8:abcd:12ff::2"));
});
