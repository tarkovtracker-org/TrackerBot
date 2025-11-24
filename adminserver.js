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
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours
const STATE_TTL_MS = 1000 * 60 * 5; // 5 minutes

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
    if (!channelId || !/^\d{5,}$/.test(channelId)) {
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
    if (!channelId || !/^\d{5,}$/.test(channelId)) {
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
      <title>Tracker Bot Panel</title>
      <style>${baseStyles()}</style>
    </head>
    <body>
      <main class="card">
        <h1>Tracker Bot Panel</h1>
        <p>Connecte-toi avec Discord et assure-toi d'avoir le rôle Admin sur le serveur.</p>
        <a class="button" href="/auth/discord">Se connecter via Discord</a>
      </main>
    </body>
  </html>`;
}

function renderPanel(user) {
  return `<!doctype html>
  <html lang="fr">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Tracker Bot Panel</title>
      <style>${baseStyles()}</style>
    </head>
    <body>
      <main class="card">
        <header class="panel-header">
          <div>
            <h1>Panneau Bot</h1>
            <p>Connecté en tant que <strong>${escapeHtml(user.username)}</strong></p>
          </div>
          <form method="post" action="/logout">
            <button class="button secondary" type="submit">Déconnexion</button>
          </form>
        </header>
        <section>
          <h2>Envoyer un message encadré</h2>
          <form id="customMessageForm">
            <label>Channel ID
              <input name="channelId" placeholder="123456789" required />
            </label>
            <label>Titre
              <input name="title" placeholder="Titre de la carte" />
            </label>
            <label>Description
              <textarea name="description" rows="5" placeholder="Contenu" required></textarea>
            </label>
            <label>Couleur
              <input name="color" type="color" value="#5865f2" />
            </label>
            <button class="button" type="submit">Envoyer</button>
          </form>
        </section>
        <section>
          <h2>Re-poster les Reaction Roles</h2>
          <form id="roleMessageForm">
            <label>Channel ID
              <input name="channelId" placeholder="123456789" required />
            </label>
            <button class="button" type="submit">Envoyer le message rôles</button>
          </form>
        </section>
        <div id="status"></div>
      </main>
      <script>
        const statusBox = document.getElementById('status');
        function setStatus(text, isError) {
          statusBox.textContent = text;
          statusBox.className = isError ? 'error' : 'success';
        }
        const customForm = document.getElementById('customMessageForm');
        customForm.addEventListener('submit', async (event) => {
          event.preventDefault();
          const formData = new FormData(customForm);
          const payload = Object.fromEntries(formData.entries());
          try {
            const res = await fetch('/api/send-embed', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });
            if (!res.ok) throw new Error('Erreur API');
            setStatus('Message envoyé ✅');
            customForm.reset();
          } catch (err) {
            setStatus('Échec envoi', true);
          }
        });
        const roleForm = document.getElementById('roleMessageForm');
        roleForm.addEventListener('submit', async (event) => {
          event.preventDefault();
          const formData = new FormData(roleForm);
          const payload = Object.fromEntries(formData.entries());
          try {
            const res = await fetch('/api/send-role-message', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });
            if (!res.ok) throw new Error('Erreur API');
            setStatus('Reaction roles envoyé ✅');
            roleForm.reset();
          } catch (err) {
            setStatus('Échec envoi', true);
          }
        });
      </script>
    </body>
  </html>`;
}

function baseStyles() {
  return `:root { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #111827; color: #f9fafb; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .card { background: #1f2937; padding: 24px; border-radius: 16px; max-width: 720px; width: 100%; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
  h1, h2 { margin: 0 0 12px 0; }
  section { margin-top: 32px; }
  label { display: block; margin-bottom: 12px; font-size: 0.9rem; }
  input, textarea { width: 100%; margin-top: 4px; border-radius: 8px; border: 1px solid #374151; padding: 10px; background: #111827; color: #f9fafb; }
  textarea { resize: vertical; }
  .button { display: inline-flex; align-items: center; justify-content: center; padding: 10px 16px; border-radius: 8px; border: none; background: #5865f2; color: white; text-decoration: none; font-weight: 600; cursor: pointer; }
  .button.secondary { background: #4b5563; }
  .panel-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  #status { margin-top: 24px; font-weight: 600; }
  #status.error { color: #f87171; }
  #status.success { color: #34d399; }`;
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
  if (!createdAt) return false;
  return Date.now() - createdAt <= STATE_TTL_MS;
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
