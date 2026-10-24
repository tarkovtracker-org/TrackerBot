import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function loadForm(kind, fetch, search = "", transformHtml = html => html) {
  const html = transformHtml(await readFile(new URL(`../web/${kind}/index.html`, import.meta.url), "utf8"));
  const button = { disabled: false };
  const status = { textContent: "", className: "" };
  const form = {
    resetCount: 0,
    addEventListener(name, callback) { this.submit = callback; },
    reset() { this.resetCount++; },
    querySelector() { return button; },
    querySelectorAll() { return Array.from(fields.values()).filter(field => field.maxLength); },
    dataset: { endpoint: `/${kind}` }
  };
  const fields = new Map();
  let time = 0;
  class Clock extends Date { static now() { return time; } }
  const context = vm.createContext({
    document: { getElementById(id) {
      if (id.endsWith("Form")) return form;
      if (id.endsWith("Status")) {
        return html.includes(`id="${id}"`) ? status : null;
      }
      if (!fields.has(id)) fields.set(id, { value: "", options: [] });
      return fields.get(id);
    } },
    window: { location: { search } },
    URLSearchParams, Date: Clock, console: { error() {} },
    FormData: class { entries() { return [["title", "Retained draft"]]; } },
    fetch
  });
  for (const script of html.matchAll(/<script(?=[\s/>])(?:\s+src="([^"]+)")?[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    const code = script[1]
      ? await readFile(new URL(`../web${script[1]}`, import.meta.url), "utf8")
      : script[2];
    vm.runInContext(code, context);
  }
  return { form, status, button, fields, html, setTime(value) { time = value; }, submit: () => form.submit({ preventDefault() {} }) };
}

for (const kind of ["data", "issue"]) {
  test(`${kind}: displays the server's cooldown and retains fields`, async () => {
    const ui = await loadForm(kind, async () => ({
      ok: false, status: 429,
      headers: { get() { return "600"; } },
      async json() { return { error: { code: "report_cooldown", message: "Wait 10 minutes before submitting another report." }, retryAfterSeconds: 600 }; }
    }));
    await ui.submit();
    assert.match(ui.status.textContent, /10 minutes/);
    assert.equal(ui.form.resetCount, 0);
  });
  test(`${kind}: prevents double submission while delivery is pending`, async () => {
    let release;
    let calls = 0;
    const ui = await loadForm(kind, () => { calls++; return new Promise(resolve => { release = resolve; }); });
    const first = ui.submit();
    assert.equal(ui.button.disabled, true);
    assert.equal(ui.status.className, "status pending");
    assert.equal(ui.status.textContent, "Submitting report...");
    const css = await readFile(new URL("../web/styles.css", import.meta.url), "utf8");
    const pendingStyle = css.match(/\.status\.pending\s*\{([^}]+)\}/)?.[1];
    assert.ok(pendingStyle, "pending has an explicit CSS rule");
    assert.match(pendingStyle, /display:\s*block/);
    await ui.submit();
    assert.equal(calls, 1);
    release({ ok: true, async json() { return { ok: true }; } });
    await first;
    assert.equal(ui.form.resetCount, 1);
    assert.equal(ui.status.className, "status success");
  });

  for (const code of ["invalid_report", "invalid_request", "unsupported_request", "report_too_large", "forbidden_origin", "provider_rate_limit", "delivery_rejected", "delivery_unavailable", "report_window_limit"]) {
    test(`${kind}: preserves draft and presents typed ${code} error`, async () => {
      const message = `Safe error for ${code}`;
      const ui = await loadForm(kind, async () => ({ ok: false, status: 400, headers: { get() { return null; } }, async json() { return { error: { code, message } }; } }));
      await ui.submit();
      assert.match(ui.status.textContent, new RegExp(message));
      assert.equal(ui.form.resetCount, 0);
      assert.equal(ui.button.disabled, false);
    });
  }

  for (const type of ["network", "non-json", "malformed-success", "delivery_uncertain"]) {
    test(`${kind}: ${type} keeps draft and blocks automatic repeat`, async () => {
      let calls = 0;
      const ui = await loadForm(kind, async () => {
        calls++;
        if (type === "network") throw new Error("PRIVATE_CONNECTION_DETAIL");
        return { ok: type !== "delivery_uncertain", status: 504, headers: { get() { return null; } }, async json() {
          if (type === "non-json") throw new Error("PRIVATE_PROXY_HTML");
          return type === "delivery_uncertain" ? { error: { code: type, message: "Delivery could not be confirmed. Check before repeating." } } : {};
        } };
      });
      await ui.submit();
      ui.setTime(43200000);
      await ui.submit();
      assert.equal(calls, 1);
      assert.equal(ui.form.resetCount, 0);
      assert.equal(ui.button.disabled, true);
      assert.match(ui.status.textContent, /could not be confirmed/);
      assert.doesNotMatch(ui.status.textContent, /PRIVATE_/);
    });
  }

  test(`${kind}: expired client wait still requires fresh server authorization`, async () => {
    let calls = 0;
    const ui = await loadForm(kind, async () => {
      calls++;
      return { ok: false, status: 429, headers: { get() { return "600"; } }, async json() { return { error: { code: "report_cooldown", message: "Wait 10 minutes." }, retryAfterSeconds: 600 }; } };
    });
    await ui.submit();
    ui.setTime(599999);
    await ui.submit();
    assert.equal(calls, 1);
    ui.setTime(600000);
    await ui.submit();
    assert.equal(calls, 2);
    assert.equal(ui.form.resetCount, 0);
    assert.match(ui.status.textContent, /server will check the limits again/);
  });

  test(`${kind}: length validation catches programmatically filled overlong values`, async () => {
    let calls = 0;
    const ui = await loadForm(kind, async () => { calls++; });
    ui.fields.set("description", { name: "description", value: "x".repeat(8001), maxLength: 8000 });
    await ui.submit();
    assert.equal(calls, 0);
    assert.equal(ui.form.resetCount, 0);
    assert.match(ui.status.textContent, /8000/);
    assert.match(ui.html, /maxlength="8000"/);
    assert.match(ui.html, /aria-live="polite"/);
    assert.match(ui.html, /per client IP/);
    assert.match(ui.html, /Your report, including your Discord handle, reference links and details, is published as a public GitHub issue\./);
  });
}

test("data reports link to the public website issue list, not the private overlay", async () => {
  const ui = await loadForm("data", async () => {});
  assert.match(ui.html, /href="https:\/\/github\.com\/tarkovtracker-org\/TarkovTracker\/issues"/);
  assert.doesNotMatch(ui.html, /href="[^"]*tarkov-data-overlay/);
});

test("browser retains the full provider wait beyond the reporting window", async () => {
  let calls = 0;
  const ui = await loadForm("issue", async () => {
    calls++;
    return { ok: false, status: 503, headers: { get() { return "50000"; } }, async json() { return { error: { code: "provider_rate_limit", message: "Wait for the provider." }, retryAfterSeconds: 50000 }; } };
  });
  await ui.submit();
  ui.setTime(43200000);
  await ui.submit();
  assert.equal(calls, 1);
  assert.equal(ui.form.resetCount, 0);
  assert.equal(ui.button.disabled, false);
});

test("data prefills remain intact, including reference and leading newlines", async () => {
  const search = new URLSearchParams({ title: "Prefilled task", reference: "https://example.test/proof", description: "\n\nObserved details" }).toString();
  const ui = await loadForm("data", async () => {}, `?${search}`);
  assert.equal(ui.fields.get("title").value, "Prefilled task");
  assert.equal(ui.fields.get("reference").value, "https://example.test/proof");
  assert.equal(ui.fields.get("description").value, "\n\nObserved details");
});

test("fixture loads case-insensitive script tags with closing whitespace", async () => {
  const ui = await loadForm("issue", async () => ({
    ok: false, status: 400, headers: { get() { return null; } },
    async json() { return { error: { code: "invalid_report", message: "Keep the draft." } }; }
  }), "", html => html.replaceAll("<script", "<SCRIPT").replaceAll("</script>", "</SCRIPT >"));
  await ui.submit();
  assert.match(ui.status.textContent, /Keep the draft/);
  assert.equal(ui.form.resetCount, 0);
});

test("fixture ignores script-like tag names in HTML and JavaScript strings", async () => {
  const ui = await loadForm("issue", async () => ({
    ok: false, status: 400, headers: { get() { return null; } },
    async json() { return { error: { code: "invalid_report", message: "Keep the draft." } }; }
  }), "", html => html
    .replace("<script>", "<script-custom>Ignored</script-custom><script>")
    .replace("const form =", 'const scriptText = "</script-custom>"; const form ='));
  await ui.submit();
  assert.match(ui.status.textContent, /Keep the draft/);
  assert.equal(ui.form.resetCount, 0);
});
