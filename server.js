const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const nodemailer = require("nodemailer");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    if (!key) continue;

    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function parsePositiveInt(value, fallback) {
  const n = Number(value);
  if (Number.isInteger(n) && n > 0) return n;
  return fallback;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const ENV_FILE = path.join(__dirname, ".env");
loadEnvFile(ENV_FILE);

const app = express();
const PORT = parsePositiveInt(process.env.PORT, 3000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const MEMORY_DIR = path.join(DATA_DIR, "memories");

const APP_NAME = process.env.APP_NAME || "SAMPLE_TITLE";
const APP_CHAT_TITLE = process.env.APP_CHAT_TITLE || "my chat";
const APP_CONSOLE_LABEL = process.env.APP_CONSOLE_LABEL || `${APP_NAME} Console`;

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434/api/chat";
const MODEL = process.env.OLLAMA_MODEL || "BASIC_MODEL";
const OLLAMA_TIMEOUT_MS = parsePositiveInt(process.env.OLLAMA_TIMEOUT_MS, 60000);
const MAX_RECENT_MESSAGES = parsePositiveInt(process.env.MAX_RECENT_MESSAGES, 30);

const MAIL_SERVICE = process.env.MAIL_SERVICE || "gmail";
const MAIL_USER = process.env.MAIL_USER || "your_gmail_account";
const MAIL_PASSWORD = process.env.MAIL_PASSWORD || "mail_password";
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || APP_NAME;
const MAIL_VERIFY_SUBJECT =
  process.env.MAIL_VERIFY_SUBJECT || `[${APP_NAME}] Email verification`;
const MAIL_VERIFY_HEADING =
  process.env.MAIL_VERIFY_HEADING || `${APP_NAME} Email verification`;
const MAIL_VERIFY_MESSAGE =
  process.env.MAIL_VERIFY_MESSAGE ||
  "Click the link below to complete your membership verification.";

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "chat_session";
const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 7;

const DEFAULT_SYSTEM_PROMPT = `

Personality:


Context:


Rules:

`.trim();
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT;

const sessions = new Map();
const chatStates = new Map();
let globalBusy = false;

function ensureDataFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify({ users: [] }, null, 2), "utf8");
  }
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function defaultMemoryData() {
  return {
    longTerm: "",
    messages: [],
    updatedAt: Date.now()
  };
}

function sanitizeMessages(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string"
    )
    .map((m) => ({
      role: m.role,
      content: m.content,
      timestamp: Number.isFinite(m.timestamp) ? m.timestamp : Date.now()
    }))
    .slice(-MAX_RECENT_MESSAGES);
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, hash] = String(stored || "").split(":");
    if (!salt || !hash) return false;
    const digest = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(digest, "hex"));
  } catch {
    return false;
  }
}

function emailKey(email) {
  return Buffer.from(email).toString("base64url");
}

function getMemoryFileByEmail(email) {
  return path.join(MEMORY_DIR, `${emailKey(email)}.json`);
}

function loadUsers() {
  const raw = readJson(USERS_FILE, { users: [] });
  return Array.isArray(raw?.users) ? raw.users : [];
}

let users = [];

function saveUsers() {
  writeJson(USERS_FILE, { users });
}

function loadUserMemory(email) {
  const file = getMemoryFileByEmail(email);
  if (!fs.existsSync(file)) {
    writeJson(file, defaultMemoryData());
  }

  const raw = readJson(file, defaultMemoryData());
  return {
    longTerm: typeof raw?.longTerm === "string" ? raw.longTerm : "",
    messages: sanitizeMessages(raw?.messages),
    updatedAt: Number.isFinite(raw?.updatedAt) ? raw.updatedAt : Date.now()
  };
}

function saveUserMemory(email, state) {
  const file = getMemoryFileByEmail(email);
  writeJson(file, {
    longTerm: typeof state?.longTerm === "string" ? state.longTerm : "",
    messages: sanitizeMessages(state?.messages),
    updatedAt: Number.isFinite(state?.updatedAt) ? state.updatedAt : Date.now()
  });
}

function getUserState(email) {
  if (chatStates.has(email)) return chatStates.get(email);
  const persisted = loadUserMemory(email);
  const state = {
    longTerm: persisted.longTerm,
    messages: persisted.messages,
    updatedAt: persisted.updatedAt
  };
  chatStates.set(email, state);
  return state;
}

function persistUserState(email) {
  const state = getUserState(email);
  saveUserMemory(email, state);
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const result = {};

  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (!k) continue;
    result[k] = decodeURIComponent(v.join("="));
  }

  return result;
}

function getSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE_NAME];
  if (!token) return null;

  const session = sessions.get(token);
  if (!session) return null;

  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }

  return { token, email: session.email };
}

function setSessionCookie(res, token) {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SEC}`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`
  );
}

function renderPublicHtml(fileName, replacements = {}) {
  const htmlPath = path.join(PUBLIC_DIR, fileName);
  let html = fs.readFileSync(htmlPath, "utf8");

  for (const [key, rawValue] of Object.entries(replacements)) {
    const token = `{{${key}}}`;
    html = html.split(token).join(escapeHtml(rawValue));
  }

  return html;
}

function sendPublicPage(res, fileName, replacements = {}) {
  res.type("html").send(renderPublicHtml(fileName, replacements));
}

function requireApiAuth(req, res, next) {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  req.userEmail = session.email;
  req.sessionToken = session.token;
  return next();
}

function requirePageAuth(req, res, next) {
  const session = getSession(req);
  if (!session) {
    return res.redirect("/");
  }
  req.userEmail = session.email;
  req.sessionToken = session.token;
  return next();
}

const mailer = nodemailer.createTransport({
  service: MAIL_SERVICE,
  auth: {
    user: MAIL_USER,
    pass: MAIL_PASSWORD
  }
});

async function sendVerificationEmail(email, token) {
  const verifyLink = `${BASE_URL}/verify-email?token=${encodeURIComponent(token)}`;
  await mailer.sendMail({
    from: `"${MAIL_FROM_NAME}" <${MAIL_USER}>`,
    to: email,
    subject: MAIL_VERIFY_SUBJECT,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5">
        <h2>${escapeHtml(MAIL_VERIFY_HEADING)}</h2>
        <p>${escapeHtml(MAIL_VERIFY_MESSAGE)}</p>
        <p><a href="${verifyLink}">${verifyLink}</a></p>
      </div>
    `
  });
}

ensureDataFiles();
users = loadUsers();

app.use(express.json());
app.use(express.static(PUBLIC_DIR, { index: false }));

app.get("/", (req, res) => {
  if (getSession(req)) return res.redirect("/chat");
  return sendPublicPage(res, "index.html", {
    APP_NAME
  });
});

app.get("/register", (_req, res) => {
  sendPublicPage(res, "register.html", {
    APP_NAME
  });
});

app.get("/verified", (_req, res) => {
  sendPublicPage(res, "verified.html", {
    APP_NAME
  });
});

app.get("/verify-email", (req, res) => {
  const token = String(req.query?.token || "").trim();
  if (!token) {
    return res.status(400).send("Invalid verification token.");
  }

  const user = users.find((u) => u.verifyToken === token);
  if (!user) {
    return res.status(400).send("Invalid or expired verification token.");
  }

  user.verified = true;
  user.verifyToken = "";
  user.verifiedAt = Date.now();
  user.updatedAt = Date.now();
  saveUsers();

  if (!fs.existsSync(getMemoryFileByEmail(user.email))) {
    writeJson(getMemoryFileByEmail(user.email), defaultMemoryData());
  }

  return res.redirect("/verified");
});

app.get("/chat", requirePageAuth, (_req, res) => {
  sendPublicPage(res, "main.html", {
    APP_NAME,
    APP_CHAT_TITLE,
    APP_CONSOLE_LABEL
  });
});

app.post("/api/auth/register", async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = typeof req.body?.password === "string" ? req.body.password : "";

  if (!validEmail(email)) {
    return res.status(400).json({ error: "올바른 이메일 형식이 아닙니다." });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: "비밀번호는 8자 이상이어야 합니다." });
  }

  const verifyToken = crypto.randomBytes(24).toString("hex");
  const now = Date.now();
  const existing = users.find((u) => u.email === email);

  if (existing && existing.verified) {
    return res.status(409).json({ error: "이미 가입된 이메일입니다." });
  }

  if (existing) {
    existing.passwordHash = createPasswordHash(password);
    existing.verifyToken = verifyToken;
    existing.updatedAt = now;
  } else {
    users.push({
      email,
      passwordHash: createPasswordHash(password),
      verified: false,
      verifyToken,
      createdAt: now,
      updatedAt: now
    });
  }

  saveUsers();

  try {
    await sendVerificationEmail(email, verifyToken);
  } catch {
    return res.status(500).json({ error: "Failed to send authentication email." });
  }

  return res.json({ ok: true, message: "We have sent you a verification email." });
});

app.post("/api/auth/login", (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = typeof req.body?.password === "string" ? req.body.password : "";

  const user = users.find((u) => u.email === email);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: "Your email or password is incorrect." });
  }

  if (!user.verified) {
    return res.status(403).json({ error: "You need email verification." });
  }

  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, {
    email: user.email,
    expiresAt: Date.now() + SESSION_MAX_AGE_SEC * 1000
  });

  setSessionCookie(res, token);
  return res.json({ ok: true, email: user.email });
});

app.post("/api/auth/logout", (req, res) => {
  const session = getSession(req);
  if (session) {
    sessions.delete(session.token);
  }
  clearSessionCookie(res);
  return res.json({ ok: true });
});

app.get("/api/auth/me", requireApiAuth, (req, res) => {
  res.json({ email: req.userEmail });
});

app.get("/api/chat/history", requireApiAuth, (req, res) => {
  const state = getUserState(req.userEmail);
  res.json({
    messages: state.messages,
    isBusy: globalBusy
  });
});

app.post("/api/chat/send", requireApiAuth, async (req, res) => {
  const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
  if (!content) {
    return res.status(400).json({ error: "content is required" });
  }

  if (globalBusy) {
    return res.status(409).json({ error: "LLM is busy. Only one user allowed." });
  }

  const email = req.userEmail;
  const state = getUserState(email);

  state.messages.push({
    role: "user",
    content,
    timestamp: Date.now()
  });
  state.messages = sanitizeMessages(state.messages);
  state.updatedAt = Date.now();
  persistUserState(email);

  globalBusy = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

  try {
    const messagesForOllama = [
      { role: "system", content: SYSTEM_PROMPT },
      ...(state.longTerm
        ? [{ role: "system", content: `Long-term memory:\n${state.longTerm}` }]
        : []),
      ...state.messages.map((m) => ({ role: m.role, content: m.content }))
    ];

    const ollamaRes = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: messagesForOllama,
        stream: false
      }),
      signal: controller.signal
    });

    if (!ollamaRes.ok) {
      const text = await ollamaRes.text();
      throw new Error(`Ollama error ${ollamaRes.status}: ${text}`);
    }

    const data = await ollamaRes.json();
    const assistantContent =
      (typeof data?.message?.content === "string" && data.message.content) ||
      (typeof data?.response === "string" && data.response) ||
      "";

    if (!assistantContent.trim()) {
      throw new Error("Invalid Ollama response");
    }

    const assistantMessage = {
      role: "assistant",
      content: assistantContent.trim(),
      timestamp: Date.now()
    };

    state.messages.push(assistantMessage);
    state.messages = sanitizeMessages(state.messages);
    state.updatedAt = Date.now();
    persistUserState(email);

    return res.json({ assistant: assistantMessage });
  } catch (error) {
    const isTimeout = error?.name === "AbortError";
    return res.status(500).json({
      error: isTimeout ? "Ollama request timeout (60s)." : "Failed to get response from Ollama."
    });
  } finally {
    clearTimeout(timer);
    globalBusy = false;
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt < now) {
      sessions.delete(token);
    }
  }
}, 60_000);

app.listen(PORT, () => {
  console.log(`Server listening on ${BASE_URL}`);
});
