// Both forms use the same response contract. No automatic retries: a lost
// response may hide a successfully created GitHub issue.
window.setupReportForm = function setupReportForm(form, statusBox, endpoint, successMessage) {
  const button = form.querySelector('button[type="submit"]');
  let submitting = false;
  let uncertain = false;
  let waitUntil = 0;
  const knownCodes = new Set([
    "report_cooldown", "report_window_limit", "report_in_progress", "report_capacity",
    "attempt_limit", "invalid_report", "invalid_request", "unsupported_request", "report_too_large",
    "forbidden_origin", "provider_rate_limit", "delivery_rejected",
    "delivery_unavailable", "delivery_uncertain", "internal_error"
  ]);
  function showStatus(message, isError = false, pending = false) {
    statusBox.textContent = message;
    statusBox.className = pending ? "status pending" : isError ? "status error" : "status success";
  }
  function unknownDelivery() {
    uncertain = true;
    showStatus("Delivery could not be confirmed. Keep your draft and check the issue list or contact support before sending it again; it may already have been created.", true);
  }
  function retrySeconds(response, data) {
    const value = Number(data?.retryAfterSeconds ?? response.headers.get("Retry-After"));
    const seconds = Math.ceil(value);
    return Number.isSafeInteger(seconds) && seconds > 0 && Number.isFinite(new Date(Date.now() + seconds * 1000).getTime()) ? seconds : 0;
  }
  function invalidField() {
    return Array.from(form.querySelectorAll("[maxlength]")).find(field => field.value.trim().length > field.maxLength);
  }
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (submitting || uncertain) return;
    if (Date.now() < waitUntil) {
      showStatus(`Please wait until ${new Date(waitUntil).toLocaleString()} before trying again. Your draft is unchanged.`, true);
      return;
    }
    const field = invalidField();
    if (field) {
      showStatus(`${field.name} must be ${field.maxLength} characters or fewer. Your draft is unchanged.`, true);
      return;
    }
    submitting = true;
    button.disabled = true;
    showStatus("Submitting report...", false, true);
    try {
      const payload = Object.fromEntries(new FormData(form).entries());
      const response = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      let data;
      try { data = await response.json(); } catch { /* A proxy may return HTML. */ }
      if (response.ok && data?.ok === true) {
        form.reset();
        waitUntil = Date.now() + 600000;
        showStatus(`${successMessage} Wait 10 minutes before submitting another report; both forms share the same limit.`);
        return;
      }
      const error = data?.error;
      if (knownCodes.has(error?.code) && typeof error.message === "string" && error.message.length <= 600) {
        uncertain = error.code === "delivery_uncertain" || error.code === "internal_error";
        const seconds = retrySeconds(response, data);
        waitUntil = Date.now() + seconds * 1000;
        const reset = data.resetAt ? new Date(data.resetAt) : new Date(waitUntil);
        const resetText = seconds && !uncertain && Number.isFinite(reset.getTime()) ? ` Wait until ${reset.toLocaleString()} before trying again; the server will check the limits again.` : "";
        showStatus(`${error.message}${resetText} Your draft is unchanged.`, true);
        return;
      }
      if (response.status === 429) {
        const seconds = retrySeconds(response, data) || 60;
        waitUntil = Date.now() + seconds * 1000;
        showStatus(`Too many submission attempts. Try again after ${new Date(waitUntil).toLocaleString()}. Your draft is unchanged.`, true);
        return;
      }
      unknownDelivery();
    } catch {
      unknownDelivery();
    } finally {
      submitting = false;
      button.disabled = uncertain;
    }
  });
};
