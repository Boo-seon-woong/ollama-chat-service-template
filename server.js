const fs = require("fs");
const path = require("path");
const express = require("express");
const nodemailer = require("nodemailer");

const config = require("./app/config");
const { createStore } = require("./app/store");
const { createChatService } = require("./app/chat-service");

const app = express();

const store = createStore({
  dataDir: config.DATA_DIR,
  usersFile: config.USERS_FILE,
  memoryDir: config.MEMORY_DIR,
  sessionCookieName: config.SESSION_COOKIE_NAME,
  sessionMaxAgeSec: config.SESSION_MAX_AGE_SEC,
  maxRecentMessages: config.MAX_RECENT_MESSAGES
});

const chatService = createChatService({
  store,
  ollamaUrl: config.OLLAMA_URL,
  model: config.MODEL,
  systemPrompt: config.SYSTEM_PROMPT,
  timeoutMs: config.OLLAMA_TIMEOUT_MS,
  maxPending: config.CHAT_QUEUE_MAX_PENDING
});

function renderPublicHtml(fileName, replacements = {}) {
  const htmlPath = path.join(config.PUBLIC_DIR, fileName);
  let html = fs.readFileSync(htmlPath, "utf8");

  for (const [key, rawValue] of Object.entries(replacements)) {
    const token = `{{${key}}}`;
    html = html.split(token).join(config.escapeHtml(rawValue));
  }

  return html;
}

function sendPublicPage(res, fileName, replacements = {}) {
  res.type("html").send(renderPublicHtml(fileName, replacements));
}

const mailer = nodemailer.createTransport({
  service: config.MAIL_SERVICE,
  auth: {
    user: config.MAIL_USER,
    pass: config.MAIL_PASSWORD
  }
});

async function sendVerificationEmail(email, token) {
  const verifyLink = `${config.BASE_URL}/verify-email?token=${encodeURIComponent(token)}`;
  await mailer.sendMail({
    from: `"${config.MAIL_FROM_NAME}" <${config.MAIL_USER}>`,
    to: email,
    subject: config.MAIL_VERIFY_SUBJECT,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5">
        <h2>${config.escapeHtml(config.MAIL_VERIFY_HEADING)}</h2>
        <p>${config.escapeHtml(config.MAIL_VERIFY_MESSAGE)}</p>
        <p><a href="${verifyLink}">${verifyLink}</a></p>
      </div>
    `
  });
}

store.initialize();

app.use(express.json());
app.use(express.static(config.PUBLIC_DIR, { index: false }));

app.get("/", (req, res) => {
  if (store.getSession(req)) return res.redirect("/chat");
  return sendPublicPage(res, "index.html", {
    APP_NAME: config.APP_NAME
  });
});

app.get("/register", (_req, res) => {
  sendPublicPage(res, "register.html", {
    APP_NAME: config.APP_NAME
  });
});

app.get("/verified", (_req, res) => {
  sendPublicPage(res, "verified.html", {
    APP_NAME: config.APP_NAME
  });
});

app.get("/verify-email", (req, res) => {
  const token = String(req.query?.token || "").trim();
  if (!token) {
    return res.status(400).send("Invalid verification token.");
  }

  const user = store.findUserByVerifyToken(token);
  if (!user) {
    return res.status(400).send("Invalid or expired verification token.");
  }

  store.markUserVerified(user);
  store.ensureUserMemoryFile(user.email);

  return res.redirect("/verified");
});

app.get("/chat", store.requirePageAuth, (_req, res) => {
  sendPublicPage(res, "main.html", {
    APP_NAME: config.APP_NAME,
    APP_CHAT_TITLE: config.APP_CHAT_TITLE,
    APP_CONSOLE_LABEL: config.APP_CONSOLE_LABEL
  });
});

app.post("/api/auth/register", async (req, res) => {
  const email = store.normalizeEmail(req.body?.email);
  const password = typeof req.body?.password === "string" ? req.body.password : "";

  if (!store.validEmail(email)) {
    return res.status(400).json({ error: "올바른 이메일 형식이 아닙니다." });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: "비밀번호는 8자 이상이어야 합니다." });
  }

  const created = store.createOrUpdateUserForVerification(email, password);
  if (!created.ok && created.reason === "ALREADY_VERIFIED") {
    return res.status(409).json({ error: "이미 가입된 이메일입니다." });
  }

  try {
    await sendVerificationEmail(email, created.verifyToken);
  } catch {
    return res.status(500).json({ error: "Failed to send authentication email." });
  }

  return res.json({ ok: true, message: "We have sent you a verification email." });
});

app.post("/api/auth/login", (req, res) => {
  const email = store.normalizeEmail(req.body?.email);
  const password = typeof req.body?.password === "string" ? req.body.password : "";

  const auth = store.authenticateUser(email, password);
  if (!auth.ok && auth.reason === "INVALID_CREDENTIALS") {
    return res.status(401).json({ error: "Your email or password is incorrect." });
  }

  if (!auth.ok && auth.reason === "NOT_VERIFIED") {
    return res.status(403).json({ error: "You need email verification." });
  }

  const token = store.createSession(auth.user.email);
  store.setSessionCookie(res, token);
  return res.json({ ok: true, email: auth.user.email });
});

app.post("/api/auth/logout", (req, res) => {
  const session = store.getSession(req);
  if (session) {
    store.deleteSession(session.token);
  }
  store.clearSessionCookie(res);
  return res.json({ ok: true });
});

app.get("/api/auth/me", store.requireApiAuth, (req, res) => {
  res.json({ email: req.userEmail });
});

app.get("/api/chat/history", store.requireApiAuth, (req, res) => {
  res.json(chatService.getHistory(req.userEmail));
});

app.post("/api/chat/send", store.requireApiAuth, async (req, res) => {
  const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
  if (!content) {
    return res.status(400).json({ error: "content is required" });
  }

  try {
    const assistantMessage = await chatService.sendMessage(req.userEmail, content);
    return res.json({ assistant: assistantMessage });
  } catch (error) {
    if (error?.code === "QUEUE_FULL") {
      return res.status(503).json({ error: error.message });
    }
    const isTimeout = error?.name === "AbortError";
    return res.status(500).json({
      error: isTimeout
        ? `Ollama request timeout (${config.OLLAMA_TIMEOUT_MS}ms).`
        : "Failed to get response from Ollama."
    });
  }
});

setInterval(() => {
  store.cleanupExpiredSessions();
}, 60_000);

app.listen(config.PORT, () => {
  console.log(`Server listening on ${config.BASE_URL}`);
});
