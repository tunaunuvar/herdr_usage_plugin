"use strict";

const { spawn } = require("node:child_process");
const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const https = require("node:https");

const REFRESH_MS = 60_000;
const CLAUDE_CACHE = path.join(os.homedir(), ".cache", "herdr-usage-limits", "claude.json");
const COMMAND_TIMEOUT_MS = 12_000;
const LANGUAGES = ["en", "tr", "es"];
let language = "en";
const text = (tr, en, es = en) => language === "tr" ? tr : language === "es" ? es : en;
const localized = (value) => Array.isArray(value) ? text(...value) : value;
const NO_ADAPTER = ["Bu eklentide kota adaptörü yok", "No quota adapter in this plugin", "Sin adaptador de cuota en este plugin"];
const AI_TOOLS = [
  { id: "codex", name: "Codex", command: "codex", note: ["Otomatik kota adaptörü", "Quota adapter available", "Adaptador de cuota disponible"] },
  { id: "omp", name: "Oh My Pi (OMP)", command: "omp", note: ["Bağlı OMP sağlayıcıları için otomatik kota", "Automatic quota data for connected OMP providers", "Cuotas automáticas de proveedores conectados a OMP"] },
  { id: "claude", name: "Claude Code", command: "claude", note: ["OMP veya statusline köprüsü ile kota", "Quotas via OMP or the statusline bridge", "Cuotas mediante OMP o el puente statusline"] },
  { id: "gemini", name: "Gemini CLI", command: "gemini", note: ["Gemini CLI içinde /stats model", "Run /stats model inside Gemini CLI", "Ejecuta /stats model en Gemini CLI"] },
  { id: "amp", name: "Amp", command: "amp", note: ["amp usage ile kredi bakiyesi", "Check credits with amp usage", "Consulta créditos con amp usage"] },
  { id: "opencode", name: "OpenCode", command: "opencode", note: ["Sağlayıcı girişleri hesap kotasını göstermez", "Provider sign-ins do not expose account quotas", "Los inicios de sesión del proveedor no muestran cuotas"] },
  { id: "commandcode", name: "Command Code", command: process.platform === "win32" ? "cmdc" : "command-code",
    aliases: process.platform === "win32" ? ["command-code"] : [],
    note: ["Canlı limitler için CLI içinde /usage çalıştır", "Run /usage in the CLI for live limits", "Ejecuta /usage en la CLI para ver límites"] },
  { id: "cursor", name: "Cursor Agent", command: "cursor-agent", note: NO_ADAPTER },
  { id: "copilot", name: "GitHub Copilot CLI", command: "copilot", note: NO_ADAPTER },
  { id: "aider", name: "Aider", command: "aider", note: NO_ADAPTER },
  { id: "hermes", name: "Hermes", command: "hermes", note: NO_ADAPTER },
  { id: "pi", name: "Pi", command: "pi", note: NO_ADAPTER },
  { id: "goose", name: "Goose", command: "goose", note: NO_ADAPTER },
  { id: "crush", name: "Crush", command: "crush", note: NO_ADAPTER },
  { id: "kiro", name: "Kiro CLI", command: "kiro-cli", note: NO_ADAPTER },
  { id: "qwen", name: "Qwen Code", command: "qwen", note: NO_ADAPTER },
  { id: "kimi", name: "Kimi CLI", command: "kimi", note: NO_ADAPTER },
  { id: "llm", name: "LLM CLI", command: "llm", note: NO_ADAPTER },
  { id: "ollama", name: "Ollama", command: "ollama", note: ["Yerel model aracı; kota adaptörü yok", "Local model tool; no quota adapter", "Modelos locales; sin adaptador de cuota"] },
];

function findExecutable(command) {
  const directories = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? ["", ...(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";")]
    : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      try {
        if (fs.statSync(path.join(directory, command + extension)).isFile()) return true;
      } catch { /* Continue through PATH. */ }
    }
  }
  return false;
}

const detectedTools = AI_TOOLS.filter((tool) => [tool.command, ...(tool.aliases || [])].some(findExecutable));
if (process.env.OPENROUTER_MANAGEMENT_KEY && !detectedTools.some((tool) => tool.id === "openrouter")) {
  detectedTools.push({ id: "openrouter", name: "OpenRouter", command: "OPENROUTER_MANAGEMENT_KEY", note: ["Yönetim anahtarıyla kredi verisi", "Credit data via management key", "Créditos mediante clave de gestión"] });
}
const COLORS = process.stdout.isTTY ? {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  cyan: "\x1b[38;5;81m", green: "\x1b[38;5;78m", yellow: "\x1b[38;5;214m",
  red: "\x1b[38;5;203m", muted: "\x1b[38;5;245m", purple: "\x1b[38;5;141m",
} : { reset: "", bold: "", dim: "", cyan: "", green: "", yellow: "", red: "", muted: "", purple: "" };
const DATE_OPTIONS = {
  weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  year: "numeric",
  timeZoneName: "short",
};
const RESET_DATE_FORMAT = {
  tr: new Intl.DateTimeFormat("tr-TR", DATE_OPTIONS),
  en: new Intl.DateTimeFormat("en-US", DATE_OPTIONS),
  es: new Intl.DateTimeFormat("es-ES", DATE_OPTIONS),
};
const TIME_FORMAT = {
  tr: new Intl.DateTimeFormat("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
  en: new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
  es: new Intl.DateTimeFormat("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
};

function run(command, args, timeoutMs = COMMAND_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    // Windows CLI installs commonly expose .cmd shims. shell:true lets Node
    // resolve those shims; command and arguments here are fixed constants.
    const child = spawn(command, args, {
      shell: process.platform === "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`${command} timed out`));
    }, timeoutMs);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", () => finish(new Error(`${command} is unavailable`)));
    child.on("close", (code) => {
      if (code !== 0) return finish(new Error(`${command} exited with code ${code}`));
      try {
        finish(null, JSON.parse(stdout));
      } catch {
        finish(new Error(`${command} returned invalid JSON`));
      }
    });
  });
}

function codexAppServer() {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["app-server"], {
      shell: process.platform === "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let buffer = "";
    let nextId = 0;
    const pending = new Map();
    let settled = false;
    let account = null;
    let rateLimits = null;
    const timer = setTimeout(() => {
      if (account || rateLimits) finish(null, { ...rateLimits, account,
        ...(!rateLimits ? { quotaError: "Codex rate-limit request timed out" } : {}) });
      else finish(new Error("Codex app-server timed out"));
    }, COMMAND_TIMEOUT_MS);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(value);
    }

    function receive(line) {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === undefined) return;
      const waiter = pending.get(String(message.id));
      if (!waiter) return;
      pending.delete(String(message.id));
      if (message.error) waiter.reject(new Error(message.error.message || "Codex request failed"));
      else waiter.resolve(message.result);
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) if (line.trim()) receive(line);
    });
    child.on("error", () => finish(new Error("Codex CLI is unavailable")));
    child.on("close", (code) => {
      if (!settled) finish(new Error(code === 0 ? "Codex app-server closed early" : "Codex app-server failed"));
    });

    function request(method, params) {
      const id = nextId++;
      return new Promise((res, rej) => {
        pending.set(String(id), { resolve: res, reject: rej });
        const message = { method, id };
        if (params !== undefined) message.params = params;
        child.stdin.write(`${JSON.stringify(message)}\n`);
      });
    }

    (async () => {
      try {
        await request("initialize", {
          clientInfo: { name: "herdr-usage-limits", version: "0.7.3" },
          capabilities: {},
        });
        child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
        await Promise.all([
          request("account/rateLimits/read").then((value) => { rateLimits = value; })
            .catch((error) => { rateLimits = { quotaError: error.message }; }),
          request("account/read", { refreshToken: false }).then((value) => { account = value?.account; }).catch(() => null),
        ]);
        finish(null, { ...rateLimits, account });
      } catch (error) {
        finish(error);
      }
    })();
  });
}

function percent(value, fraction = false) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const number = Number(value) * (fraction ? 100 : 1);
  return Math.max(0, Math.min(100, number));
}

function timestamp(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || /^\d+(\.\d+)?$/.test(String(value))) {
    let n = Number(value);
    if (n < 1e12) n *= 1000;
    return Number.isFinite(n) ? n : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timeLeft(ms) {
  const minutes = Math.ceil(Math.max(0, ms) / 60_000);
  if (minutes < 60) return `${minutes} ${text("dk", "min", "min")}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${text("sa", "hr", "h")} ${minutes % 60} ${text("dk", "min", "min")}`;
  return `${Math.floor(hours / 24)} ${text("g", "d", "d")} ${hours % 24} ${text("sa", "hr", "h")}`;
}

function resetText(value) {
  const at = timestamp(value);
  if (!at) return text("reset zamanı bildirilmedi", "reset time not reported", "reinicio no informado");
  const ms = at - Date.now();
  const date = RESET_DATE_FORMAT[language].format(new Date(at));
  if (ms <= 0) return `${date} · ${text("zamanı geçti", "elapsed", "vencido")}`;
  const countdown = text(`${timeLeft(ms)} sonra`, `in ${timeLeft(ms)}`, `en ${timeLeft(ms)}`);
  return `${date} · ${countdown}`;
}

function durationMinutes(source) {
  if (!source || typeof source !== "object") return null;
  for (const key of ["windowDurationMins", "window_duration_mins", "durationMins", "duration_minutes"]) {
    const n = Number(source[key]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  for (const key of ["durationMs", "duration_ms", "windowDurationMs", "window_duration_ms"]) {
    const n = Number(source[key]);
    if (Number.isFinite(n) && n > 0) return n / 60_000;
  }
  for (const key of ["durationSeconds", "duration_seconds", "windowDurationSeconds", "window_duration_seconds"]) {
    const n = Number(source[key]);
    if (Number.isFinite(n) && n > 0) return n / 60;
  }
  return null;
}

function windowRow(label, used, resetsAt, detail, windowMinutes = null, period = null) {
  return { label: String(label || text("Kullanım", "Usage", "Uso")), used: percent(used), resetsAt, detail, windowMinutes, period };
}

function formatDuration(minutes) {
  if (!Number.isFinite(Number(minutes))) return text("Kullanım", "Usage", "Uso");
  const n = Number(minutes);
  if (n === 300) return "5h";
  if (n === 10_080) return "7d";
  if (n % 1440 === 0) return `${n / 1440}d`;
  if (n % 60 === 0) return `${n / 60}h`;
  return `${n}m`;
}

async function codexUsage() {
  const data = await codexAppServer();
  return codexResult(data);
}

function codexResult(data) {
  const limits = data?.rateLimitsByLimitId?.codex
    || data?.rateLimitsByLimitId?.default
    || data?.rateLimits
    || data;
  if (!limits) throw new Error("Codex did not report account limits");
  const rows = ["primary", "secondary"].flatMap((key) => {
    const item = limits[key];
    if (!item) return [];
    return [windowRow(
      formatDuration(item.windowDurationMins ?? item.window_duration_mins),
      item.usedPercent ?? item.used_percent,
      item.resetsAt ?? item.resets_at,
      item.detail,
      durationMinutes(item),
      formatDuration(item.windowDurationMins ?? item.window_duration_mins),
    )];
  });
  return { title: "Codex / ChatGPT", rows, error: data.quotaError,
    accounts: [{ name: "ChatGPT", plan: data.account?.planType || limits.planType,
      resetCredits: data.rateLimitResetCredits }],
  };
}

function findOmpReports(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) findOmpReports(item, out);
  } else if (value && typeof value === "object") {
    if (Array.isArray(value.limits)) out.push(value);
    for (const [key, child] of Object.entries(value)) {
      if (key !== "limits") findOmpReports(child, out);
    }
  }
  return out;
}

function ompWindowRow(limit, provider, account) {
  const amount = limit.amount || {};
  const fraction = amount.usedFraction ?? amount.used_fraction;
  const rawPercent = fraction ?? limit.usedPercent ?? limit.used_percent;
  const used = rawPercent === null || rawPercent === undefined
    ? null
    : percent(rawPercent, fraction !== undefined && fraction !== null);
  const window = limit.window || {};
  const windowMinutes = durationMinutes(window);
  const period = window.label || window.id || null;
  const accountLabel = account?.label || account?.email || account?.name;
  const providerLabel = typeof provider === "string" ? provider : provider?.name || provider?.id || "Account";
  return {
    ...windowRow(
      `${providerLabel}${accountLabel ? ` ${accountLabel}` : ""} · ${limit.label || window.label || limit.id || "Usage"}`,
      used,
      window.resetsAt ?? window.resets_at ?? limit.resetsAt ?? limit.resets_at
        ?? limit.detail?.resetTime ?? limit.detail?.reset_time,
      limit.status && limit.status !== "ok" ? limit.status : limit.detail,
      windowMinutes,
      period,
    ),
    used,
  };
}

async function ompUsage() {
  const data = await run("omp", ["usage", "--json", "--redact"]);
  return ompResult(data);
}

function openrouterUsage() {
  return new Promise((resolve, reject) => {
    const request = https.get("https://openrouter.ai/api/v1/credits", {
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_MANAGEMENT_KEY}` },
      timeout: COMMAND_TIMEOUT_MS,
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if (response.statusCode !== 200) return reject(new Error(`OpenRouter credits request failed (${response.statusCode})`));
        try {
          resolve(openrouterResult(JSON.parse(body)));
        } catch (error) { reject(error); }
      });
    });
    request.on("timeout", () => request.destroy(new Error("OpenRouter request timed out")));
    request.on("error", reject);
  });
}

function openrouterResult(response) {
  const total = Number(response?.data?.total_credits);
  const used = Number(response?.data?.total_usage);
  if (!Number.isFinite(total) || !Number.isFinite(used) || total <= 0) throw new Error("OpenRouter returned no credit balance");
  return { title: "OpenRouter · credits", rows: [windowRow("Credits", used / total * 100, null,
    `${used.toFixed(2)} / ${total.toFixed(2)} credits used`)], accounts: [{ name: "OpenRouter", plan: "Management key" }] };
}

function ompResult(data) {
  const reports = findOmpReports(data);
  const accountInfo = (report) => ({ name: String(report.provider || report.providerId || "Account"),
    plan: report.metadata?.planType || report.metadata?.subscriptionType,
    resetCredits: report.resetCredits });
  const rowsFor = (items) => items.flatMap((report) => report.limits.map((limit) => ompWindowRow(
    limit,
    report.provider || report.providerId || report.provider_id,
    report.account || report,
  )));
  if (!reports.length) throw new Error("OMP reported no account limits");
  const claude = reports.filter((report) => report.provider === "anthropic");
  const others = reports.filter((report) => report.provider !== "anthropic");
  return { title: ["OMP · bağlı hesaplar", "OMP · connected accounts", "OMP · cuentas conectadas"], rows: rowsFor(others),
    accounts: others.map(accountInfo),
    note: !others.length ? ["Claude verileri [h] kartında.", "Claude data is in the [h] card.", "Los datos de Claude están en la tarjeta [h]."] : null,
    claude: claude.length ? { title: "Claude · OMP", rows: rowsFor(claude), accounts: claude.map(accountInfo) } : null,
  };
}

function claudeSnapshot(data) {
  return { savedAt: Date.now(), rows: [["five_hour", "5h", 300], ["seven_day", "7d", 10080],
    ["spend_limit", "Spend limit", null]].flatMap(([key, label, minutes]) => {
    const item = data.rate_limits?.[key];
    if (!item) return [];
    return [windowRow(label, item.used_percentage, timestamp(item.resets_at), null, minutes)];
  }) };
}

async function claudeUsage() {
  let snapshot;
  try { snapshot = JSON.parse(fs.readFileSync(CLAUDE_CACHE, "utf8")); }
  catch { throw Object.assign(new Error("Connect the Claude statusline bridge (README)."), { uiMessage: [
    "Claude statusline köprüsünü bağla (README). OMP'de bağlı Claude varsa otomatik gösterilir.",
    "Connect the Claude statusline bridge (README). Claude connected in OMP appears automatically.",
    "Conecta el puente statusline de Claude (README). Claude conectado a OMP aparece automáticamente."] }); }
  const rows = Array.isArray(snapshot.rows) ? snapshot.rows.slice(0, 3).map((row) =>
    windowRow(row.label, row.used, timestamp(row.resetsAt), null, row.windowMinutes)) : [];
  if (!rows.length || !timestamp(snapshot.savedAt)) throw new Error("Claude snapshot has no quota data");
  let plan;
  if (detectedTools.some((tool) => tool.id === "claude")) {
    try { plan = (await run("claude", ["auth", "status"])).subscriptionType; } catch { /* Quotas still work without auth metadata. */ }
  }
  return { title: "Claude · statusline", rows, snapshotAt: timestamp(snapshot.savedAt),
    accounts: [{ name: "Claude", plan }] };
}

function captureClaudeStatusline() {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
    if (input.length > 1024 * 1024) process.exit(1);
  });
  process.stdin.on("end", () => {
    try {
      const snapshot = claudeSnapshot(JSON.parse(input));
      if (snapshot.rows.length) {
        fs.mkdirSync(path.dirname(CLAUDE_CACHE), { recursive: true });
        fs.writeFileSync(CLAUDE_CACHE, JSON.stringify(snapshot), { mode: 0o600 });
      }
      process.stdout.write("Claude" + snapshot.rows.map((row) => ` | ${row.label}: ${row.used === null ? "—" : Math.round(row.used) + "%"}`).join(""));
    } catch { process.stdout.write("Claude"); }
  });
}

function progressBar(used, width = 22) {
  if (used === null) return `${COLORS.muted}${"·".repeat(width)}${COLORS.reset}`;
  const filled = Math.round((used / 100) * width);
  const color = used >= 90 ? COLORS.red : used >= 70 ? COLORS.yellow : COLORS.green;
  return `${color}${"█".repeat(filled)}${COLORS.muted}${"─".repeat(width - filled)}${COLORS.reset}`;
}

function isWeekly(row) {
  const minutes = Number(row.windowMinutes);
  return (minutes >= 6 * 24 * 60 && minutes <= 8 * 24 * 60)
    || /weekly|week|hafta|7\s*d|168\s*h/i.test(`${row.period || ""} ${row.label || ""}`);
}

const sections = [];
const SECTION_KEYS = { codex: "c", omp: "o", claude: "h", gemini: "g", amp: "m", opencode: "w",
  commandcode: "v", cursor: "u", copilot: "p", aider: "i", hermes: "e", pi: "j", goose: "n",
  crush: "s", kiro: "k", qwen: "y", kimi: "z", llm: "t", ollama: "x", openrouter: "f" };
const SECTION_NAMES = { codex: "Codex", omp: "OMP", claude: "Claude", openrouter: "OpenRouter" };
const ADAPTERS = new Set(["codex", "omp", "claude", "openrouter"]);
const collapsed = new Set(["d", ...detectedTools.filter((tool) => !ADAPTERS.has(tool.id))
  .map((tool) => SECTION_KEYS[tool.id]).filter(Boolean)]);
for (const tool of detectedTools) {
  const key = SECTION_KEYS[tool.id];
  if (key) sections.push([key, SECTION_NAMES[tool.id] || tool.name]);
}
if (fs.existsSync(CLAUDE_CACHE) && !sections.some(([key]) => key === "h")) sections.push(["h", "Claude"]);
let latestResults = new Map();
let updatedAt = null;
let scrollOffset = 0;
let scrollEnd = 0;
let pageRows = 1;

const clean = (value) => String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const panelWidth = () => Math.max(16, Math.min(104, (process.stdout.columns || 90) - 2));

function cellWidth(char) {
  if (/\p{Mark}/u.test(char) || char === "\u200d") return 0;
  const code = char.codePointAt(0);
  return code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xff01 && code <= 0xff60) || (code >= 0x1f300 && code <= 0x1faff)
    || code >= 0x20000) ? 2 : 1;
}

function visibleWidth(value) {
  return Array.from(String(value).replace(/\x1b\[[0-9;]*m/g, ""))
    .reduce((width, char) => width + cellWidth(char), 0);
}

function fit(value, width, padding = " ") {
  width = Math.max(0, width);
  const truncated = visibleWidth(value) > width;
  const limit = truncated ? Math.max(0, width - 1) : width;
  let output = "";
  let used = 0;
  for (const token of String(value).match(/\x1b\[[0-9;]*m|[^\x1b]/gu) || []) {
    if (token.startsWith("\x1b")) { output += token; continue; }
    const size = cellWidth(token);
    if (used + size > limit) break;
    output += token;
    used += size;
  }
  if (truncated && width) { output += "…"; used++; }
  return output + COLORS.reset + (padding === "─" ? COLORS.muted : "") + padding.repeat(Math.max(0, width - used));
}

function pair(left, right, width) {
  const rightWidth = Math.min(visibleWidth(right), Math.max(0, width - 1));
  return fit(left, width - rightWidth) + fit(right, rightWidth);
}

function wrap(value, width) {
  const lines = [];
  let line = "";
  for (const word of clean(value).split(/\s+/).filter(Boolean)) {
    if (line && visibleWidth(line + " " + word) > width) { lines.push(line); line = ""; }
    line += (line ? " " : "") + word;
  }
  if (line) lines.push(line);
  return lines;
}

function frame(title, body, width) {
  const inner = width - 2;
  return [
    `${COLORS.muted}╭${fit(` ${title} `, inner, "─")}${COLORS.muted}╮${COLORS.reset}`,
    ...body.map((line) => `${COLORS.muted}│${COLORS.reset}${fit(line, inner)}${COLORS.muted}│${COLORS.reset}`),
    `${COLORS.muted}╰${"─".repeat(inner)}╯${COLORS.reset}`,
  ];
}

function accountLines(account) {
  const unknown = text("bildirilmedi", "not reported", "no informado");
  const lines = [text(`Paket · ${account.name}: ${account.plan || unknown}`,
    `Plan · ${account.name}: ${account.plan || unknown}`, `Plan · ${account.name}: ${account.plan || unknown}`),
    text("Abonelik bitişi · bildirilmedi", "Subscription expiry · not reported", "Fin de suscripción · no informado")];
  const resets = account.resetCredits;
  const count = resets?.availableCount;
  lines.push(text(`Yenileme hakkı · ${count !== null && count !== undefined && Number.isFinite(Number(count)) ? count : unknown}`,
    `Saved resets · ${count !== null && count !== undefined && Number.isFinite(Number(count)) ? count : unknown}`,
    `Reinicios guardados · ${count !== null && count !== undefined && Number.isFinite(Number(count)) ? count : unknown}`));
  if (resets?.redeemableCount !== undefined) lines.push(text(`Şimdi kullanılabilir · ${resets.redeemableCount}`,
    `Redeemable now · ${resets.redeemableCount}`, `Disponibles ahora · ${resets.redeemableCount}`));
  if (resets?.cooldownUntil) lines.push(`${text("Bekleme süresi", "Cooldown", "Tiempo de espera")} · ${resetText(resets.cooldownUntil)}`);
  for (const credit of Array.isArray(resets?.credits) ? resets.credits : []) {
    const expiry = credit.expiresAt === null ? text("süre sınırı yok", "no expiry", "sin vencimiento")
      : credit.expiresAt === undefined ? unknown : resetText(credit.expiresAt);
    const countLabel = credit.remainingCount === undefined ? "" : ` ×${credit.remainingCount}`;
    lines.push(text(`Hak son kullanımı · ${credit.title || "Reset"}${countLabel}: ${expiry}`,
      `Reset credit expiry · ${credit.title || "Reset"}${countLabel}: ${expiry}`,
      `Vencimiento del reinicio · ${credit.title || "Reset"}${countLabel}: ${expiry}`));
  }
  if (Number(count) > 0 && !resets?.credits?.length) lines.push(text("Hak son kullanımı · bildirilmedi", "Reset credit expiry · not reported", "Vencimiento del reinicio · no informado"));
  return lines;
}

function renderSection(key, name, result, width = panelWidth()) {
  const folded = collapsed.has(key);
  const marker = folded ? "▸" : "▾";
  const rows = result.rows || [];
  const status = result.error ? `${COLORS.red}${text("VERİ YOK", "NO DATA", "SIN DATOS")}`
    : result.loading ? `${COLORS.yellow}${text("BEKLİYOR", "WAITING", "ESPERANDO")}`
    : result.info ? `${COLORS.muted}${text("BİLGİ", "INFO", "INFO")}`
    : result.snapshotAt ? `${COLORS.yellow}${text("SON ÖLÇÜM", "SNAPSHOT", "ÚLTIMA LECTURA")}`
    : `${COLORS.green}${text("CANLI", "LIVE", "EN VIVO")}`;
  const title = `${COLORS.muted}[${key}] ${COLORS.cyan}${COLORS.bold}${marker} ${clean(localized(result.title) || name)}${COLORS.reset}  ${status}${COLORS.reset}`;
  const lines = [];
  const contentWidth = width - 6;
  if (folded) {
    const count = text(`${rows.length} kota penceresi`, `${rows.length} quota windows`, `${rows.length} períodos de cuota`);
    const weekly = rows.some(isWeekly) ? text(" · haftalık reset var", " · weekly reset", " · reinicio semanal") : "";
    if (rows.length) lines.push(`  ${COLORS.muted}${count}${weekly}${COLORS.reset}`);
    else if (result.info) lines.push(`  ${COLORS.muted}${localized(result.note)}${COLORS.reset}`);
    return frame(title, lines, width);
  }
  if (!result.loading && !result.info) {
    for (const account of result.accounts || [{ name }]) {
      lines.push(...accountLines(account).flatMap((line) => wrap(line, contentWidth)
        .map((part) => `  ${COLORS.muted}${part}${COLORS.reset}`)), "");
    }
    if (result.snapshotAt) lines.push(...wrap(text(`Son Claude ölçümü · ${resetText(result.snapshotAt)}; Claude çalışırken güncellenir.`,
      `Last Claude snapshot · ${resetText(result.snapshotAt)}; updates while Claude runs.`,
      `Última lectura de Claude · ${resetText(result.snapshotAt)}; se actualiza mientras Claude está activo.`), contentWidth)
      .map((line) => `  ${COLORS.yellow}${line}${COLORS.reset}`), "");
    if (result.note) lines.push(...wrap(localized(result.note), contentWidth).map((line) => `  ${COLORS.muted}${line}${COLORS.reset}`));
  }
  if (result.error || result.loading) {
    const message = result.error ? `${localized(result.error)}. ${text("Girişi ve CLI kurulumunu kontrol et.", "Check sign-in and CLI availability.", "Comprueba el inicio de sesión y la instalación de la CLI.")}`
      : text("Kota bilgileri alınıyor…", "Fetching quota data…", "Obteniendo datos de cuota…");
    lines.push(...wrap(message, contentWidth).map((line) => `  ${COLORS.muted}${line}${COLORS.reset}`));
    return frame(title, lines, width);
  }
  if (result.note && !rows.length) {
    lines.push(...wrap(localized(result.note), contentWidth).map((line) => `  ${COLORS.muted}${line}${COLORS.reset}`));
    return frame(title, lines, width);
  }
  for (const [index, row] of rows.entries()) {
    if (index) lines.push("");
    const label = `${isWeekly(row) ? `${COLORS.purple}[${text("HAFTALIK", "WEEKLY", "SEMANAL")}] ${COLORS.reset}` : ""}${COLORS.bold}${clean(row.label)}${COLORS.reset}`;
    const color = row.used >= 90 ? COLORS.red : row.used >= 70 ? COLORS.yellow : COLORS.green;
    const value = row.used === null
      ? `${COLORS.muted}—${COLORS.reset}`
      : `${color}${COLORS.bold}${Math.round(row.used)}%${COLORS.reset} ${COLORS.muted}${text("kullanım", "used", "usado")}${COLORS.reset}`;
    const remaining = row.used === null ? text("veri yok", "no data", "sin datos")
      : `${Math.round(100 - row.used)}% ${text("kaldı", "left", "restante")}`;
    const barWidth = Math.max(3, Math.min(32, contentWidth - visibleWidth(remaining) - 2));
    lines.push(`  ${pair(label, value, contentWidth)}`);
    lines.push(`  ${pair(progressBar(row.used, barWidth), `${COLORS.muted}${remaining}${COLORS.reset}`, contentWidth)}`);
    lines.push(...wrap(`${text("Reset", "Reset", "Reinicio")} · ${resetText(row.resetsAt)}`, contentWidth)
      .map((line) => `  ${COLORS.muted}${line}${COLORS.reset}`));
    if (typeof row.detail === "string" && row.detail) lines.push(`  ${COLORS.muted}${clean(row.detail)}${COLORS.reset}`);
  }
  return frame(title, lines, width);
}

function renderDiscovery(width = panelWidth()) {
  const folded = collapsed.has("d");
  const heading = text("Tespit edilen AI CLI'ları", "Detected AI CLIs", "CLI de IA detectadas");
  const title = `${COLORS.muted}[d] ${COLORS.cyan}${folded ? "▸" : "▾"} ${heading}${COLORS.reset} ${COLORS.muted}· ${detectedTools.length}${COLORS.reset}`;
  const lines = [];
  if (folded) return frame(title, lines, width);
  if (!detectedTools.length) {
    lines.push(...wrap(text("Bilinen AI CLI'ları Herdr'nin PATH'inde bulunamadı.", "No known AI CLIs found on Herdr's PATH.", "No se encontraron CLI de IA conocidas en el PATH de Herdr."), width - 6)
      .map((line) => `  ${COLORS.muted}${line}${COLORS.reset}`));
    return frame(title, lines, width);
  }
  for (const tool of detectedTools) {
    const hasAdapter = ["codex", "omp", "claude", "openrouter"].includes(tool.id);
    const status = hasAdapter ? text("kota panelinde", "quota panel", "panel de cuotas") : text("tespit edildi", "detected", "detectada");
    lines.push(`  ${pair(`${COLORS.bold}${tool.name}${COLORS.reset}`, `${hasAdapter ? COLORS.green : COLORS.muted}${status}${COLORS.reset}`, width - 6)}`);
    if (!hasAdapter || tool.id === "claude" || tool.id === "openrouter") lines.push(`  ${COLORS.muted}${localized(tool.note)}${COLORS.reset}`);
    if (!hasAdapter) lines.push(...wrap(text("Paket / abonelik bitişi / yenileme hakkı · veri kaynağı yok",
      "Plan / subscription expiry / saved resets · no data source", "Plan / fin de suscripción / reinicios · sin fuente de datos"), width - 6)
      .map((line) => `  ${COLORS.muted}${line}${COLORS.reset}`));
  }
  return frame(title, lines, width);
}

function draw() {
  const width = panelWidth();
  const body = [];
  const rows = [...latestResults.values()].flatMap((result) => result.rows || []);
  const weekly = rows.filter(isWeekly).length;
  const status = refreshing ? `${COLORS.yellow}${text("YENİLENİYOR", "SYNCING", "ACTUALIZANDO")}` : `${COLORS.green}${text("HAZIR", "READY", "LISTO")}`;
  const summary = text(`${rows.length} kota penceresi · ${weekly} haftalık`, `${rows.length} quota windows · ${weekly} weekly`, `${rows.length} períodos de cuota · ${weekly} semanales`);
  for (const [key, name] of sections) {
    body.push(...renderSection(key, name, latestResults.get(name) || { title: name, loading: true }, width), "");
  }
  if (!sections.length) body.push(...frame(`${COLORS.yellow}${text("Kota kaynağı bulunamadı", "No quota source found", "Sin fuente de cuotas")}${COLORS.reset}`,
    wrap(text("Codex / OMP'ye giriş yap veya Claude statusline köprüsünü bağla.", "Sign in to Codex / OMP or connect the Claude statusline bridge.", "Inicia sesión en Codex / OMP o conecta el puente statusline de Claude."), width - 6)
      .map((line) => `  ${COLORS.muted}${line}${COLORS.reset}`), width), "");
  body.push(...renderDiscovery(width));
  pageRows = process.stdout.isTTY ? Math.max(1, (process.stdout.rows || 30) - 6) : body.length;
  scrollEnd = Math.max(0, body.length - pageRows);
  scrollOffset = Math.max(0, Math.min(scrollOffset, scrollEnd));
  const viewport = body.slice(scrollOffset, scrollOffset + pageRows);
  while (viewport.length < pageRows) viewport.push("");
  const lines = [
    pair(`${COLORS.cyan}${COLORS.bold}HERDR${COLORS.reset} ${COLORS.muted}/ ${text("AI KOTA", "AI USAGE", "CUOTAS DE IA")}${COLORS.reset}`, `${status}${COLORS.reset}`, width),
    pair(`${COLORS.muted}${summary}${COLORS.reset}`, `${COLORS.muted}${updatedAt
      ? typeof updatedAt === "number" ? TIME_FORMAT[language].format(updatedAt) : updatedAt
      : "—"} · 60s${COLORS.reset}`, width),
    "",
    ...viewport,
    `${COLORS.muted}${"─".repeat(width)}${COLORS.reset}`,
    pair(width < 52 ? `${COLORS.cyan}[r]  [q/Esc]${COLORS.reset}`
      : `${COLORS.cyan}[r]${COLORS.reset} ${text("Yenile", "Refresh", "Actualizar")}  ${COLORS.cyan}[q/Esc]${COLORS.reset} ${text("Kapat", "Close", "Cerrar")}`,
      scrollEnd ? `${COLORS.muted}↑↓ ${scrollOffset + 1}/${scrollEnd + 1}${COLORS.reset}` : "", width),
    fit(`${COLORS.muted}${[["l", text("Español", "Türkçe", "English")], ...sections, ["d", "CLI"], ["a", text("Aç/kapat", "Toggle all", "Alternar todo")]]
      .map(([key, name]) => `[${key}]${width < 48 ? "" : ` ${name}`}`).join("  ")}${COLORS.reset}`, width),
  ];
  process.stdout.write(process.stdout.isTTY
    ? "\x1b[H" + lines.map((line) => "\x1b[2K" + line).join("\r\n") + "\x1b[J"
    : lines.join("\n") + "\n");
}

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  draw();
  const specs = [];
  if (detectedTools.some((tool) => tool.id === "codex")) specs.push(["Codex", codexUsage]);
  if (detectedTools.some((tool) => tool.id === "omp")) specs.push(["OMP", ompUsage]);
  if (sections.some(([key]) => key === "h")) specs.push(["Claude", claudeUsage]);
  if (detectedTools.some((tool) => tool.id === "openrouter")) specs.push(["OpenRouter", openrouterUsage]);
  for (const tool of detectedTools.filter((item) => !["codex", "omp", "claude", "openrouter"].includes(item.id))) {
    specs.push([tool.name, async () => ({ title: tool.name, note: tool.note, info: true })]);
  }
  await Promise.all(specs.map(async ([name, fetcher]) => {
    let timer;
    try {
      const result = await Promise.race([fetcher(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} usage query timed out`)), COMMAND_TIMEOUT_MS + 1000);
      })]);
      latestResults.set(name, result);
      if (name === "OMP" && result.claude) {
        latestResults.set("Claude", result.claude);
        if (!sections.some(([key]) => key === "h")) sections.push(["h", "Claude"]);
      }
    } catch (error) {
      latestResults.set(name, { error: error.uiMessage || error.message });
    } finally {
      clearTimeout(timer);
      updatedAt = Date.now();
      draw();
    }
  }));
  refreshing = false;
  draw();
}

function start() {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[?1049h\x1b[?25l");
    process.stdout.on("resize", draw);
    process.once("exit", () => {
      if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false);
      process.stdout.write("\x1b[0m\x1b[?25h\x1b[?1049l");
    });
    process.once("SIGTERM", () => process.exit(0));
  }
  const interval = setInterval(refresh, REFRESH_MS);
  if (process.stdin.isTTY && process.stdin.setRawMode) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", (_str, key) => {
      if ((key.ctrl && key.name === "c") || key.name === "q" || key.name === "escape") {
        clearInterval(interval);
        process.stdin.setRawMode(false);
        process.exit(0);
      }
      if (key.name === "r") refresh();
      if (key.name === "l") {
        language = LANGUAGES[(LANGUAGES.indexOf(language) + 1) % LANGUAGES.length];
        scrollOffset = 0;
        draw();
      }
      if ([...sections.map(([id]) => id), "d"].includes(key.name)) {
        if (collapsed.has(key.name)) collapsed.delete(key.name);
        else collapsed.add(key.name);
        scrollOffset = 0;
        draw();
      }
      if (key.name === "a") {
        const allSections = [...sections.map(([id]) => id), "d"];
        if (allSections.every((id) => collapsed.has(id))) collapsed.clear();
        else for (const id of allSections) collapsed.add(id);
        scrollOffset = 0;
        draw();
      }
      const steps = { up: -1, down: 1, pageup: -pageRows, pagedown: pageRows };
      if (key.name in steps) { scrollOffset += steps[key.name]; draw(); }
      if (key.name === "home" || key.name === "end") {
        scrollOffset = key.name === "home" ? 0 : scrollEnd;
        draw();
      }
    });
  }
  refresh();
}

if (require.main === module) {
  if (process.argv.includes("--claude-statusline")) captureClaudeStatusline();
  else start();
}
