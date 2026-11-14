import test from "node:test";
import assert from "node:assert/strict";
import { ExpiryIndex } from "../src/web/expiry-index.js";

function drain(index, time) {
  const items = [];
  let item;
  while ((item = index.popExpired(time)) !== null) items.push(item);
  return items;
}

test("expiry index is inclusive at the boundary and returns the earliest deadlines first", () => {
  const index = new ExpiryIndex();
  index.set("late", 30); index.set("early", 10); index.set("middle", 20);
  assert.equal(index.popExpired(9), null);
  assert.deepEqual(index.popExpired(10), { key: "early", time: 10 });
  assert.deepEqual(drain(index, 30), [{ key: "middle", time: 20 }, { key: "late", time: 30 }]);
  assert.equal(index.size, 0);
});

test("rescheduling and deleting never leaves stale deadlines or grows the index", () => {
  const index = new ExpiryIndex();
  index.set("other", 5000);
  for (let time = 0; time < 1000; time++) index.set("same", time);
  assert.equal(index.size, 2);
  assert.equal(index.popExpired(998), null);
  index.set("same", 10000);
  assert.equal(index.popExpired(1000), null);
  index.set("same", 1);
  assert.deepEqual(index.popExpired(1), { key: "same", time: 1 });
  index.delete("other"); index.delete("missing");
  assert.equal(index.size, 0);
  assert.equal(index.popExpired(20000), null);
});

test("mixed indexed updates/removals match a bounded reference model", () => {
  const index = new ExpiryIndex();
  const expected = new Map();
  let seed = 12345;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let iteration = 0; iteration < 5000; iteration++) {
    const key = `client-${next() % 100}`;
    const action = next() % 3;
    if (action === 0) { index.delete(key); expected.delete(key); }
    else if (action === 1) {
      const time = next() % 10000;
      index.set(key, time); expected.set(key, time);
    } else {
      const now = next() % 10000;
      const item = index.popExpired(now);
      const earliest = Math.min(...expected.values());
      if (earliest > now) assert.equal(item, null);
      else {
        assert.ok(item);
        assert.equal(item.time, earliest);
        assert.equal(expected.get(item.key), earliest);
        expected.delete(item.key);
      }
    }
    assert.equal(index.size, expected.size);
  }
  const remaining = drain(index, Infinity);
  assert.deepEqual(remaining.map(item => item.time), [...expected.values()].sort((a, b) => a - b));
  assert.equal(index.size, 0);
});

test("invalid deadlines cannot enter the expiry index", () => {
  const index = new ExpiryIndex();
  for (const time of [NaN, Infinity, -Infinity, undefined, "100"]) assert.throws(() => index.set("bad", time), TypeError);
  assert.equal(index.size, 0);
});
