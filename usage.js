"use strict";

const { spawn } = require("node:child_process");
const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");

const REFRESH_MS = 60_000;
const COMMAND_TIMEOUT_MS = 12_000;
const LOCALE = Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
const IS_TURKISH = LOCALE.toLowerCase().startsWith("tr");
const text = (tr, en) => IS_TURKISH ? tr : en;
const NO_ADAPTER = text("Bu eklentide kota adaptörü yok", "No quota adapter in this plugin");
const AI_TOOLS = [
  { id: "codex", name: "Codex", command: "codex", note: text("Otomatik kota adaptörü", "Quota adapter available") },
  { id: "omp", name: "Oh My Pi (OMP)", command: "omp", note: text("Bağlı OMP sağlayıcıları için otomatik kota", "Automatic quota data for connected OMP providers") },
  { id: "claude", name: "Claude Code", command: "claude", note: text("Claude Code içinde /usage", "Run /usage inside Claude Code") },
  { id: "gemini", name: "Gemini CLI", command: "gemini", note: text("Gemini CLI içinde /stats model", "Run /stats model inside Gemini CLI") },
  { id: "amp", name: "Amp", command: "amp", note: text("amp usage ile kredi bakiyesi", "Check credits with amp usage") },
  { id: "opencode", name: "OpenCode", command: "opencode", note: text("Oturum istatistiği hesap kotası değildir", "Session stats are not account quotas") },
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
  { id: "ollama", name: "Ollama", command: "ollama", note: text("Yerel model aracı; kota adaptörü yok", "Local model tool; no quota adapter") },
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

const detectedTools = AI_TOOLS.filter((tool) => findExecutable(tool.command));
const COLORS = process.stdout.isTTY ? {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  cyan: "\x1b[38;5;81m", green: "\x1b[38;5;78m", yellow: "\x1b[38;5;214m",
  red: "\x1b[38;5;203m", muted: "\x1b[38;5;245m", purple: "\x1b[38;5;141m",
} : { reset: "", bold: "", dim: "", cyan: "", green: "", yellow: "", red: "", muted: "", purple: "" };
const RESET_DATE_FORMAT = new Intl.DateTimeFormat(LOCALE, {
  weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  timeZoneName: "short",
});

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
    const timer = setTimeout(() => finish(new Error("Codex app-server timed out")), COMMAND_TIMEOUT_MS);

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
          clientInfo: { name: "herdr-usage-limits", version: "0.4.1" },
          capabilities: {},
        });
        child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
        const limits = await request("account/rateLimits/read");
        finish(null, limits);
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
  if (minutes < 60) return `${minutes} ${text("dk", "min")}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${text("sa", "hr")} ${minutes % 60} ${text("dk", "min")}`;
  return `${Math.floor(hours / 24)} ${text("g", "d")} ${hours % 24} ${text("sa", "hr")}`;
}

function resetText(value) {
  const at = timestamp(value);
  if (!at) return text("reset zamanı bildirilmedi", "reset time not reported");
  const ms = at - Date.now();
  const date = RESET_DATE_FORMAT.format(new Date(at));
  if (ms <= 0) return `${date} · ${text("zamanı geçti", "elapsed")}`;
  const countdown = IS_TURKISH ? `${timeLeft(ms)} sonra` : `in ${timeLeft(ms)}`;
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
  return { label: String(label || text("Kullanım", "Usage")), used: percent(used), resetsAt, detail, windowMinutes, period };
}

function formatDuration(minutes) {
  if (!Number.isFinite(Number(minutes))) return text("Kullanım", "Usage");
  const n = Number(minutes);
  if (n === 300) return "5h";
  if (n === 10_080) return "7d";
  if (n % 1440 === 0) return `${n / 1440}d`;
  if (n % 60 === 0) return `${n / 60}h`;
  return `${n}m`;
}

async function codexUsage() {
  const data = await codexAppServer();
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
  if (!rows.length) throw new Error("Codex has no rate-limit windows to show");
  return { title: `Codex${limits.planType ? ` · ${limits.planType}` : ""}`, rows };
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
  const reports = findOmpReports(data);
  const rows = reports.flatMap((report) => report.limits.map((limit) => ompWindowRow(
    limit,
    report.provider || report.providerId || report.provider_id,
    report.account || report,
  )));
  if (!rows.length) throw new Error("OMP reported no account limits");
  return { title: text("OMP · bağlı hesaplar", "OMP · connected accounts"), rows };
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

const collapsed = new Set(["d"]);
const sections = [];
if (detectedTools.some((tool) => tool.id === "codex")) sections.push(["c", "Codex"]);
if (detectedTools.some((tool) => tool.id === "omp")) sections.push(["o", "OMP"]);
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

function renderSection(key, name, result, width = panelWidth()) {
  const folded = collapsed.has(key);
  const marker = folded ? "▸" : "▾";
  const rows = result.rows || [];
  const status = result.error ? `${COLORS.red}${text("VERİ YOK", "NO DATA")}`
    : result.loading ? `${COLORS.yellow}${text("BEKLİYOR", "WAITING")}`
    : `${COLORS.green}${text("CANLI", "LIVE")}`;
  const title = `${COLORS.muted}[${key}] ${COLORS.cyan}${COLORS.bold}${marker} ${clean(result.title || name)}${COLORS.reset}  ${status}${COLORS.reset}`;
  const lines = [];
  const contentWidth = width - 6;
  if (folded) {
    const count = text(`${rows.length} kota penceresi`, `${rows.length} quota windows`);
    const weekly = rows.some(isWeekly) ? text(" · haftalık reset var", " · weekly reset") : "";
    if (rows.length) lines.push(`  ${COLORS.muted}${count}${weekly}${COLORS.reset}`);
    return frame(title, lines, width);
  }
  if (result.error || result.loading) {
    const message = result.error || text("Kota bilgileri alınıyor…", "Fetching quota data…");
    lines.push(...wrap(message, contentWidth).map((line) => `  ${COLORS.muted}${line}${COLORS.reset}`));
    return frame(title, lines, width);
  }
  for (const [index, row] of rows.entries()) {
    if (index) lines.push("");
    const label = `${isWeekly(row) ? `${COLORS.purple}[${text("HAFTALIK", "WEEKLY")}] ${COLORS.reset}` : ""}${COLORS.bold}${clean(row.label)}${COLORS.reset}`;
    const color = row.used >= 90 ? COLORS.red : row.used >= 70 ? COLORS.yellow : COLORS.green;
    const value = row.used === null
      ? `${COLORS.muted}—${COLORS.reset}`
      : `${color}${COLORS.bold}${Math.round(row.used)}%${COLORS.reset} ${COLORS.muted}${text("kullanım", "used")}${COLORS.reset}`;
    const remaining = row.used === null ? text("veri yok", "no data")
      : `${Math.round(100 - row.used)}% ${text("kaldı", "left")}`;
    const barWidth = Math.max(3, Math.min(32, contentWidth - visibleWidth(remaining) - 2));
    lines.push(`  ${pair(label, value, contentWidth)}`);
    lines.push(`  ${pair(progressBar(row.used, barWidth), `${COLORS.muted}${remaining}${COLORS.reset}`, contentWidth)}`);
    lines.push(...wrap(`Reset · ${resetText(row.resetsAt)}`, contentWidth)
      .map((line) => `  ${COLORS.muted}${line}${COLORS.reset}`));
    if (typeof row.detail === "string" && row.detail) lines.push(`  ${COLORS.muted}${clean(row.detail)}${COLORS.reset}`);
  }
  return frame(title, lines, width);
}

function renderDiscovery(width = panelWidth()) {
  const folded = collapsed.has("d");
  const heading = text("Tespit edilen AI CLI'ları", "Detected AI CLIs");
  const title = `${COLORS.muted}[d] ${COLORS.cyan}${folded ? "▸" : "▾"} ${heading}${COLORS.reset} ${COLORS.muted}· ${detectedTools.length}${COLORS.reset}`;
  const lines = [];
  if (folded) return frame(title, lines, width);
  if (!detectedTools.length) {
    lines.push(...wrap(text("Bilinen AI CLI'ları Herdr'nin PATH'inde bulunamadı.", "No known AI CLIs found on Herdr's PATH."), width - 6)
      .map((line) => `  ${COLORS.muted}${line}${COLORS.reset}`));
    return frame(title, lines, width);
  }
  for (const tool of detectedTools) {
    const hasAdapter = tool.id === "codex" || tool.id === "omp";
    const status = hasAdapter ? text("kota panelinde", "quota panel") : text("tespit edildi", "detected");
    lines.push(`  ${pair(`${COLORS.bold}${tool.name}${COLORS.reset}`, `${hasAdapter ? COLORS.green : COLORS.muted}${status}${COLORS.reset}`, width - 6)}`);
    if (!hasAdapter) lines.push(`  ${COLORS.muted}${tool.note}${COLORS.reset}`);
  }
  return frame(title, lines, width);
}

function draw() {
  const width = panelWidth();
  const body = [];
  const rows = [...latestResults.values()].flatMap((result) => result.rows || []);
  const weekly = rows.filter(isWeekly).length;
  const status = refreshing ? `${COLORS.yellow}${text("YENİLENİYOR", "SYNCING")}` : `${COLORS.green}${text("HAZIR", "READY")}`;
  const summary = text(`${rows.length} kota penceresi · ${weekly} haftalık`, `${rows.length} quota windows · ${weekly} weekly`);
  for (const [key, name] of sections) {
    body.push(...renderSection(key, name, latestResults.get(name) || { title: name, loading: true }, width), "");
  }
  if (!sections.length) body.push(...frame(`${COLORS.yellow}${text("Kota kaynağı bulunamadı", "No quota source found")}${COLORS.reset}`,
    wrap(text("Canlı kota için Codex veya OMP kurup giriş yap.", "Install and sign in to Codex or OMP for live quotas."), width - 6)
      .map((line) => `  ${COLORS.muted}${line}${COLORS.reset}`), width), "");
  body.push(...renderDiscovery(width));
  pageRows = process.stdout.isTTY ? Math.max(1, (process.stdout.rows || 30) - 6) : body.length;
  scrollEnd = Math.max(0, body.length - pageRows);
  scrollOffset = Math.max(0, Math.min(scrollOffset, scrollEnd));
  const viewport = body.slice(scrollOffset, scrollOffset + pageRows);
  while (viewport.length < pageRows) viewport.push("");
  const lines = [
    pair(`${COLORS.cyan}${COLORS.bold}HERDR${COLORS.reset} ${COLORS.muted}/ ${text("AI KOTA", "AI USAGE")}${COLORS.reset}`, `${status}${COLORS.reset}`, width),
    pair(`${COLORS.muted}${summary}${COLORS.reset}`, `${COLORS.muted}${updatedAt || "—"} · 60s${COLORS.reset}`, width),
    "",
    ...viewport,
    `${COLORS.muted}${"─".repeat(width)}${COLORS.reset}`,
    pair(width < 52 ? `${COLORS.cyan}[r]  [q/Esc]${COLORS.reset}`
      : `${COLORS.cyan}[r]${COLORS.reset} ${text("Yenile", "Refresh")}  ${COLORS.cyan}[q/Esc]${COLORS.reset} ${text("Kapat", "Close")}`,
      scrollEnd ? `${COLORS.muted}↑↓ ${scrollOffset + 1}/${scrollEnd + 1}${COLORS.reset}` : "", width),
    fit(`${COLORS.muted}${width < 48 ? "[c] [o] [d] [a]" : text("[c] Codex  [o] OMP  [d] CLI  [a] Aç/kapat", "[c] Codex  [o] OMP  [d] CLI  [a] Toggle all")}${COLORS.reset}`, width),
  ];
  process.stdout.write(process.stdout.isTTY ? "\x1b[H" + lines.join("\n") + "\x1b[J" : lines.join("\n") + "\n");
}

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  draw();
  const specs = [];
  if (detectedTools.some((tool) => tool.id === "codex")) specs.push(["Codex", codexUsage]);
  if (detectedTools.some((tool) => tool.id === "omp")) specs.push(["OMP", ompUsage]);
  const results = await Promise.all(specs.map(async ([name, fetcher]) => {
    try { return [name, await fetcher()]; }
    catch (error) { return [name, { error: `${error.message}. ${text("Girişi ve CLI kurulumunu kontrol et.", "Check sign-in and CLI availability.")}` }]; }
  }));
  latestResults = new Map(results);
  updatedAt = new Date().toLocaleTimeString(LOCALE);
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
      if (["c", "o", "d"].includes(key.name)) {
        if (collapsed.has(key.name)) collapsed.delete(key.name);
        else collapsed.add(key.name);
        draw();
      }
      if (key.name === "a") {
        const allSections = [...sections.map(([id]) => id), "d"];
        if (allSections.every((id) => collapsed.has(id))) collapsed.clear();
        else for (const id of allSections) collapsed.add(id);
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

if (require.main === module) start();
