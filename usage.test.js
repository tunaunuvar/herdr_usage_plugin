"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { stripVTControlCharacters } = require("node:util");

const source = fs.readFileSync(require("node:path").join(__dirname, "usage.js"), "utf8");
const example = {
  title: "Codex · Plus",
  rows: [
    { label: "5h", used: 18, resetsAt: Date.now() + 7200000, windowMinutes: 300 },
    { label: "7d", used: 76, resetsAt: Date.now() + 172800000, windowMinutes: 10080 },
  ],
};

function panel(columns = 96, rows = 30) {
  let output = "";
  const context = vm.createContext({
    require: (name) => name === "node:child_process"
      ? { spawn() { throw new Error("Rendering must not launch a CLI"); } } : require(name),
    module: { exports: {} },
    process: {
      env: { PATH: "" }, platform: process.platform,
      stdout: { isTTY: true, columns, rows, write(chunk) { output = chunk; } },
      stdin: { isTTY: false },
    },
    setInterval() { throw new Error("Importing the renderer must not start polling"); },
    setTimeout, clearTimeout,
  });
  vm.runInContext(source, context);
  vm.runInContext(`sections.push(["c", "Codex"], ["o", "OMP"]);
    latestResults = new Map([["Codex", ${JSON.stringify(example)}],
      ["OMP", {title: "OMP · accounts", rows: Array.from({length: 8}, (_, i) =>
        ({label: "Provider " + i, used: i * 12, resetsAt: null}))}]]);
    updatedAt = "12:30:00";`, context);
  return { context, run: (code) => vm.runInContext(code, context), output: () => output };
}

test("narrow and short panes keep content inside the viewport and controls visible", () => {
  for (const columns of [24, 38, 80, 120]) {
    for (const rows of [12, 30]) {
      for (const language of ["en", "tr", "es"]) {
        const ui = panel(columns, rows);
        ui.run(`language = ${JSON.stringify(language)}; draw()`);
        const lines = stripVTControlCharacters(ui.output()).split(/\r?\n/);
        assert.equal(lines.length, rows);
        for (const line of lines) {
          assert.ok(ui.run(`visibleWidth(${JSON.stringify(line)})`) <= columns - 2);
        }
        assert.match(lines.at(-2), /q\/Esc/);
        assert.match(lines.at(-1), /\[l\]/);
      }
    }
  }
});

test("language changes translate cached notes, card titles, errors and reset dates", () => {
  const ui = panel(96, 60);
  ui.run(`latestResults.set("OMP", ompResult({reports:[{provider:"anthropic",limits:[]}]}));
    detectedTools.push(AI_TOOLS.find(tool => tool.id === "gemini")); collapsed.delete("d");`);
  for (const [language, header, accounts, note, cli, month, errorText, hint] of [
    ["en", /AI USAGE/, /connected accounts/, /Claude data/, /Run \/stats model inside/, /Jan/, /Connection required/, /Check sign-in/],
    ["tr", /AI KOTA/, /bağlı hesaplar/, /Claude verileri/, /Gemini CLI içinde/, /Oca/, /Bağlantı gerekli/, /Girişi ve CLI/],
    ["es", /CUOTAS DE IA/, /cuentas conectadas/, /Los datos de Claude/, /Ejecuta \/stats model en/, /ene/, /Conexión necesaria/, /Comprueba el inicio/],
  ]) {
    ui.run(`language = ${JSON.stringify(language)}; draw()`);
    const output = stripVTControlCharacters(ui.output());
    assert.match(output, header);
    assert.match(output, accounts);
    assert.match(output, note);
    assert.match(output, cli);
    const reset = ui.run("resetText(Date.UTC(2030, 0, 2, 12))");
    assert.match(reset, month);
    const error = stripVTControlCharacters(ui.run('renderSection("h", "Claude", {error:["Bağlantı gerekli", "Connection required", "Conexión necesaria"]}, 90)').join("\n"));
    assert.match(error, errorText);
    assert.match(error, hint);
  }
});

test("repeated folding clears old rows and keeps each row at the left edge", () => {
  function terminal() {
    const grid = Array.from({ length: 30 }, () => []);
    let row = 0, column = 0;
    return {
      paint(output) {
        for (const token of output.match(/\x1b\[[0-9;]*[A-Za-z]|[^\x1b]/gu) || []) {
          if (token === "\x1b[H") { row = 0; column = 0; }
          else if (token === "\x1b[2K") grid[row] = [];
          else if (token === "\x1b[J") {
            grid[row].length = column;
            for (let i = row + 1; i < grid.length; i++) grid[i] = [];
          } else if (token.startsWith("\x1b")) continue;
          else if (token === "\r") column = 0;
          else if (token === "\n") row++;
          else grid[row][column++] = token;
        }
      },
      contents: () => grid.map((line) => line.join("").trimEnd()),
    };
  }
  const ui = panel(80, 30);
  const screen = terminal();
  for (const state of ['collapsed.clear()', 'collapsed.add("c"); collapsed.add("o"); collapsed.add("d")',
    'collapsed.delete("c")', 'collapsed.clear()', 'collapsed.add("o")']) {
    ui.run(state + "; draw()");
    screen.paint(ui.output());
    const fresh = terminal();
    fresh.paint(ui.output());
    assert.deepEqual(screen.contents(), fresh.contents());
    assert.ok(screen.contents().every((line) => Array.from(line).length <= 78));
  }
});

test("quota extremes and unavailable data keep distinct, aligned displays", () => {
  const ui = panel();
  for (const used of [0, 100, null]) {
    const lines = ui.run(`renderSection("c", "Codex", {rows: [
      {label: "7d", used: ${used}, resetsAt: null, windowMinutes: 10080}
    ]}, 60)`);
    for (const line of lines) assert.equal(ui.run(`visibleWidth(${JSON.stringify(line)})`), 60);
    const plain = lines.map(stripVTControlCharacters).join("\n");
    assert.match(plain, /WEEKLY|HAFTALIK/);
    if (used === null) assert.doesNotMatch(plain, /0%/);
    else assert.ok(plain.includes(`${used}%`));
  }
});

test("account inventory separates saved reset expiry from subscription expiry", () => {
  const ui = panel();
  const response = { account: { planType: "plus", email: "private@example.test" },
    rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1900000000 } },
    rateLimitResetCredits: { availableCount: 2, credits: [
      { title: "Reset", expiresAt: 1900000000 }, { title: "Permanent", expiresAt: null },
    ] } };
  const result = ui.run(`codexResult(${JSON.stringify(response)})`);
  assert.equal(result.accounts[0].plan, "plus");
  assert.equal(result.accounts[0].resetCredits.availableCount, 2);
  assert.ok(!JSON.stringify(result).includes("private@example.test"));
  const lines = ui.run(`accountLines(${JSON.stringify(result.accounts[0])})`).join("\n");
  assert.match(lines, /plus/);
  assert.match(lines, /2030/);
  assert.match(lines, /süre sınırı yok|no expiry/);
  assert.match(lines, /Abonelik bitişi · bildirilmedi|Subscription expiry · not reported/);
  const zero = ui.run('accountLines({name:"Test", resetCredits:{availableCount:0}})').join("\n");
  const unavailable = ui.run('accountLines({name:"Test"})').join("\n");
  assert.match(zero, /Yenileme hakkı · 0|Saved resets · 0/);
  assert.match(unavailable, /Yenileme hakkı · bildirilmedi|Saved resets · not reported/);
});

test("OpenRouter credits become a quota bar without implying a reset date", () => {
  const ui = panel();
  const result = ui.run('openrouterResult({data:{total_credits:100,total_usage:25}})');
  assert.equal(result.rows[0].used, 25);
  assert.equal(result.rows[0].resetsAt, null);
  assert.match(result.rows[0].detail, /25\.00 \/ 100\.00 credits used/);
  assert.throws(() => ui.run('openrouterResult({data:{total_credits:0,total_usage:0}})'), /no credit balance/);
});

test("detected tools without quota adapters appear as clearly labeled info cards", () => {
  const ui = panel();
  ui.run('collapsed.add("w")');
  const folded = stripVTControlCharacters(ui.run('renderSection("w", "OpenCode", {info:true, note:"Provider sign-ins do not expose account quotas"}, 90)').join("\n"));
  assert.match(folded, /INFO/);
  assert.match(folded, /Provider sign-ins do not expose account quotas/);
  const expanded = stripVTControlCharacters(ui.run('collapsed.delete("w"); renderSection("w", "OpenCode", {info:true, note:"Provider sign-ins do not expose account quotas"}, 90)').join("\n"));
  assert.match(expanded, /Provider sign-ins do not expose account quotas/);
  assert.doesNotMatch(expanded, /Subscription expiry/);
});

test("panels only create CLI cards for executables on Herdr's PATH", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-cli-detection-"));
  const command = process.platform === "win32" ? "codex.cmd" : "codex";
  fs.writeFileSync(path.join(directory, command), "");
  const context = vm.createContext({
    require: (name) => name === "node:child_process" ? { spawn() {} } : require(name),
    module: {}, process: { env: { PATH: directory }, platform: process.platform,
      stdout: { isTTY: false }, stdin: { isTTY: false } },
    setInterval() { throw new Error("Importing the renderer must not start polling"); }, setTimeout, clearTimeout,
  });
  try {
    vm.runInContext(source, context);
    assert.equal(JSON.stringify(vm.runInContext('detectedTools.map((tool) => tool.id)', context)), '["codex"]');
    assert.equal(vm.runInContext('sections.some(([key]) => key === "o")', context), false);
    assert.equal(vm.runInContext('sections.some(([key]) => key === "c")', context), true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("OMP and Claude section names match the keys used by quota refresh", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-provider-detection-"));
  const extension = process.platform === "win32" ? ".cmd" : "";
  for (const command of ["codex", "omp", "claude"]) fs.writeFileSync(path.join(directory, command + extension), "");
  const context = vm.createContext({
    require: (name) => name === "node:child_process" ? { spawn() {} } : require(name),
    module: {}, process: { env: { PATH: directory }, platform: process.platform,
      stdout: { isTTY: false }, stdin: { isTTY: false } },
    setInterval() { throw new Error("Importing the renderer must not start polling"); }, setTimeout, clearTimeout,
  });
  try {
    vm.runInContext(source, context);
    assert.equal(JSON.stringify(vm.runInContext("sections", context)),
      '[["c","Codex"],["o","OMP"],["h","Claude"]]');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("each quota card updates as its source resolves instead of waiting for all providers", async () => {
  const ui = panel();
  ui.run(`latestResults.clear(); detectedTools.push({id:"codex"}, {id:"omp"});
    sections.splice(0, sections.length, ["c", "Codex"], ["o", "OMP"]);
    codexUsage = async () => ({title:"Codex", rows:[]});
    ompUsage = () => new Promise(resolve => { pendingOmp = resolve; });`);
  const pending = ui.run("refresh()");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ui.run('latestResults.has("Codex")'), true);
  assert.equal(ui.run('latestResults.has("OMP")'), false);
  ui.run('pendingOmp({title:"OMP", rows:[]})');
  await pending;
  assert.equal(ui.run('latestResults.has("OMP")'), true);
  assert.equal(ui.run("refreshing"), false);
});

test("OMP Claude accounts get their own card without duplicate quota windows", () => {
  const ui = panel();
  const result = ui.run(`ompResult({reports:[
    {provider:"anthropic", limits:[{label:"5h", amount:{usedFraction:0.4}, window:{durationMs:18000000}}],
      resetCredits:{availableCount:3, credits:[{remainingCount:3, expiresAt:"2030-01-02T00:00:00Z"}]}},
    {provider:"google-antigravity", limits:[{label:"Model", amount:{usedFraction:0.1}}]}
  ]})`);
  assert.equal(result.rows.length, 1);
  assert.equal(result.claude.rows.length, 1);
  assert.equal(result.claude.rows[0].used, 40);
  assert.equal(result.claude.accounts[0].resetCredits.availableCount, 3);
  assert.equal(result.accounts[0].name, "google-antigravity");
});

test("Claude statusline snapshots whitelist quota fields and preserve unknown usage", () => {
  const ui = panel();
  const snapshot = ui.run(`claudeSnapshot({session_id:"secret-session", transcript_path:"private", token:"secret-token",
    rate_limits:{five_hour:{used_percentage:0,resets_at:1900000000},seven_day:{resets_at:1900000000}}})`);
  assert.equal(snapshot.rows.length, 2);
  assert.equal(snapshot.rows[0].used, 0);
  assert.equal(snapshot.rows[1].used, null);
  assert.equal(snapshot.rows[1].windowMinutes, 10080);
  assert.equal(snapshot.rows[0].resetsAt, 1900000000000);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|private|token|session/);
  assert.equal(ui.run('claudeSnapshot({}).rows.length'), 0);
});

test("Codex keeps a reported plan when the quota request times out", async () => {
  const { EventEmitter } = require("node:events");
  const child = new EventEmitter();
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  let killed = false;
  child.kill = () => { killed = true; };
  const methods = [];
  child.stdin = { write(line) {
    const request = JSON.parse(line);
    methods.push(request.method);
    const result = request.method === "initialize" ? {} : request.method === "account/read"
      ? { account: { type: "chatgpt", planType: "plus" } } : undefined;
    if (result) Promise.resolve().then(() => child.stdout.emit("data", JSON.stringify({ id: request.id, result }) + "\n"));
  } };
  let deadline;
  const context = vm.createContext({ require: (name) => name === "node:child_process" ? { spawn: () => child } : require(name),
    module: {}, process: { env: { PATH: "" }, platform: "win32", stdout: { isTTY: false } },
    setTimeout(callback) { deadline = callback; return 42; }, clearTimeout() {},
  });
  vm.runInContext(source, context);
  const pending = vm.runInContext("codexUsage()", context);
  for (let i = 0; i < 6; i++) await Promise.resolve();
  deadline();
  const result = await pending;
  assert.equal(result.accounts[0].plan, "plus");
  assert.match(result.error, /timed out/);
  assert.equal(result.rows.length, 0);
  assert.equal(killed, true);
  assert.deepEqual(methods, ["initialize", "initialized", "account/rateLimits/read", "account/read"]);
});

test("Claude bridge mode writes a sanitized snapshot without starting polling", async () => {
  const { PassThrough } = require("node:stream");
  const input = new PassThrough();
  const saved = [];
  let output = "";
  const bridgeModule = {};
  const bridgeRequire = (name) => name === "node:fs" ? {
    existsSync: () => false, mkdirSync() {},
    writeFileSync(file, data, options) { saved.push({ file, data: JSON.parse(data), options }); },
  } : name === "node:child_process" ? { spawn() { throw new Error("Bridge must not query a CLI"); } } : require(name);
  bridgeRequire.main = bridgeModule;
  const context = vm.createContext({ require: bridgeRequire, module: bridgeModule,
    process: { env: { PATH: "" }, platform: process.platform, argv: ["node", "usage.js", "--claude-statusline"],
      stdin: input, stdout: { isTTY: false, write(chunk) { output += chunk; } } },
    setInterval() { throw new Error("Bridge must not start polling"); }, setTimeout, clearTimeout,
  });
  vm.runInContext(source, context);
  const ended = new Promise((resolve) => input.once("end", resolve));
  input.end(JSON.stringify({ token: "secret", transcript_path: "private", rate_limits: {
    five_hour: { used_percentage: 32, resets_at: 1900000000 },
  } }));
  await ended;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].data.rows[0].used, 32);
  assert.equal(saved[0].options.mode, 0o600);
  assert.doesNotMatch(JSON.stringify(saved[0].data), /secret|private|token|transcript/);
  assert.equal(output, "Claude | 5h: 32%");
  input.destroy();
});

test("folding sections and scrolling past either end clamp the viewport", () => {
  const ui = panel(80, 14);
  ui.run("scrollOffset = 999; draw()");
  assert.equal(ui.run("scrollOffset"), ui.run("scrollEnd"));
  const expandedEnd = ui.run("scrollEnd");
  ui.run('collapsed.add("c"); collapsed.add("o"); draw()');
  assert.equal(ui.run("scrollOffset"), ui.run("scrollEnd"));
  assert.ok(ui.run("scrollEnd") < expandedEnd);
  ui.run("scrollOffset = -20; draw()");
  assert.equal(ui.run("scrollOffset"), 0);
});

test("wide labels, Turkish text and untrusted control characters do not break cards", () => {
  const ui = panel();
  const lines = ui.run(`renderSection("c", "Codex", {title: "模型\\nInjected\\x1b[2J", rows: [
    {label: "Haftalık 模型", used: 95, resetsAt: null, detail: "Detail\\nnewline"}
  ]}, 38)`);
  for (const line of lines) {
    assert.equal(ui.run(`visibleWidth(${JSON.stringify(line)})`), 38);
    assert.ok(!line.includes("\n") && !line.includes("\x1b[2J"));
  }
});

test("interactive startup uses one refresh timer and restores the terminal on close", async () => {
  const { EventEmitter } = require("node:events");
  const { PassThrough } = require("node:stream");
  const input = new PassThrough();
  input.isTTY = true;
  const rawModes = [];
  input.setRawMode = (value) => rawModes.push(value);
  const writes = [];
  const output = Object.assign(new EventEmitter(), {
    isTTY: true, columns: 80, rows: 24, write(chunk) { writes.push(chunk); },
  });
  const fakeProcess = Object.assign(new EventEmitter(), {
    env: { PATH: "" }, platform: process.platform, stdin: input, stdout: output,
    exit(code) { assert.equal(code, 0); this.emit("exit"); },
  });
  let timers = 0;
  let stopped = false;
  const context = vm.createContext({ require, module: {}, process: fakeProcess,
    setInterval(_callback, ms) { assert.equal(ms, 60000); timers++; return 42; },
    clearInterval(id) { assert.equal(id, 42); stopped = true; }, setTimeout, clearTimeout,
  });
  vm.runInContext(source, context);
  assert.equal(vm.runInContext("language", context), "en");
  vm.runInContext("start()", context);
  await Promise.resolve();
  assert.equal(timers, 1);
  assert.ok(writes[0].includes("\x1b[?1049h\x1b[?25l"));
  vm.runInContext('scrollOffset = 999; collapsed.add("c")', context);
  input.emit("keypress", "l", { name: "l" });
  assert.match(stripVTControlCharacters(writes.at(-1)), /AI KOTA/);
  assert.equal(vm.runInContext("scrollOffset", context), 0);
  assert.equal(vm.runInContext('collapsed.has("c")', context), true);
  input.emit("keypress", "l", { name: "l" });
  assert.match(stripVTControlCharacters(writes.at(-1)), /CUOTAS DE IA/);
  input.emit("keypress", "l", { name: "l" });
  assert.match(stripVTControlCharacters(writes.at(-1)), /AI USAGE/);
  assert.equal(timers, 1);
  output.columns = 38;
  output.rows = 12;
  output.emit("resize");
  assert.equal(stripVTControlCharacters(writes.at(-1)).split("\n").length, 12);
  const controls = stripVTControlCharacters(writes.at(-1)).split(/\r?\n/).at(-1);
  assert.match(controls, /\[d\].*\[a\]/);
  assert.doesNotMatch(controls, /\[c\]|\[o\]/);
  const beforeMissingCard = writes.length;
  input.emit("keypress", "o", { name: "o" });
  assert.equal(writes.length, beforeMissingCard);
  for (let i = 0; i < 4; i++) {
    vm.runInContext("scrollOffset = 999", context);
    input.emit("keypress", "d", { name: "d" });
    assert.equal(vm.runInContext("scrollOffset", context), 0);
  }
  input.emit("keypress", "q", { name: "q" });
  assert.equal(stopped, true);
  assert.equal(rawModes.at(-1), false);
  assert.ok(writes.at(-1).includes("\x1b[?25h\x1b[?1049l"));
  input.destroy();
});
