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
      return res.status(400).json({ error: "Invalid channel ID." });
    }
    if (!description || typeof description !== "string") {
      return res.status(400).json({ error: "Description is required." });
    }
    const embed = buildEmbed({ title, description, color, author: req.user });
    await discordApi.post(`/channels/${channelId}/messages`, { embeds: [embed] });
    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to send embed", err.response?.data || err.message);
    res.status(500).json({ error: "Request failed." });
  }
});

app.post("/api/send-role-message", requireAuth, async (req, res) => {
  try {
    await assertUserIsAdmin(req.user.id);
    const { channelId } = req.body;
    if (!channelId || !/^\d+$/.test(channelId)) {
      return res.status(400).json({ error: "Invalid channel ID." });
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
    res.status(500).json({ error: "Request failed." });
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
    footer: { text: `Posted by ${author.username}` }
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
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Tracker Admin Panel</title>
    <style>${baseStyles()}</style>
  </head>
  <body class="landing">
    <div class="shell fade">
      <div class="hero-card card">
        <p class="badge">Tracker Admin</p>
        <h1>Sign in to manage announcements</h1>
        <p class="lead">
          Authenticate with your Discord account that has the admin role inside the TarkovTracker guild.
          Once approved you can post embeds and rebuild the reaction-role panel directly from this dashboard.
        </p>
        <a class="button primary big" href="/auth/discord">Sign in with Discord</a>
      </div>
    </div>
  </body>
  </html>`;
}

function renderPanel(user) {
  return `<!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Tracker Admin Panel</title>
    <style>${baseStyles()}</style>
  </head>
  <body>
    <div class="shell fade">
      <header class="toolbar">
        <div>
          <p class="badge">Tracker Admin</p>
          <h1>Control Center</h1>
          <span class="subtitle">Signed in as <strong>${escapeHtml(user.username)}</strong></span>
        </div>
        <form method="post" action="/logout">
          <button class="button ghost" type="submit">Log out</button>
        </form>
      </header>

      <section class="grid">
        <article class="card form-card">
          <header>
            <h2>Custom Embed</h2>
            <p>Push an embed to any text channel using the bot identity.</p>
          </header>
          <form id="customMessageForm">
            <label>Channel ID
              <input name="channelId" placeholder="123456789" required />
            </label>
            <label>Title
              <input name="title" placeholder="Leave empty for a default title" />
            </label>
            <label>Description
              <textarea name="description" rows="5" placeholder="Message body..." required></textarea>
            </label>
            <label>Embed color
              <input type="color" name="color" value="#5865f2" />
            </label>
            <button class="button primary" type="submit">Send Embed</button>
          </form>
        </article>

        <article class="card form-card">
          <header>
            <h2>Reaction Roles</h2>
            <p>Re-post the full reaction role board after a cleanup.</p>
          </header>
          <form id="roleMessageForm">
            <label>Channel ID
              <input name="channelId" placeholder="123456789" required />
            </label>
            <button class="button primary" type="submit">Post Roles</button>
          </form>
        </article>
      </section>

      <div id="status" class="status"></div>
    </div>

    <script>
      const statusBox = document.getElementById('status');
      function setStatus(text, isError) {
        statusBox.textContent = text;
        statusBox.className = isError ? 'status error' : 'status success';
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
          setStatus('Embed sent successfully ✅');
          customForm.reset();
        } catch {
          setStatus('Failed to send embed', true);
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
          setStatus('Reaction role board sent ✅');
          roleForm.reset();
        } catch {
          setStatus('Failed to post reaction roles', true);
        }
      });
    </script>

  </body>
  </html>`;
}

function baseStyles() {
return `
:root {
  font-family: "Inter", system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
  --bg: radial-gradient(circle at top, #1f2a44, #0c111c 60%);
  --card: rgba(18, 23, 35, 0.95);
  --border: rgba(255, 255, 255, 0.08);
  --accent: #7f8cff;
  --accent-hover: #6c75ff;
  --ghost: rgba(255, 255, 255, 0.1);
  --text: #f7f8fc;
  --muted: rgba(247, 248, 252, 0.7);
  --radius: 18px;
  --shadow: 0 25px 60px rgba(0, 0, 0, 0.45);
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  background: var(--bg);
  color: var(--text);
}

.shell {
  max-width: 960px;
  margin: 0 auto;
  padding: 40px 24px 80px;
}

.fade {
  animation: fadeIn 0.35s ease;
}

.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 28px;
  box-shadow: var(--shadow);
  backdrop-filter: blur(10px);
}

.hero-card h1 {
  margin: 12px 0 8px;
}

.lead {
  color: var(--muted);
  line-height: 1.6;
  margin-bottom: 28px;
}

.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
}

.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 28px;
  gap: 20px;
}

.subtitle {
  color: var(--muted);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 24px;
}

.form-card header p {
  color: var(--muted);
  margin: 4px 0 0;
}

label {
  display: block;
  margin-top: 18px;
  font-weight: 600;
  font-size: 0.95rem;
}

input,
textarea {
  width: 100%;
  margin-top: 8px;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.04);
  color: var(--text);
  font-size: 1rem;
  transition: border 0.2s ease, box-shadow 0.2s ease;
}

input:focus,
textarea:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
  outline: none;
}

textarea {
  resize: vertical;
}

.button {
  margin-top: 22px;
  padding: 13px 22px;
  border-radius: 999px;
  border: none;
  font-weight: 600;
  font-size: 1rem;
  cursor: pointer;
  color: #fff;
  transition: background 0.2s ease, transform 0.2s ease;
}

.button.primary {
  background: linear-gradient(120deg, #7f8cff, #a77bff);
}

.button.primary:hover {
  background: linear-gradient(120deg, #6c75ff, #9665ff);
  transform: translateY(-1px);
}

.button.big {
  width: fit-content;
  padding-inline: 32px;
  font-size: 1.05rem;
}

.button.ghost {
  background: var(--ghost);
  color: var(--text);
}

.button.ghost:hover {
  background: rgba(255, 255, 255, 0.2);
  transform: translateY(-1px);
}

.status {
  margin-top: 28px;
  padding: 14px 18px;
  border-radius: 12px;
  font-weight: 600;
  text-align: center;
  display: none;
}

.status.success {
  display: block;
  background: rgba(74, 222, 128, 0.12);
  color: #86efac;
  border: 1px solid rgba(74, 222, 128, 0.4);
}

.status.error {
  display: block;
  background: rgba(248, 113, 113, 0.12);
  color: #fca5a5;
  border: 1px solid rgba(248, 113, 113, 0.4);
}

@media (max-width: 640px) {
  .toolbar {
    flex-direction: column;
    align-items: stretch;
  }
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
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
  if (!session) return res.status(401).json({ error: "Not authenticated" });
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
