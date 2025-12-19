//
//  webserver.js
//
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_REPO = "tarkovtracker-org/tarkov-data/overlay";
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(express.static(path.join(__dirname, 'web')));

app.post("/submit", async (req, res) => {
  try {
    const { title, discord, description } = req.body;
    if (!title || !discord || !description)
      return res.status(400).send("Fields marked * are required.");

    const body = `**Discord handle:** ${discord}\n\n**Description:**\n${description}`;

    const response = await axios.post(
      `https://api.github.com/repos/${process.env.GITHUB_REPO}/issues`,
      { title, body },
      { headers: { Authorization: `token ${process.env.GITHUB_TOKEN}` } }
    );

    res.status(200).send("Ok");

  } catch (err) {
    console.error(err.response?.data || err);
    res.status(500).send("Error during the bug report.");
  }
});

app.post("/submit-data-bug", async (req, res) => {
  try {
    const { title, discord, category, description, reference } = req.body;
    if (!title || !discord || !category || !description) {
      return res.status(400).json({ error: "All required fields must be provided." });
    }

    const lines = [
      `**Discord handle:** ${discord}`,
      `**Category:** ${category}`
    ];

    if (reference && reference.trim()) {
      lines.push(`**Reference:** ${reference.trim()}`);
    }

    lines.push("", "**Details:**", description.trim());

    await axios.post(
      `https://api.github.com/repos/${DATA_REPO}/issues`,
      {
        title: `[${category}] ${title}`,
        body: lines.join("\n")
      },
      { headers: { Authorization: `token ${process.env.GITHUB_TOKEN}` } }
    );

    res.json({ ok: true });
  } catch (err) {
    console.error(err.response?.data || err);
    res.status(500).json({ error: "Failed to submit the data report." });
  }
});

app.listen(PORT, () => {
  console.log(`Webserver running on port ${PORT}`);
});
