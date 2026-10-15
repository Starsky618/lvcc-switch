const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Q = require("../query.js");
const config = require("../site-config.js");
const source = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };

function harness({search = "", partial = false, brokenStorage = false, reject = false} = {}) {
  const clock = {now: 1800000000000}, nodes = new Map(), timers = new Map(), events = {}, requests = [], removed = [];
  let timerId = 0, networkFailure = false;
  class Element {
    constructor() { this.checked = false; this.hidden = false; this.disabled = false; this.className = ""; this.textContent = "";
      this.children = []; this.listeners = {}; this.attributes = {}; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    setAttribute(name, value) { this.attributes[name] = value; }
  }
  const node = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  class TestDate extends Date { static now() { return clock.now; } }
  const document = {hidden: false, getElementById: node, createElement: () => new Element(), addEventListener: (name, fn) => events[name] = fn};
  const device = (target, count) => ({id: target.device_id, name: target.name, simId: target.sim_id,
    portNumber: 4, freePortCount: count, status: 1, online: 1});
  const client = Q.createClient({now: () => clock.now, spacingMs: 0, fetchImpl: async (url, options) => {
    requests.push({url, options}); if (networkFailure) throw TypeError("offline");
    if (reject) return {ok: false, status: 429, headers: {get: () => null}};
    let data;
    if (url.endsWith("WithoutLogin")) data = config.targets.filter((_, index) => !partial || index !== 14).map((target, index) => device(target, index === 0 ? 1 : 0));
    else data = {device: device(config.targets[0], 1), ports: [0, 0, 1, -1, -2], machineFault: 0, accessJudgmentFlag: 0};
    return {ok: true, status: 200, json: async () => ({code: 200, success: true, data})};
  }});
  const storage = {getItem() { throw Error("must never read old credentials"); }, setItem() { throw Error("must never persist data"); },
    removeItem: key => { removed.push(key); if (brokenStorage) throw Error("blocked"); }};
  vm.runInNewContext(source, {LvccSite: config, LvccQuery: {...Q, createQuery: settings => Q.createQuery(settings, {client}),
    currentState: state => Q.currentState(state, clock.now), summarize: states => Q.summarize(states, clock.now)},
    location: {search}, URLSearchParams, document, window: {addEventListener: (name, fn) => events[name] = fn},
    sessionStorage: storage, localStorage: storage, Date: TestDate,
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, {fn, ms}); return id; }, clearTimeout: id => timers.delete(id)});
  const walk = root => [root, ...root.children.flatMap(walk)];
  const green = () => walk(node("result-groups")).filter(item => item.className === "free-ports").flatMap(item => item.children);
  const fire = ms => { const found = [...timers].find(([, timer]) => timer.ms === ms); assert(found, `missing timer ${ms}`);
    timers.delete(found[0]); found[1].fn(); };
  return {node, clock, timers, events, document, requests, removed, green, fire,
    click: id => node(id).listeners.click(), failNetwork() { networkFailure = true; }};
}

test("opens one anonymous query, clears both old credential stores, and displays all full names", async () => {
  const h = harness(); await settle();
  assert.equal(h.requests.length, 2); assert.equal(h.node("auto-refresh").checked, false);
  assert.deepEqual(h.removed, ["lvcc-controller-key", "lvcc-controller-key"]);
  assert.equal(h.node("result-groups").children.length, 15);
  assert.equal(h.node("result-groups").children[0].children[0].textContent, config.targets[0].name);
  assert.equal(h.node("result-summary").textContent, "1 个空闲 · 1 台可充");
  assert.deepEqual(h.green().map(node => node.textContent), ["1 号空闲"]);
  assert(h.requests.every(({url, options}) => new URL(url).hostname === "appapi.lvcchong.com" && options.credentials === "omit"));
});

test("storage denial does not block querying, and old links explicitly switch to current mode", async () => {
  const h = harness({search: "?run=123&attempt=1", brokenStorage: true}); await settle();
  assert.equal(h.node("legacy-link-note").hidden, false); assert.equal(h.requests.length, 2);
  assert.equal(h.node("results-refresh").disabled, false);
});

test("partial results keep missing devices unknown", async () => {
  const h = harness({partial: true}); await settle();
  assert.equal(h.node("result-summary").textContent, "1 个空闲 · 1 台可充 · 1 台未知");
  assert.equal(h.node("result-groups").children.length, 15);
  assert.match(h.node("result-state").textContent, /未知不代表已占用/);
});

test("expiry removes green and current counts without making another request", async () => {
  const h = harness(); await settle(); h.clock.now += 30000; h.fire(30000);
  assert.equal(h.green().length, 0); assert.equal(h.node("result-summary").textContent, "当前状态未知");
  assert.match(h.node("result-state").textContent, /过期/); assert.equal(h.requests.length, 2);
});

test("refresh failure clears old free results rather than showing all busy", async () => {
  const h = harness(); await settle(); h.failNetwork(); await h.click("results-refresh"); await settle();
  assert.equal(h.green().length, 0); assert.equal(h.node("result-summary").textContent, "当前状态未知");
});

test("auto refresh stops while hidden and only resumes when enabled", async () => {
  const h = harness(); await settle();
  h.document.hidden = true; h.events.visibilitychange(); h.document.hidden = false; h.events.visibilitychange(); await settle();
  assert.equal(h.requests.length, 2);
  h.node("auto-refresh").checked = true; h.node("auto-refresh").listeners.change(); await settle();
  assert.equal(h.requests.length, 4);
  h.document.hidden = true; h.events.visibilitychange();
  const count = h.requests.length;
  for (const [, timer] of [...h.timers]) timer.fn(); await settle();
  assert.equal(h.requests.length, count);
  h.document.hidden = false; h.events.visibilitychange(); await settle(); assert.equal(h.requests.length, count + 2);
});

test("rate limit disables auto and manual retries until cooldown without extra requests", async () => {
  const h = harness({reject: true}); await settle();
  assert.equal(h.node("auto-refresh").checked, false); assert.equal(h.node("auto-refresh").disabled, true);
  assert.equal(h.node("results-refresh").disabled, true); await h.click("results-refresh");
  assert.equal(h.requests.length, 1); assert.match(h.node("result-state").textContent, /HTTP 429/);
  h.clock.now += 300000; h.fire(300000);
  assert.equal(h.node("results-refresh").disabled, false); assert.equal(h.requests.length, 1);
});
