import express from "express";
import { ipKeyGenerator } from "express-rate-limit";
import axios from "axios";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createReportPolicy } from "./report-policy.js";

const webDirectory = fileURLToPath(new URL("../../web", import.meta.url));
export const FIELD_LIMITS = { title: 200, discord: 64, category: 64, reference: 500, description: 8000 };
const parserErrors = new Map([
  ["entity.too.large", [413, "report_too_large", "This report exceeds the 32 KiB request limit. Shorten the details while keeping the key evidence."]],
  ["parameters.too.many", [413, "report_too_large", "The request contains too many fields. Keep your draft and reload the report form."]],
  ["entity.parse.failed", [400, "invalid_request", "The report request could not be read. Keep your draft and reload the form before retrying."]],
  ["querystring.parse.rangeError", [400, "invalid_request", "The request contains too many nested fields. Keep your draft and reload the report form."]],
  ["request.aborted", [400, "invalid_request", "The report request was interrupted before delivery. Keep your draft and reload the report form."]],
  ["request.size.invalid", [400, "invalid_request", "The report request size is invalid. Keep your draft and reload the report form."]],
  ["charset.unsupported", [415, "unsupported_request", "The report format is unsupported. Keep your draft and reload the report form."]],
  ["encoding.unsupported", [415, "unsupported_request", "The report format is unsupported. Keep your draft and reload the report form."]],
  ["entity.verify.failed", [403, "invalid_request", "The report request could not be verified. Keep your draft and reload the report form."]]
]);

function clientKey(ip) {
  // Normalize hexadecimal mapped IPv4 before the existing IPv6 /56 grouping.
  const mapped = ipKeyGenerator(ip, 128).match(/^::ffff:([\da-f]+):([\da-f]+)\/128$/i);
  if (!mapped) return ipKeyGenerator(ip);
  const high = Number.parseInt(mapped[1], 16);
  const low = Number.parseInt(mapped[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

function sendError(res, status, code, message, details = {}) {
  if (details.retryAfterSeconds != null) res.set("Retry-After", String(details.retryAfterSeconds));
  return res.status(status).json({ error: { code, message }, ...details });
}

function sendAdmissionError(res, admission) {
  const status = admission.code === "delivery_uncertain" ? 409 : admission.code === "report_capacity" ? 503 : 429;
  return sendError(res, status, admission.code, admission.message, { retryAfterSeconds: admission.retryAfterSeconds, resetAt: admission.resetAt });
}

function validateFields(body, kind) {
  const required = kind === "data" ? ["title", "discord", "category", "description"] : ["title", "discord", "description"];
  const fields = {};
  for (const [name, max] of Object.entries(FIELD_LIMITS)) {
    const value = body?.[name];
    if (value != null && typeof value !== "string") return { error: `${name} must be text.` };
    fields[name] = (value ?? "").trim();
    if (fields[name].length > max) return { error: `${name} must be ${max} characters or fewer.` };
    if (required.includes(name) && !fields[name]) return { error: `Please provide ${name}.` };
  }
  return { fields };
}

function buildIssue(kind, fields) {
  if (kind === "issue") {
    return { title: fields.title, body: `**Discord handle:** ${fields.discord}\n\n**Description:**\n${fields.description}` };
  }
  const lines = [`**Discord handle:** ${fields.discord}`, `**Category:** ${fields.category}`];
  if (fields.reference) lines.push(`**Reference:** ${fields.reference}`);
  lines.push("", "**Details:**", fields.description);
  return { title: `[${fields.category}] ${fields.title}`, body: lines.join("\n") };
}

function safeWait(seconds, time) {
  const wait = Math.ceil(seconds);
  return Number.isSafeInteger(wait) && wait >= 0 && Number.isFinite(new Date(time + wait * 1000).getTime()) ? wait : null;
}

function providerWait(headers, time) {
  const retryHeader = headers["retry-after"];
  const retry = Number(retryHeader);
  const retrySeconds = retryHeader == null || String(retryHeader).trim() === "" ? null
    : safeWait(Number.isFinite(retry) ? retry : Math.max(0, (Date.parse(retryHeader) - time) / 1000), time);
  const resetHeader = headers["x-ratelimit-reset"];
  const resetSeconds = String(headers["x-ratelimit-remaining"]) === "0" && resetHeader != null && String(resetHeader).trim() !== ""
    ? safeWait(Math.max(0, (Number(resetHeader) * 1000 - time) / 1000), time) : null;
  const waits = [retrySeconds, resetSeconds].filter(Number.isFinite);
  return waits.length ? Math.max(...waits) : 60;
}

function deliveryError(err, time) {
  const status = err?.response?.status;
  const headers = err?.response?.headers ?? {};
  const message = err?.response?.data?.message;
  const secondary = typeof message === "string" && /secondary rate limit/i.test(message);
  if (status === 429 || (status === 403 && (headers["retry-after"] || String(headers["x-ratelimit-remaining"]) === "0" || secondary))) {
    const seconds = providerWait(headers, time);
    return { status: 503, code: "provider_rate_limit", message: "GitHub is temporarily limiting reports. Your report was not created. Keep your draft and wait before retrying.", retryAfterSeconds: seconds, resetAt: new Date(time + seconds * 1000).toISOString(), failed: true };
  }
  if ([400, 401, 403, 404, 405, 410, 422].includes(status)) {
    return { status: 502, code: "delivery_rejected", message: "The report service could not deliver this report. It was not created. Keep your draft and contact support.", failed: true };
  }
  if (["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"].includes(err?.code)) {
    return { status: 503, code: "delivery_unavailable", message: "The report service could not connect to GitHub. Your report was not created. Keep your draft and wait one minute before retrying.", retryAfterSeconds: 60, failed: true };
  }
  return { status: 504, code: "delivery_uncertain", message: "Delivery could not be confirmed. Check the issue list or contact support before repeating this report; it may already have been created.", failed: false };
}

export function createReportApp({ env = process.env, githubPost = axios.post, now = Date.now, logger = console } = {}) {
  const app = express();
  // Preserve existing trust. Operators must verify a single trusted proxy and
  // no direct origin access; do not trust a client-supplied IP header here.
  app.set("trust proxy", 1);
  const policy = createReportPolicy({ now });
  const origins = new Set((env.ALLOWED_ORIGINS || "").split(",").map(origin => origin.trim().replace(/\/+$/, "")).filter(Boolean));
  const githubHeaders = { Authorization: `token ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "tarkovtracker-webserver" };
  // This separate budget counts attempts, including invalid/rejected requests.
  // It is shared across routes and runs before decoding the body.
  app.post(["/data", "/issue"], (req, res, next) => {
    const admission = policy.attempt(clientKey(req.ip));
    if (!admission.ok) return sendAdmissionError(res, admission);
    next();
  });
  app.use(express.urlencoded({ extended: true, limit: "32kb" }));
  app.use(express.json({ limit: "32kb" }));
  app.use(express.static(path.join(webDirectory)));
  app.get("/health", (req, res) => res.json({ status: "ok" }));

  async function submit(req, res, kind) {
    const origin = req.headers.origin || req.headers.referer || "";
    if (origins.size && ![...origins].some(allowed => origin === allowed || origin.startsWith(`${allowed}/`))) {
      return sendError(res, 403, "forbidden_origin", "This report form is not allowed to submit from this address. Keep your draft and contact support.");
    }
    if ((req.body?.company ?? "").toString().trim()) return res.json({ ok: true });
    const validated = validateFields(req.body, kind);
    if (validated.error) return sendError(res, 400, "invalid_report", validated.error);
    const issue = buildIssue(kind, validated.fields);
    const fingerprint = createHash("sha256").update(JSON.stringify([kind, issue])).digest("hex");
    const admission = policy.reserve(clientKey(req.ip), fingerprint);
    if (!admission.ok) return sendAdmissionError(res, admission);
    try {
      const repo = kind === "data" ? env.REPO_DATA_REPORT : env.REPO_DEV;
      const response = await githubPost(`https://api.github.com/repos/${repo}/issues`, issue, { headers: githubHeaders, timeout: 10_000 });
      if (response?.status !== 201) throw new Error("Unexpected issue creation status");
      admission.settle("accepted");
      return res.json({ ok: true });
    } catch (err) {
      const failure = deliveryError(err, now());
      admission.settle(failure.failed ? "failed" : "uncertain");
      logger.error("Report delivery failed", { route: kind, status: Number.isInteger(err?.response?.status) ? err.response.status : "no-response", code: failure.code });
      const details = failure.retryAfterSeconds != null ? { retryAfterSeconds: failure.retryAfterSeconds } : {};
      if (failure.resetAt) details.resetAt = failure.resetAt;
      return sendError(res, failure.status, failure.code, failure.message, details);
    }
  }
  app.post("/data", (req, res) => submit(req, res, "data"));
  app.post("/issue", (req, res) => submit(req, res, "issue"));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const parserError = parserErrors.get(err.type);
    if (parserError) return sendError(res, ...parserError);
    logger.error("Report request failed", { type: "internal_error" });
    return sendError(res, 500, "internal_error", "The report service encountered an error. Keep your draft and contact support before repeating a submitted report.");
  });
  return app;
}
