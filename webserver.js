//
// webserver.js
//
import express from "express";
import rateLimit from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Environment validation -------------------------------------------------

const REQUIRED_WEB_ENV = ["GITHUB_TOKEN", "REPO_DEV", "REPO_DATA_REPORT"];

function validateWebEnv() {
  const missing = REQUIRED_WEB_ENV.filter(name => !process.env[name]?.trim());
  if (missing.length) {
    throw new Error(
      `Missing required environment variables for webserver: ${missing.join(", ")}`
    );
  }
}

validateWebEnv();

// --- App setup --------------------------------------------------------------

const app = express();
const PORT = process.env.PORT || 3000;

// Trust the first proxy so express-rate-limit sees real client IPs behind a
// reverse proxy (nginx, Cloudflare, etc.). Without this every request appears
// to come from the proxy IP and rate limiting throttles everyone collectively.
app.set("trust proxy", 1);

const DATA_REPO = process.env.REPO_DATA_REPORT;
const DEV_REPO = process.env.REPO_DEV;

const GITHUB_HEADERS = {
  Authorization: `token ${process.env.GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "tarkovtracker-webserver"
};

// --- Field length caps ------------------------------------------------------

const MAX_TITLE = 200;
const MAX_DISCORD = 64;
const MAX_CATEGORY = 64;
const MAX_REFERENCE = 500;
const MAX_DESCRIPTION = 8000;

function truncate(value, max) {
  const v = (value ?? "").toString().trim();
  return v.length > max ? v.slice(0, max) : v;
}

// --- Rate limiting ----------------------------------------------------------

const reportLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many submissions. Please wait a minute and try again." }
});

// --- Origin allowlist -------------------------------------------------------

const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || "").split(",").map(o => o.trim()).filter(Boolean)
);

function checkOrigin(req, res, next) {
  if (ALLOWED_ORIGINS.size === 0) return next();
  const origin = req.headers.origin || req.headers.referer || "";
  const allowed = [...ALLOWED_ORIGINS].some(o => origin.startsWith(o));
  if (!allowed) {
    return res.status(403).json({ error: "Forbidden origin." });
  }
  next();
}

// --- Middleware -------------------------------------------------------------

app.use(express.urlencoded({ extended: true, limit: "32kb" }));
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "web")));

app.get("/health", (req, res) => res.json({ status: "ok" }));

// --- Honeypot + validation helpers -----------------------------------------

const HONEYPOT_FIELD = "company";

function hasHoneypotHit(body) {
  return Boolean((body?.[HONEYPOT_FIELD] ?? "").toString().trim());
}

function sanitizeReportFields({ title, discord, category, description, reference }) {
  return {
    title: truncate(title, MAX_TITLE),
    discord: truncate(discord, MAX_DISCORD),
    category: truncate(category, MAX_CATEGORY),
    description: truncate(description, MAX_DESCRIPTION),
    reference: reference ? truncate(reference, MAX_REFERENCE) : ""
  };
}

// --- Routes -----------------------------------------------------------------

/**
 * Data bug report
 */
app.post("/data", reportLimiter, checkOrigin, async (req, res) => {
  try {
    if (hasHoneypotHit(req.body)) {
      return res.json({ ok: true });
    }

    const { title, discord, category, description, reference } = sanitizeReportFields(req.body);

    if (![title, discord, category, description].every(v => v?.trim())) {
      return res
        .status(400)
        .json({ error: "All required fields must be provided." });
    }

    const lines = [
      `**Discord handle:** ${discord}`,
      `**Category:** ${category}`
    ];

    if (reference) {
      lines.push(`**Reference:** ${reference}`);
    }

    lines.push("", "**Details:**", description);

    await axios.post(
      `https://api.github.com/repos/${DATA_REPO}/issues`,
      {
        title: `[${category}] ${title}`,
        body: lines.join("\n")
      },
      { headers: GITHUB_HEADERS }
    );

    res.json({ ok: true });
  } catch (err) {
    logSanitizedError("POST /data", err);
    res.status(500).json({ error: "Failed to submit the data report." });
  }
});

/**
 * Dev-only issue report
 */
app.post("/issue", reportLimiter, checkOrigin, async (req, res) => {
  try {
    if (hasHoneypotHit(req.body)) {
      return res.json({ ok: true });
    }

    const { title, discord, description } = sanitizeReportFields(req.body);

    if (![title, discord, description].every(v => v?.trim())) {
      return res.status(400).json({ error: "Fields marked * are required." });
    }

    const body = `**Discord handle:** ${discord}

**Description:**
${description}`;

    await axios.post(
      `https://api.github.com/repos/${DEV_REPO}/issues`,
      { title, body },
      { headers: GITHUB_HEADERS }
    );

    res.json({ ok: true });
  } catch (err) {
    logSanitizedError("POST /issue", err);
    res.status(500).json({ error: "Error during the bug report." });
  }
});

// --- Sanitized error logging ------------------------------------------------
// Never log the full axios error object — it contains err.config.headers
// which includes the raw Authorization header (the GitHub token).

function logSanitizedError(route, err) {
  const status = err.response?.status ?? "no-response";
  const message = err.message ?? "unknown error";
  console.error(`[${route}] GitHub API error: status=${status} message=${message}`);
}

// --- Start ------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`Webserver running on port ${PORT}`);
});
