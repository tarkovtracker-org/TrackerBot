//
// adminserver.js
//
import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import crypto from "node:crypto";

dotenv.config();

const app = express();
const PORT = process.env.ADMIN_PANEL_PORT || 4001;
const SESSION_COOKIE = "panel_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; 
const STATE_TTL_MS = 1000 * 60 * 5;

const sessions = new Map();
const pendingStates = new Map();

const REQUIRED_ENV = [
  "DISCORD_TOKEN",
  "DISCORD_CLIENT_ID",
  "DISCORD_CLIENT_SECRET",
  "DISCORD_REDIRECT_URI",
  "GUILD_ID",
  "PANEL_ADMIN_ROLE_ID"
];

const missingEnv = REQUIRED_ENV.filter(key => !process.env[key]);
if (missingEnv.length) {
  console.warn("Missing admin panel environment variables:", missingEnv.join(", "));
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const discordApi = axios.create({
  baseURL: "https://discord.com/api",
  headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` }
});

const ROLE_EMBED_DESCRIPTION = `**@everyone** – Very important global notifications.  
(Major issues/changes affecting all users)

**@here** – Urgent short-term notifications (max 6h)

---

### React For Roles

🌐 = **@site** – Site updates  
🖥️ = **@monitor** – Tarkov Monitor updates  
📋 = **@polls** – Community polls  
📰 = **@news** – News & updates  
🔔 = **@notifs** – All notifications`;

const ROLE_COMPONENTS = [
  {
    type: 1,
    components: [
      { type: 2, style: 1, custom_id: "role_site", label: "🌐 Site" },
      { type: 2, style: 1, custom_id: "role_monitor", label: "🖥️ Monitor" },
      { type: 2, style: 1, custom_id: "role_polls", label: "📋 Polls" },
      { type: 2, style: 1, custom_id: "role_news", label: "📰 News" },
      { type: 2, style: 1, custom_id: "role_notifs", label: "🔔 Notifs" }
    ]
  }
];

app.get("/", (req, res) => {
  const session = getSession(req);
  if (!session) return res.send(renderLanding());
  return res.send(renderPanel(session.user));
});

app.get("/auth/discord", (req, res) => {
  const state = createState();
  const authorizeUrl = new URL("https://discord.com/api/oauth2/authorize");
  authorizeUrl.searchParams.set("client_id", process.env.DISCORD_CLIENT_ID || "");
  authorizeUrl.searchParams.set("redirect_uri", process.env.DISCORD_REDIRECT_URI || "");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", "identify");
  authorizeUrl.searchParams.set("state", state);
  res.redirect(authorizeUrl.toString());
});

app.get("/auth/discord/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || typeof code !== "string") return res.status(400).send("Missing code");
    if (!consumeState(state)) return res.status(400).send("Invalid state");

    const token = await exchangeCodeForToken(code);
    const user = await fetchDiscordUser(token.access_token);
    await assertUserIsAdmin(user.id);

    const sessionId = createSession(user);
    attachSession(res, sessionId);
    res.redirect("/");
  } catch (err) {
    console.error("OAuth callback failed", err.response?.data || err.message);
    res.status(401).send("Authentication failed. Ensure you have the Admin role.");
  }
});

app.post("/logout", (req, res) => {
  const session = getSession(req);
  if (session) {
    sessions.delete(session.id);
    res.clearCookie(SESSION_COOKIE);
  }
  res.redirect("/");
});

app.post("/api/send-embed", requireAuth, async (req, res) => {
  try {
    await assertUserIsAdmin(req.user.id);
    const { channelId, title, description, color } = req.body;
    if (!channelId || !/^\d+$/.test(channelId)) {
      return res.status(400).json({ error: "Channel ID invalide." });
    }
    if (!description || typeof description !== "string") {
      return res.status(400).json({ error: "Description requise." });
    }
    const embed = buildEmbed({ title, description, color, author: req.user });
    await discordApi.post(`/channels/${channelId}/messages`, { embeds: [embed] });
    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to send embed", err.response?.data || err.message);
    res.status(500).json({ error: "Envoi échoué" });
  }
});

app.post("/api/send-role-message", requireAuth, async (req, res) => {
  try {
    await assertUserIsAdmin(req.user.id);
    const { channelId } = req.body;
    if (!channelId || !/^\d+$/.test(channelId)) {
      return res.status(400).json({ error: "Channel ID invalide." });
    }
    const embed = {
      title: "Reaction Roles",
      description: ROLE_EMBED_DESCRIPTION,
      color: 0x0099ff
    };
    await discordApi.post(`/channels/${channelId}/messages`, {
      embeds: [embed],
      components: ROLE_COMPONENTS
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to send role message", err.response?.data || err.message);
    res.status(500).json({ error: "Envoi échoué" });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`Admin panel running on port ${PORT}`);
});

function buildEmbed({ title, description, color, author }) {
  const trimmedTitle = typeof title === "string" && title.trim().length ? title.trim().slice(0, 256) : "Annonce";
  const trimmedDescription = description.trim().slice(0, 2000);
  const parsedColor = parseColor(color) ?? 0x5865f2;
  return {
    title: trimmedTitle,
    description: trimmedDescription,
    color: parsedColor,
    timestamp: new Date().toISOString(),
    footer: { text: `Envoyé par ${author.username}` }
  };
}

function parseColor(value) {
  if (typeof value !== "string") return null;
  const hex = value.trim().replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return parseInt(hex, 16);
}

function renderLanding() {
  return `<!doctype html>
  <html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Admin Panel</title>
    <style>${baseStyles()}</style>
  </head>
  <body>

    <div class="container fade">
      <div class="topbar">
        <h1>Tracker Bot Panel</h1>
      </div>

      <div class="card center">
        <h2>Connexion requise</h2>
        <p>Connectez-vous via Discord pour accéder au panneau admin.</p>
        <a class="button primary big" href="/auth/discord">Se connecter avec Discord</a>
      </div>
    </div>

  </body>
  </html>`;
}

function renderPanel(user) {
  return `<!doctype html>
  <html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Admin Panel</title>
    <style>${baseStyles()}</style>
  </head>
  <body>

    <div class="container fade">

      <div class="topbar">
        <div>
          <h1>Panneau Admin</h1>
          <span class="subtitle">Connecté en tant que <strong>${escapeHtml(user.username)}</strong></span>
        </div>

        <form method="post" action="/logout">
          <button class="button red" type="submit">Déconnexion</button>
        </form>
      </div>

      <!-- SEND EMBED CARD -->
      <div class="card">
        <h2>Envoyer un Embed</h2>

        <form id="customMessageForm">
          <label>Channel ID
            <input name="channelId" placeholder="123456789" required />
          </label>

          <label>Titre
            <input name="title" placeholder="Titre de l'annonce" />
          </label>

          <label>Description
            <textarea name="description" rows="5" placeholder="Message..." required></textarea>
          </label>

          <label>Couleur de l'embed
            <input type="color" name="color" value="#5865f2" />
          </label>

          <button class="button primary" type="submit">Envoyer</button>
        </form>
      </div>

      <!-- ROLES REACTION -->
      <div class="card">
        <h2>Poster les Reaction Roles</h2>

        <form id="roleMessageForm">
          <label>Channel ID
            <input name="channelId" placeholder="123456789" required />
          </label>

          <button class="button primary" type="submit">Envoyer les rôles</button>
        </form>
      </div>

      <div id="status"></div>
    </div>

    <script>
      const statusBox = document.getElementById('status');
      function setStatus(text, isError) {
        statusBox.textContent = text;
        statusBox.className = isError ? 'error' : 'success';
      }

      const customForm = document.getElementById('customMessageForm');
      customForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const payload = Object.fromEntries(new FormData(customForm).entries());
        try {
          const res = await fetch('/api/send-embed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          if (!res.ok) throw new Error();
          setStatus('Message envoyé ✅');
          customForm.reset();
        } catch {
          setStatus('Erreur lors de l’envoi', true);
        }
      });

      const roleForm = document.getElementById('roleMessageForm');
      roleForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const payload = Object.fromEntries(new FormData(roleForm).entries());
        try {
          const res = await fetch('/api/send-role-message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          if (!res.ok) throw new Error();
          setStatus('Reaction roles envoyé ✅');
          roleForm.reset();
        } catch {
          setStatus('Erreur lors de l’envoi', true);
        }
      });
    </script>

  </body>
  </html>`;
}

function baseStyles() {
return `
:root {
  --bg: #0f131a;
  --card: #1c2431;
  --accent: #5865f2;
  --accent-hover: #4752c4;
  --danger: #e5494d;
  --danger-hover: #c93c3f;
  --text: #f2f4f7;
  --text-soft: #c7c9d1;
  --radius: 14px;
  --shadow: 0 8px 30px rgba(0,0,0,0.35);
  font-family: Inter, system-ui, sans-serif;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
}

.container {
  max-width: 860px;
  margin: auto;
  padding: 32px;
}

.fade { animation: fadeIn .3s ease-out; }

.card {
  background: var(--card);
  padding: 24px;
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  margin-top: 28px;
}

.card.center {
  text-align: center;
}

.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 28px;
}

.subtitle {
  opacity: .7;
  font-size: .9rem;
}

h1, h2 {
  margin: 0 0 10px;
}

label {
  display: block;
  margin-top: 14px;
  font-weight: 500;
}

input, textarea {
  width: 100%;
  margin-top: 6px;
  padding: 12px;
  border-radius: var(--radius);
  border: 1px solid #2a3544;
  background: #131820;
  color: var(--text);
  font-size: 1rem;
  transition: .15s border;
}

input:focus, textarea:focus {
  border-color: var(--accent);
  outline: none;
}

.button {
  padding: 12px 20px;
  border-radius: var(--radius);
  border: none;
  cursor: pointer;
  font-weight: 600;
  font-size: 1rem;
  margin-top: 18px;
  display: inline-block;
  text-align: center;
  transition: .15s;
}

.button.primary { background: var(--accent); color: #fff; }
.button.primary:hover { background: var(--accent-hover); }

.button.big { padding: 14px 24px; font-size: 1.1rem; }

.button.red { background: var(--danger); }
.button.red:hover { background: var(--danger-hover); }

#error { color: #ff6b6b; }
.success { color: #4ade80; margin-top:20px; }
.error { color: #f87171; margin-top:20px; }

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}
`;
}

function getSession(req) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(";").map(part => part.trim());
  const target = cookies.find(entry => entry.startsWith(`${SESSION_COOKIE}=`));
  if (!target) return null;
  const value = decodeURIComponent(target.substring(SESSION_COOKIE.length + 1));
  const session = sessions.get(value);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(value);
    return null;
  }
  return { id: value, ...session };
}

function createSession(user) {
  const id = crypto.randomBytes(24).toString("hex");
  sessions.set(id, { user, createdAt: Date.now() });
  return id;
}

function attachSession(res, id) {
  res.cookie(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: (process.env.NODE_ENV === "production"),
    maxAge: SESSION_TTL_MS
  });
}

function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Non authentifié" });
  req.user = session.user;
  return next();
}

function createState() {
  const state = crypto.randomBytes(16).toString("hex");
  pendingStates.set(state, Date.now());
  return state;
}

function consumeState(state) {
  if (!state || typeof state !== "string") return false;
  const createdAt = pendingStates.get(state);
  pendingStates.delete(state);
  return createdAt && Date.now() - createdAt <= STATE_TTL_MS;
}

async function exchangeCodeForToken(code) {
  const data = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    client_secret: process.env.DISCORD_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: process.env.DISCORD_REDIRECT_URI,
    scope: "identify"
  });
  const response = await axios.post("https://discord.com/api/oauth2/token", data.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" }
  });
  return response.data;
}

async function fetchDiscordUser(accessToken) {
  const response = await axios.get("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  return response.data;
}

async function assertUserIsAdmin(userId) {
  const guildId = process.env.GUILD_ID;
  const adminRoleId = process.env.PANEL_ADMIN_ROLE_ID;
  const response = await discordApi.get(`/guilds/${guildId}/members/${userId}`);
  const roles = response.data?.roles || [];
  if (!roles.includes(adminRoleId)) {
    throw new Error("User missing admin role");
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, match => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[match]);
}
