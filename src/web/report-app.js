import express from "express";
import { ipKeyGenerator } from "express-rate-limit";
import axios from "axios";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createReportPolicy } from "./report-policy.js";

const webDirectory = fileURLToPath(new URL("../../web", import.meta.url));
export const FIELD_LIMITS = { title: 200, discord: 64, category: 64, reference: 500, description: 8000 };

function clientKey(ip) {
  // Normalize hexadecimal mapped IPv4 before the existing IPv6 /56 grouping.
  const mapped = ipKeyGenerator(ip, 128).match(/^::ffff:([\da-f]+):([\da-f]+)\/128$/i);
  if (!mapped) return ipKeyGenerator(ip);
  const high = Number.parseInt(mapped[1], 16);
  const low = Number.parseInt(mapped[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

function sendError(res, status, code, message, details = {}) {
  if (details.retryAfterSeconds) res.set("Retry-After", String(details.retryAfterSeconds));
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

function deliveryError(err) {
  const status = err?.response?.status;
  const headers = err?.response?.headers ?? {};
  if (status === 429 || (status === 403 && (headers["retry-after"] || headers["x-ratelimit-remaining"] === "0"))) {
    const seconds = Number(headers["retry-after"]);
    return { status: 503, code: "provider_rate_limit", message: "GitHub is temporarily limiting reports. Your report was not created. Keep your draft and wait before retrying.", retryAfterSeconds: Number.isFinite(seconds) && seconds > 0 ? Math.min(3600, Math.ceil(seconds)) : 60, failed: true };
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
      const failure = deliveryError(err);
      admission.settle(failure.failed ? "failed" : "uncertain");
      logger.error("Report delivery failed", { route: kind, status: Number.isInteger(err?.response?.status) ? err.response.status : "no-response", code: failure.code });
      const details = failure.retryAfterSeconds ? { retryAfterSeconds: failure.retryAfterSeconds } : {};
      return sendError(res, failure.status, failure.code, failure.message, details);
    }
  }
  app.post("/data", (req, res) => submit(req, res, "data"));
  app.post("/issue", (req, res) => submit(req, res, "issue"));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err.type === "entity.too.large") return sendError(res, 413, "report_too_large", "This report exceeds the 32 KiB request limit. Shorten the details while keeping the key evidence.");
    if (err.type === "entity.parse.failed") return sendError(res, 400, "invalid_request", "The report request could not be read. Keep your draft and reload the form before retrying.");
    logger.error("Report request failed", { type: "internal_error" });
    return sendError(res, 500, "internal_error", "The report service encountered an error. Keep your draft and contact support before repeating a submitted report.");
  });
  return app;
}
