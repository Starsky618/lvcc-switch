// Offline UI regression checks. All fetches use the synthetic fixture model.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {webcrypto} = require("node:crypto");
const createFixture = require("./fixture-model.js");
const source = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle() { for (let i = 0; i < 12; i++) await tick(); }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject}; }

function harness({scenario = "free", search = "", dispatchStatus = 200, intercept} = {}) {
  const clock = {now: 1800000000000}, timers = new Map(), nodes = new Map(), events = {}, requests = [];
  let timerId = 0;
  const model = createFixture({scenario, now: () => clock.now, dispatchStatus});
  class TestDate extends Date { static now() { return clock.now; } }
  class Element {
    constructor(id = "") { this.id = id; this.value = id === "minutes" ? "15" : ""; this.checked = false;
      this.hidden = false; this.disabled = false; this.open = false; this.className = ""; this.textContent = ""; this.children = []; this.listeners = {}; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(event, listener) { this.listeners[event] = listener; }
  }
  const node = id => { if (!nodes.has(id)) nodes.set(id, new Element(id)); return nodes.get(id); };
  const writes = [], storage = {getItem: () => null, setItem() {}, removeItem() {}};
  const document = {hidden: false, getElementById: node, createElement: () => new Element(), addEventListener: (event, listener) => events[event] = listener};
  vm.runInNewContext(source, {location: {search}, URLSearchParams, crypto: webcrypto, document,
    sessionStorage: storage, localStorage: {...storage, setItem: (...args) => writes.push(args)},
    AbortController, TextDecoder, Uint8Array, TypeError, Date: TestDate,
    atob: value => Buffer.from(value, "base64").toString("binary"),
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, {fn, ms}); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => { requests.push({url, options});
      if (intercept) { const replacement = intercept(url, options, model); if (replacement !== undefined) return replacement; }
      return model.fetch(url, options); },
  });
  const click = id => node(id).listeners.click();
  const walk = element => [element, ...element.children.flatMap(walk)];
  const green = () => walk(node("result-groups")).filter(element => element.className.split(" ").includes("port-free"));
  async function connect() { node("access-key").value = "github_pat_SYNTHETIC_TEST_ONLY"; const promise = click("connect"); await settle(); return promise; }
  function fire(ms) { const found = [...timers].find(([, timer]) => timer.ms === ms); assert(found, `missing ${ms}ms timer`); timers.delete(found[0]); found[1].fn(); }
  const dispatches = () => requests.filter(request => request.url.endsWith("/dispatches"));
  return {model, node, click, walk, green, connect, clock, timers, events, document, requests, writes, fire, dispatches};
}

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test("opening submits exactly one check, takes its returned ID and shows all targets", async () => {
  const h = harness(); await h.connect(); await settle();
  assert.equal(h.dispatches().length, 1);
  const request = JSON.parse(h.dispatches()[0].options.body);
  assert.equal(request.return_run_details, true); assert.equal(request.inputs.mode, "查看当前空位");
  assert.equal(request.inputs.minutes, "15"); assert.match(request.inputs.request_id, /^lvcc-[a-f0-9]{32}$/);
  assert(h.requests.some(request => request.url.endsWith("/actions/runs/1001")));
  assert(h.requests.some(request => request.url.includes("/sessions/1001-1.json")));
  assert.equal(h.node("result-groups").children.length, 15);
  assert.equal(h.node("result-summary").textContent, "2 个空闲 · 1 台可充");
  assert(h.node("result-state").textContent.includes("未开启持续监测"));
  assert.equal(h.node("start").textContent, "有空位通知我 · 15分钟"); assert.equal(h.node("start").disabled, false);
  assert.equal(h.writes.length, 0); h.click("disconnect");
});

test("all busy requires all 15 valid observations; a failed target stays unknown", async () => {
  const busy = harness({scenario: "busy"}); await busy.connect(); await settle();
  assert.equal(busy.node("result-summary").textContent, "15 台全部忙"); assert.equal(busy.green().length, 0); busy.click("disconnect");
  const partial = harness({scenario: "partial"}); await partial.connect(); await settle();
  assert.equal(partial.node("result-summary").textContent, "14 台无空位 · 1 台未知");
  assert.equal(partial.node("result-message").textContent, "部分充电桩暂未查清，可继续查询或开启监测。");
  assert(!partial.node("result-message").textContent.includes("直接前往"));
  assert.equal(partial.node("start").disabled, false); partial.click("disconnect");
});

test("an active monitor is reused and new ports replace the full-scene current result", async () => {
  const h = harness({scenario: "monitoring"}); await h.connect(); await settle();
  assert.equal(h.dispatches().length, 0); assert.equal(h.node("start").hidden, true); assert.equal(h.node("stop").disabled, false);
  assert.match(h.node("result-state").textContent, /监测中.*剩余.*第 4 轮/);
  h.model.setFree([7]); await h.click("results-refresh"); await settle();
  assert.deepEqual(h.green().map(element => element.textContent), ["7 号空闲"]);
  assert.equal(h.node("result-groups").children.length, 15); h.click("disconnect");
});

test("monitor starts with 15 minutes and repeated clicks do not duplicate dispatch", async () => {
  const gate = deferred(); let hold = false;
  const h = harness({scenario: "busy", intercept(url, options, model) {
    if (hold && url.endsWith("/dispatches")) return gate.promise.then(() => model.fetch(url, options));
  }});
  await h.connect(); await settle(); hold = true;
  const start = h.click("start"); await h.click("start"); await h.click("results-refresh");
  assert.equal(h.dispatches().length, 2); // one initial check, one monitor
  assert.equal(JSON.parse(h.dispatches()[1].options.body).inputs.mode, "开始监控");
  assert.equal(JSON.parse(h.dispatches()[1].options.body).inputs.minutes, "15");
  gate.resolve(); await start; await settle(); assert(h.node("result-state").textContent.includes("监测中")); h.click("disconnect");
});

test("concurrent auto-connect, refresh and visibility cannot duplicate the initial check", async () => {
  const gate = deferred();
  const h = harness({intercept(url, options, model) { if (url.endsWith("/dispatches")) return gate.promise.then(() => model.fetch(url, options)); }});
  const connect = h.connect(); await settle(); await h.click("results-refresh"); await h.click("refresh"); h.events.visibilitychange();
  assert.equal(h.dispatches().length, 1); gate.resolve(); await connect; await settle(); assert.equal(h.dispatches().length, 1); h.click("disconnect");
});

test("204 dispatch fallback matches the request suffix, never the newest unrelated check", async () => {
  const h = harness({dispatchStatus: 204}); h.model.addRun(9000, "查看当前空位", "completed", "not-this-request");
  await h.connect(); await settle();
  assert(h.requests.some(request => request.url.includes("/sessions/1001-1.json")));
  assert(!h.requests.some(request => request.url.includes("/sessions/9000-1.json")));
  assert.equal(h.dispatches().length, 1); h.click("disconnect");
});

test("old notification remains pinned and offers a separate current-entry link", async () => {
  const h = harness({scenario: "pinned", search: "?run=901&attempt=1"});
  h.model.addRun(999, "开始监控", "in_progress"); await h.connect(); await settle();
  assert.equal(h.dispatches().length, 0); assert.equal(h.node("current-view").hidden, false);
  assert(h.requests.some(request => request.url.includes("/sessions/901-1.json")));
  assert(!h.requests.some(request => request.url.includes("/sessions/999-1.json")));
  assert.equal(h.green().length, 0); assert.equal(h.node("result-summary").hidden, true); h.click("disconnect");
});

test("legacy v1 notification remains readable without pretending it contains all targets", async () => {
  const h = harness({scenario: "legacy", search: "?run=901&attempt=1"}); await h.connect(); await settle();
  assert.equal(h.dispatches().length, 0); assert.equal(h.green().length, 1); assert.equal(h.node("result-groups").children.length, 1); h.click("disconnect");
});

test("expired check result is unknown rather than current free or all busy", async () => {
  const h = harness({scenario: "stale"}); await h.connect(); await settle();
  assert.equal(h.green().length, 0); assert.equal(h.node("result-summary").hidden, true);
  assert(h.node("result-state").textContent.includes("过期")); h.click("disconnect");
});

test("network failure clears green and current counts", async () => {
  const h = harness({scenario: "monitoring"}); await h.connect(); await settle(); assert.equal(h.green().length, 2);
  h.model.setNetworkFailure(true); await h.click("results-refresh"); await settle();
  assert.equal(h.green().length, 0); assert.equal(h.node("result-summary").hidden, true); h.click("disconnect");
});

test("manual stop cancels the current monitor without starting a replacement check", async () => {
  const h = harness({scenario: "monitoring"}); await h.connect(); await settle();
  await h.click("stop"); await settle(); h.fire(5000); await settle();
  assert(h.requests.some(request => request.url.endsWith("/actions/runs/901/cancel")));
  assert.equal(h.dispatches().length, 0); assert.equal(h.green().length, 0); assert.equal(h.node("stop").hidden, true); h.click("disconnect");
});

test("ambiguous check dispatch waits 90 seconds and only retries after an explicit click", async () => {
  let fail = true;
  const h = harness({intercept(url) { if (url.endsWith("/dispatches") && fail) return Promise.reject(new TypeError("Synthetic uncertain dispatch")); }});
  await h.connect(); await settle(); assert.equal(h.dispatches().length, 1);
  h.clock.now += 90001; await h.click("refresh"); await settle();
  assert.equal(h.dispatches().length, 1); assert.equal(h.node("results-refresh").disabled, false);
  fail = false; await h.click("results-refresh"); await settle(); assert.equal(h.dispatches().length, 2); h.click("disconnect");
});

test("disconnect invalidates delayed dispatch callbacks", async () => {
  const gate = deferred();
  const h = harness({intercept(url, options, model) { if (url.endsWith("/dispatches")) return gate.promise.then(() => model.fetch(url, options)); }});
  const connection = h.connect(); await settle(); h.click("disconnect"); gate.resolve(); await connection; await settle();
  assert.equal(h.node("results").hidden, true); assert.equal(h.node("control-panel").hidden, true); assert.equal(h.dispatches().length, 1);
});

test("a missing device is unknown, never silently counted as one of 15 busy targets", async () => {
  const h = harness({scenario: "busy", intercept(url, options, model) {
    if (url.includes("/contents/sessions/")) return model.fetch(url, options).then(async response => {
      const file = await response.json(), data = JSON.parse(Buffer.from(file.content, "base64").toString());
      data.devices.pop(); return model.response(model.file(data));
    });
  }});
  await h.connect(); await settle(); assert.equal(h.node("result-groups").children.length, 15);
  assert.equal(h.node("result-summary").textContent, "14 台无空位 · 1 台未知"); h.click("disconnect");
});

test("late check data cannot overwrite a monitor started while that check was loading", async () => {
  const gate = deferred();
  const h = harness({intercept(url, options, model) {
    if (url.includes("/contents/sessions/1001-1.json")) return gate.promise.then(() => model.fetch(url, options));
  }});
  await h.connect(); await settle(); const start = h.click("start"); await start; await settle();
  assert(h.node("result-state").textContent.includes("监测中"));
  gate.resolve(); await settle(); assert(h.node("result-state").textContent.includes("监测中"));
  assert.equal(h.node("start").hidden, true); h.click("disconnect");
});

test("v2 freshness expires even without another network response", async () => {
  const h = harness(); await h.connect(); await settle(); assert.equal(h.green().length, 2);
  h.clock.now += 30001; h.fire(30001);
  assert.equal(h.green().length, 0); assert.equal(h.node("result-summary").hidden, true);
  assert(h.node("result-state").textContent.includes("过期")); h.click("disconnect");
});

test("refreshing a queued check reads that run instead of dispatching another check", async () => {
  const h = harness({scenario: "queued"}); await h.connect(); await settle();
  assert.equal(h.dispatches().length, 1); assert.equal(h.node("results-refresh").textContent, "刷新");
  await h.click("results-refresh"); await settle();
  assert.equal(h.dispatches().length, 1); assert.equal(h.green().length, 0);
  assert(h.node("result-state").textContent.includes("正在查询")); h.click("disconnect");
});

test("incremental checking displays its confirmed free port while 14 targets remain unknown", async () => {
  const h = harness({scenario: "incremental"}); await h.connect(); await settle();
  assert.equal(h.node("result-state").textContent, "正在查询全部充电桩");
  assert.equal(h.node("result-summary").textContent, "1 个空闲 · 1 台可充 · 14 台未知");
  assert.deepEqual(h.green().map(element => element.textContent), ["2 号空闲"]);
  assert.equal(h.node("result-groups").children.length, 15);
  assert(!h.node("result-summary").textContent.includes("全部忙"));
  assert(h.node("result-message").textContent.includes("14 台尚未查清")); h.click("disconnect");
});

(async () => {
  for (const [name, fn] of cases) { await fn(); console.log("PASS", name); }
  console.log(`${cases.length} offline UI smoke tests passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
