export const REPORT_WINDOW_MS = 12 * 60 * 60 * 1000;
export const REPORT_INTERVAL_MS = 10 * 60 * 1000;
export const REPORT_LIMIT = 20;
const ATTEMPT_WINDOW_MS = 60_000;
const ATTEMPT_LIMIT = 5;

function denied(code, message, resetAt, now) {
  return {
    ok: false, code, message,
    retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
    resetAt: new Date(resetAt).toISOString()
  };
}

// One Node process only. Reservation and settlement are synchronous, including
// reservation before asynchronous delivery; there is no persistent store.
export function createReportPolicy({ now = Date.now, maxClients = 10_000 } = {}) {
  const clients = new Map();
  let lastSweep = -Infinity;
  function prune(state, time) {
    state.events = state.events.filter(event => event.time > time - REPORT_WINDOW_MS);
    state.attempts = state.attempts.filter(attempt => attempt > time - ATTEMPT_WINDOW_MS);
  }
  function sweep(time, interval) {
    if (time - lastSweep < interval) return;
    lastSweep = time;
    for (const [key, state] of clients) {
      prune(state, time);
      if (!state.pending && !state.events.length && !state.attempts.length) clients.delete(key);
    }
  }
  function stateFor(key, time) {
    // Reclaim expired entries promptly at capacity, but never evict an active
    // attempt budget, delivered allowance, pending reservation or uncertain hold.
    sweep(time, clients.size >= maxClients ? 1000 : 60_000);
    let state = clients.get(key);
    if (!state) {
      if (clients.size >= maxClients) {
        return denied("report_capacity", "The report service is busy. Keep your draft and wait one minute.", time + 60_000, time);
      }
      state = { events: [], attempts: [], pending: null };
      clients.set(key, state);
    }
    prune(state, time);
    return state;
  }
  function blocked(state, time, fingerprint) {
    const previous = state.events.at(-1);
    const cooldownEnd = previous ? previous.time + REPORT_INTERVAL_MS : time;
    const windowEnd = state.events.length >= REPORT_LIMIT ? state.events[0].time + REPORT_WINDOW_MS : time;
    const pendingEnd = state.pending ? time + 10_000 : time;
    const reset = Math.max(cooldownEnd, windowEnd, pendingEnd);
    const uncertain = fingerprint && state.events.find(event => event.outcome === "uncertain" && event.fingerprint === fingerprint);
    if (uncertain) {
      return denied("delivery_uncertain", "Delivery of this report could not be confirmed. Check the issue list or contact support before repeating it; automatic retries could create duplicates.", Math.max(uncertain.time + REPORT_WINDOW_MS, reset), time);
    }
    if (state.events.length >= REPORT_LIMIT) {
      return denied("report_window_limit", "The shared limit of 20 reports in a rolling 12-hour window has been reached. The displayed wait also includes any remaining 10-minute cooldown.", reset, time);
    }
    if (state.pending) {
      return denied("report_in_progress", "A report is already being submitted from this connection. Wait for its result.", reset, time);
    }
    if (previous && time < previous.time + REPORT_INTERVAL_MS) {
      return denied("report_cooldown", "Wait 10 minutes between reports. Both report forms share this cooldown.", reset, time);
    }
    return null;
  }
  function attempt(key) {
    const time = now();
    const state = stateFor(key, time);
    if (state.ok === false) return state;
    const reportingBlock = blocked(state, time);
    const exhausted = state.attempts.length >= ATTEMPT_LIMIT;
    if (!exhausted) state.attempts.push(time);
    // An eligible fifth attempt still passes. A rejected fifth attempt must
    // advertise the wait its newly exhausted attempt budget imposes on retry.
    return withAttemptWait(reportingBlock ?? (exhausted ? attemptBlock(state, time) : null), state, time) ?? { ok: true };
  }
  function attemptBlock(state, time) {
    if (state.attempts.length < ATTEMPT_LIMIT) return null;
    return denied("attempt_limit", "Too many submission attempts. Keep your draft and wait one minute.", state.attempts[0] + ATTEMPT_WINDOW_MS, time);
  }
  // Use the same calculation before and after body parsing. Never charge an
  // additional attempt here or turn an otherwise eligible reservation away.
  function withAttemptWait(rejection, state, time) {
    if (!rejection) return null;
    const attempts = attemptBlock(state, time);
    if (!attempts || Date.parse(attempts.resetAt) <= Date.parse(rejection.resetAt)) return rejection;
    // Keep the check-before-repeating warning even when another wait is longer.
    if (rejection.code === "delivery_uncertain") {
      return { ...rejection, retryAfterSeconds: attempts.retryAfterSeconds, resetAt: attempts.resetAt };
    }
    return attempts;
  }
  function reserve(key, fingerprint) {
    const time = now();
    const state = stateFor(key, time);
    if (state.ok === false) return state;
    const rejection = blocked(state, time, fingerprint);
    if (rejection) return withAttemptWait(rejection, state, time);
    const reservation = { time, fingerprint };
    state.pending = reservation;
    return { ok: true, settle(outcome) {
      if (state.pending !== reservation) return;
      state.pending = null;
      if (outcome !== "failed") state.events.push({ ...reservation, time: now(), outcome });
    } };
  }
  return { attempt, reserve };
}
