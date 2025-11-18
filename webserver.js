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

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(express.static(path.join(__dirname, 'web')));

app.post("/submit", async (req, res) => {
  try {
    const { title, discord, description } = req.body;
    if (!title || !discord || !description)
      return res.status(400).send("Fields marked * are required.");

    const body = `**Discord Pseudo :** ${discord}\n\n**Description :**\n${description}`;

    // Créer l'issue GitHub
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

app.listen(PORT, () => {
  console.log(`Webserver running on port ${PORT}`);
});
