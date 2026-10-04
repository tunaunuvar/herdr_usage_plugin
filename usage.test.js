"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
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
      const ui = panel(columns, rows);
      ui.run("draw()");
      const lines = stripVTControlCharacters(ui.output()).split(/\r?\n/);
      assert.equal(lines.length, rows);
      for (const line of lines) {
        assert.ok(ui.run(`visibleWidth(${JSON.stringify(line)})`) <= columns - 2);
      }
      assert.match(lines.at(-2), /q\/Esc/);
    }
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
  vm.runInContext("start()", context);
  await Promise.resolve();
  assert.equal(timers, 1);
  assert.ok(writes[0].includes("\x1b[?1049h\x1b[?25l"));
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
