const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function createStore({
  dataDir,
  usersFile,
  memoryDir,
  sessionCookieName,
  sessionMaxAgeSec,
  maxRecentMessages
}) {
  const sessions = new Map();
  const chatStates = new Map();
  let users = [];

  function ensureDataFiles() {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(memoryDir, { recursive: true });
    if (!fs.existsSync(usersFile)) {
      fs.writeFileSync(usersFile, JSON.stringify({ users: [] }, null, 2), "utf8");
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
      .slice(-maxRecentMessages);
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
    return path.join(memoryDir, `${emailKey(email)}.json`);
  }

  function loadUsers() {
    const raw = readJson(usersFile, { users: [] });
    return Array.isArray(raw?.users) ? raw.users : [];
  }

  function saveUsers() {
    writeJson(usersFile, { users });
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
    state.messages = sanitizeMessages(state.messages);
    state.updatedAt = Number.isFinite(state.updatedAt) ? state.updatedAt : Date.now();
    saveUserMemory(email, state);
  }

  function ensureUserMemoryFile(email) {
    const memoryFile = getMemoryFileByEmail(email);
    if (!fs.existsSync(memoryFile)) {
      writeJson(memoryFile, defaultMemoryData());
    }
  }

  function findUserByVerifyToken(token) {
    return users.find((u) => u.verifyToken === token);
  }

  function markUserVerified(user) {
    user.verified = true;
    user.verifyToken = "";
    user.verifiedAt = Date.now();
    user.updatedAt = Date.now();
    saveUsers();
  }

  function createOrUpdateUserForVerification(email, password) {
    const verifyToken = crypto.randomBytes(24).toString("hex");
    const now = Date.now();
    const existing = users.find((u) => u.email === email);

    if (existing && existing.verified) {
      return { ok: false, reason: "ALREADY_VERIFIED" };
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
    return { ok: true, verifyToken };
  }

  function authenticateUser(email, password) {
    const user = users.find((u) => u.email === email);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return { ok: false, reason: "INVALID_CREDENTIALS" };
    }

    if (!user.verified) {
      return { ok: false, reason: "NOT_VERIFIED" };
    }

    return { ok: true, user };
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
    const token = parseCookies(req)[sessionCookieName];
    if (!token) return null;

    const session = sessions.get(token);
    if (!session) return null;

    if (session.expiresAt < Date.now()) {
      sessions.delete(token);
      return null;
    }

    return { token, email: session.email };
  }

  function createSession(email) {
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, {
      email,
      expiresAt: Date.now() + sessionMaxAgeSec * 1000
    });
    return token;
  }

  function deleteSession(token) {
    sessions.delete(token);
  }

  function setSessionCookie(res, token) {
    res.setHeader(
      "Set-Cookie",
      `${sessionCookieName}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${sessionMaxAgeSec}`
    );
  }

  function clearSessionCookie(res) {
    res.setHeader(
      "Set-Cookie",
      `${sessionCookieName}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`
    );
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

  function cleanupExpiredSessions() {
    const now = Date.now();
    for (const [token, session] of sessions) {
      if (session.expiresAt < now) {
        sessions.delete(token);
      }
    }
  }

  function initialize() {
    ensureDataFiles();
    users = loadUsers();
  }

  return {
    initialize,
    normalizeEmail,
    validEmail,
    createOrUpdateUserForVerification,
    authenticateUser,
    findUserByVerifyToken,
    markUserVerified,
    ensureUserMemoryFile,
    getUserState,
    persistUserState,
    getSession,
    createSession,
    deleteSession,
    setSessionCookie,
    clearSessionCookie,
    requireApiAuth,
    requirePageAuth,
    cleanupExpiredSessions
  };
}

module.exports = {
  createStore
};
