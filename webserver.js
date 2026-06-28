//
// webserver.js
//
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_REPO =
  process.env.REPO_DATA_REPORT || "tarkovtracker-org/tarkov-data/overlay";

const GITHUB_HEADERS = {
  Authorization: `token ${process.env.GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "tarkovtracker-webserver"
};

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "web")));

app.get("/health", (req, res) => res.json({ status: "ok" }));

/**
 * Data bug report
 */
app.post("/data", async (req, res) => {
  try {
    const { title, discord, category, description, reference } = req.body;

    if (![title, discord, category, description].every(v => v?.trim())) {
      return res
        .status(400)
        .json({ error: "All required fields must be provided." });
    }

    const lines = [
      `**Discord handle:** ${discord.trim()}`,
      `**Category:** ${category.trim()}`
    ];

    if (reference?.trim()) {
      lines.push(`**Reference:** ${reference.trim()}`);
    }

    lines.push("", "**Details:**", description.trim());

    await axios.post(
      `https://api.github.com/repos/${DATA_REPO}/issues`,
      {
        title: `[${category.trim()}] ${title.trim()}`,
        body: lines.join("\n")
      },
      { headers: GITHUB_HEADERS }
    );

    res.json({ ok: true });
  } catch (err) {
    console.error(err.response?.data || err);
    res.status(500).json({ error: "Failed to submit the data report." });
  }
});

/**
 * Dev-only issue report
 */
app.post("/issue", async (req, res) => {
  try {
    const { title, discord, description } = req.body;

    if (![title, discord, description].every(v => v?.trim())) {
      return res.status(400).json({ error: "Fields marked * are required." });
    }

    const body = `**Discord handle:** ${discord.trim()}

**Description:**
${description.trim()}`;

    await axios.post(
      `https://api.github.com/repos/${process.env.REPO_DEV || process.env.GITHUB_REPO}/issues`,
      { title: title.trim(), body },
      { headers: GITHUB_HEADERS }
    );

    res.json({ ok: true });
  } catch (err) {
    console.error(err.response?.data || err);
    res.status(500).json({ error: "Error during the bug report." });
  }
});

app.listen(PORT, () => {
  console.log(`Webserver running on port ${PORT}`);
});
