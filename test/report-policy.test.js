import test from "node:test";
import assert from "node:assert/strict";
import { createReportPolicy } from "../src/web/report-policy.js";

function fixture(options = {}) {
  let time = 0;
  const policy = createReportPolicy({ now: () => time, ...options });
  return { policy, setTime(value) { time = value; } };
}
function accept(policy, fingerprint = "report") {
  const admission = policy.reserve("client", fingerprint);
  assert.equal(admission.ok, true);
  admission.settle("accepted");
}

test("10-minute boundary is exclusive before, inclusive at the boundary", () => {
  const { policy, setTime } = fixture();
  accept(policy);
  setTime(599999);
  const denied = policy.reserve("client", "next");
  assert.equal(denied.code, "report_cooldown");
  assert.equal(denied.retryAfterSeconds, 1);
  setTime(600000);
  accept(policy, "next");
});

test("20th accepted; 21st blocked until the oldest rolling event expires", () => {
  const { policy, setTime } = fixture();
  for (let index = 0; index < 20; index++) {
    setTime(index * 600000);
    accept(policy, `report-${index}`);
  }
  setTime(12000000);
  const rejected = policy.reserve("client", "21st");
  assert.equal(rejected.code, "report_window_limit");
  assert.equal(rejected.retryAfterSeconds, 31200);
  setTime(43199999);
  assert.equal(policy.reserve("client", "21st").retryAfterSeconds, 1);
  setTime(43200000);
  accept(policy, "21st");
  assert.equal(policy.reserve("client", "22nd").code, "report_window_limit");
});

test("overlapping window and cooldown returns the longest wait", () => {
  const { policy, setTime } = fixture();
  for (let index = 0; index < 19; index++) {
    setTime(index * 600000);
    accept(policy, `report-${index}`);
  }
  setTime(42900000); // 11h55: oldest expires in 5m; latest cooldown in 10m.
  accept(policy, "20th");
  const denied = policy.reserve("client", "21st");
  assert.equal(denied.code, "report_window_limit");
  assert.equal(denied.retryAfterSeconds, 600);
  setTime(43200000);
  assert.equal(policy.reserve("client", "21st").retryAfterSeconds, 300);
  setTime(43500000);
  accept(policy, "21st");
});

test("attempt allowance has an exact rolling minute boundary", () => {
  const { policy, setTime } = fixture();
  for (let index = 0; index < 5; index++) assert.equal(policy.attempt("client").ok, true);
  assert.equal(policy.attempt("client").code, "attempt_limit");
  setTime(59999);
  assert.equal(policy.attempt("client").retryAfterSeconds, 1);
  setTime(60000);
  assert.equal(policy.attempt("client").ok, true);
});

test("attempt and cooldown overlap chooses either longest constraint", () => {
  const { policy, setTime } = fixture();
  accept(policy);
  for (let index = 0; index < 6; index++) assert.equal(policy.attempt("client").retryAfterSeconds, 600);
  setTime(599000);
  for (let index = 0; index < 5; index++) assert.equal(policy.attempt("client").code, "report_cooldown");
  const attempts = policy.attempt("client");
  assert.equal(attempts.code, "attempt_limit");
  assert.equal(attempts.retryAfterSeconds, 60);
});

test("pending reservation blocks concurrent calls; failure releases allowance", () => {
  const { policy } = fixture();
  const first = policy.reserve("client", "first");
  assert.equal(policy.reserve("client", "second").code, "report_in_progress");
  first.settle("failed");
  accept(policy, "second");
  first.settle("accepted"); // stale/double settlement cannot mutate the successor.
  assert.equal(policy.reserve("client", "third").code, "report_cooldown");
});

test("uncertain outcome reserves capacity and bounded same-report protection", () => {
  const { policy, setTime } = fixture();
  const pending = policy.reserve("client", "uncertain");
  pending.settle("uncertain");
  assert.equal(policy.reserve("client", "different").code, "report_cooldown");
  setTime(600000);
  assert.equal(policy.reserve("client", "uncertain").code, "delivery_uncertain");
  accept(policy, "different");
  setTime(43200000);
  accept(policy, "uncertain");
});

test("client state is bounded, expires, and is explicitly process-local", () => {
  const { policy, setTime } = fixture({ maxClients: 1 });
  policy.reserve("first", "report").settle("accepted");
  assert.equal(policy.reserve("other", "report").code, "report_capacity");
  setTime(43200000);
  assert.equal(policy.reserve("other", "report").ok, true);
  const restarted = createReportPolicy();
  assert.equal(restarted.reserve("first", "report").ok, true);
});

test("cooldown starts at delivery completion rather than reservation", () => {
  const { policy, setTime } = fixture();
  const admission = policy.reserve("client", "first");
  setTime(10000);
  admission.settle("accepted");
  setTime(609999);
  assert.equal(policy.reserve("client", "next").retryAfterSeconds, 1);
  setTime(610000);
  accept(policy, "next");
});
