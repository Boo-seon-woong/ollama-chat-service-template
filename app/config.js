const path = require("path");
const fs = require("fs");

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

const ROOT_DIR = path.join(__dirname, "..");
const ENV_FILE = path.join(ROOT_DIR, ".env");
loadEnvFile(ENV_FILE);

const PORT = parsePositiveInt(process.env.PORT, 3000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const DATA_DIR = path.join(ROOT_DIR, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const MEMORY_DIR = path.join(DATA_DIR, "memories");

const APP_NAME = process.env.APP_NAME || "SAMPLE_TITLE";
const APP_CHAT_TITLE = process.env.APP_CHAT_TITLE || "my chat";
const APP_CONSOLE_LABEL = process.env.APP_CONSOLE_LABEL || `${APP_NAME} Console`;

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434/api/chat";
const MODEL = process.env.OLLAMA_MODEL || "BASIC_MODEL";
const OLLAMA_TIMEOUT_MS = parsePositiveInt(process.env.OLLAMA_TIMEOUT_MS, 60000);
const MAX_RECENT_MESSAGES = parsePositiveInt(process.env.MAX_RECENT_MESSAGES, 30);
const CHAT_QUEUE_MAX_PENDING = parsePositiveInt(process.env.CHAT_QUEUE_MAX_PENDING, 100);

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

module.exports = {
  ROOT_DIR,
  PORT,
  BASE_URL,
  PUBLIC_DIR,
  DATA_DIR,
  USERS_FILE,
  MEMORY_DIR,
  APP_NAME,
  APP_CHAT_TITLE,
  APP_CONSOLE_LABEL,
  OLLAMA_URL,
  MODEL,
  OLLAMA_TIMEOUT_MS,
  MAX_RECENT_MESSAGES,
  CHAT_QUEUE_MAX_PENDING,
  MAIL_SERVICE,
  MAIL_USER,
  MAIL_PASSWORD,
  MAIL_FROM_NAME,
  MAIL_VERIFY_SUBJECT,
  MAIL_VERIFY_HEADING,
  MAIL_VERIFY_MESSAGE,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SEC,
  SYSTEM_PROMPT,
  escapeHtml
};
