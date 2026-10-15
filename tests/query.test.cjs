const test = require("node:test");
const assert = require("node:assert/strict");
const Q = require("../query.js");
const config = require("../site-config.js");
const targets = config.targets.slice(0, 4);
const at = 1800000000000;
const body = data => ({code: 200, success: true, data});
const device = (target, freePortCount = 0) => ({id: target.device_id, name: target.name,
  simId: target.sim_id, portNumber: 4, freePortCount, status: 1, online: 1,
  ownerId: "PRIVATE_OWNER", iccid: "PRIVATE_ICCID"});
const detail = (target, ports = [0, 1, 0, -1, -2]) => body({device: device(target, ports.slice(1).filter(p => p === 0).length),
  machineFault: 0, accessJudgmentFlag: 0, scramDeviceFlag: 0, ports, order: "PRIVATE_ORDER"});
const response = (value, status = 200, retry = null) => ({ok: status === 200, status,
  headers: {get: () => retry}, json: async () => value});
const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return {promise, resolve}; };

test("public config contains exactly the required fields and validates all 15 targets", () => {
  assert.equal(Q.validateConfig(config).targets.length, 15);
  assert.deepEqual(Object.keys(config.site).sort(), ["lat", "lng", "name"]);
  for (const target of config.targets) assert.deepEqual(Object.keys(target).sort(), ["device_id", "label", "name", "sim_id"]);
  assert.throws(() => Q.validateConfig({...config, targets: [targets[0], targets[0]]}));
});

test("list separates confirmed zero counts, candidates, missing and offline devices", () => {
  const list = [device(targets[0]), device(targets[1], 1), {...device(targets[2]), online: 0}];
  const parsed = Q.parseList(body(list), targets, at);
  assert.equal(parsed.candidates.length, 1);
  assert.equal(parsed.states[0].ports, null);
  assert.equal(parsed.states[0].source, "list");
  assert.deepEqual(Q.summarize(parsed.states, at), {...Q.summarize(parsed.states, at), noVacancy: 1, unknown: 3, free: 0});
  assert(!JSON.stringify(parsed.states).includes("PRIVATE"));
});

test("device identity mismatch and duplicate IDs remain unknown", () => {
  for (const replacement of [{id: 999}, {name: "wrong"}, {simId: "wrong"}]) {
    assert.throws(() => Q.parseDetail(body({...detail(targets[0]).data,
      device: {...device(targets[0], 1), ...replacement}}), targets[0], at), /不一致/);
    const data = [{...device(targets[0]), ...replacement}];
    assert.equal(Q.summarize(Q.parseList(body(data), [targets[0]], at).states, at).unknown, 1);
  }
  assert.equal(Q.parseList(body([device(targets[0]), device(targets[0])]), [targets[0]], at).states[0].source, null);
});

test("index zero is ignored; fault and disabled remain distinct; extra fields are dropped", () => {
  const state = Q.parseDetail(detail(targets[0]), targets[0], at);
  assert.deepEqual(state.free, [2]);
  assert.deepEqual(state.ports, [1, 0, -1, -2]);
  assert(!JSON.stringify(state).includes("PRIVATE"));
  assert(!Object.hasOwn(state, "simId"));
  assert.deepEqual(Q.parseDetail(detail(targets[0], [0, 1, 1, 1, 1]), targets[0], at).free, []);
});

test("fault flags, malformed ports and inconsistent counts fail closed", () => {
  const source = detail(targets[0]).data;
  for (const change of [{machineFault: 1}, {accessJudgmentFlag: 1}, {scramDeviceFlag: 1},
    {ports: [0, 1]}, {ports: [0, "0", 1, 1, 1]}, {ports: [0, 2, 1, 1, 1]},
    {device: {...source.device, freePortCount: 2}}, {device: {...source.device, portNumber: true}}]) {
    assert.throws(() => Q.parseDetail(body({...source, ...change}), targets[0], at));
  }
});

test("exactly 30 seconds old or future results never show current availability", () => {
  const state = Q.parseDetail(detail(targets[0]), targets[0], at);
  assert.equal(Q.summarize([state], at + 29999).free, 1);
  for (const now of [at - 1, at + 30000, at + 100000]) {
    const current = Q.summarize([state], now);
    assert.equal(current.free, 0); assert.equal(current.unknown, 1); assert.equal(current.noVacancy, 0);
    assert.equal(current.devices[0].ports, null);
  }
});

test("anonymous requests use only two allowed URLs with no cookie, auth or GitHub route", async () => {
  const calls = [];
  const client = Q.createClient({spacingMs: 0, now: () => at, fetchImpl: async (url, options) => {
    calls.push({url, options}); return response(body([]));
  }});
  await client.list(config.site); await client.detail(targets[0]);
  assert.deepEqual(calls.map(call => new URL(call.url).pathname), ["/appBaseApi/nearbyDeviceListWithoutLogin", "/portDetail"]);
  for (const {url, options} of calls) {
    assert.equal(new URL(url).origin, "https://appapi.lvcchong.com");
    assert.equal(options.method, "POST"); assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.deepEqual(Object.keys(options.headers), ["Content-Type"]);
    assert(!/token|github|authorization|cookie/i.test(options.body));
  }
});

test("client observes its minimum request start interval", async () => {
  let clock = at; const starts = [], waits = [];
  const client = Q.createClient({now: () => clock, delay: async ms => { waits.push(ms); clock += ms; },
    fetchImpl: async () => { starts.push(clock); return response(body([])); }});
  await client.list(config.site); await client.detail(targets[0]); await client.detail(targets[1]);
  assert.deepEqual(starts, [at, at + 1000, at + 2000]); assert.deepEqual(waits, [1000, 1000]);
});

test("timeout becomes unknown and does not retry even when fetch ignores abort", async () => {
  let calls = 0;
  const client = Q.createClient({spacingMs: 0, timeoutMs: 10, fetchImpl: () => { calls++; return new Promise(() => {}); }});
  const query = Q.createQuery({site: config.site, targets}, {client}); let result;
  await query.run(update => result = update);
  assert.equal(result.done, true); assert.equal(Q.summarize(result.states).unknown, 4);
  assert(result.states.every(state => /超时/.test(state.error))); assert.equal(calls, 1);
});

test("403, 405 and 429 stop subsequent requests during cooldown", async () => {
  for (const status of [403, 405, 429]) {
    let calls = 0;
    const client = Q.createClient({spacingMs: 0, now: () => at, fetchImpl: async () => {
      calls++; return response(null, status, status === 429 ? "120" : null);
    }});
    await assert.rejects(client.list(config.site), error => error.blocked && error.retryAt > at);
    await assert.rejects(client.detail(targets[0]), error => error.blocked);
    assert.equal(calls, 1); assert.equal(client.retryAt, at + (status === 429 ? 120000 : 300000));
  }
});

test("partial detail failures keep all targets, with at most two concurrent detail calls", async () => {
  let running = 0, peak = 0; const queried = [];
  const client = {list: async () => ({data: body(targets.map(target => device(target, 1))), checkedAt: at}),
    detail: async target => {
      queried.push(target.device_id); running++; peak = Math.max(peak, running);
      await new Promise(resolve => setImmediate(resolve)); running--;
      if (target === undefined || target.device_id === targets[1].device_id) throw new Q.QueryError("离线");
      return {data: detail(target), checkedAt: at};
    }};
  let result;
  await Q.createQuery({site: config.site, targets}, {client}).run(update => result = update);
  assert.equal(peak, 2); assert.equal(queried.length, 4); assert.equal(result.states.length, 4);
  assert.equal(Q.summarize(result.states, at).free, 3); assert.equal(Q.summarize(result.states, at).unknown, 1);
});

test("a rejection during detail stops the queue and leaves unqueried targets unknown", async () => {
  let calls = 0;
  const client = {list: async () => ({data: body(targets.map(target => device(target, 1))), checkedAt: at}),
    detail: async () => { calls++; throw new Q.QueryError("受限", {blocked: true, retryAt: at + 60000}); }};
  let result; await Q.createQuery({site: config.site, targets}, {client}).run(update => result = update);
  assert(calls <= 2); assert.equal(result.blocked, true); assert.equal(result.done, true);
  assert.equal(Q.summarize(result.states, at).unknown, 4);
});

test("late old rounds cannot overwrite new rounds even if the transport ignores abort", async () => {
  const gate = deferred(); let calls = 0; const updates = [];
  const client = {list: async () => ++calls === 1 ? gate.promise : {data: body(targets.map(target => device(target))), checkedAt: at},
    detail: async target => ({data: detail(target), checkedAt: at})};
  const query = Q.createQuery({site: config.site, targets}, {client});
  const first = query.run(value => updates.push({round: 1, value}));
  await query.run(value => updates.push({round: 2, value}));
  const count = updates.length;
  gate.resolve({data: body(targets.map(target => device(target, 1))), checkedAt: at}); await first;
  assert.equal(updates.length, count); assert.equal(updates.at(-1).round, 2);
  assert.equal(Q.summarize(updates.at(-1).value.states, at).noVacancy, 4);
});

test("cancelling prevents late publication", async () => {
  const gate = deferred(), updates = [];
  const query = Q.createQuery({site: config.site, targets}, {client: {list: () => gate.promise}});
  const run = query.run(value => updates.push(value)); query.cancel();
  gate.resolve({data: body(targets.map(target => device(target))), checkedAt: at}); await run;
  assert.equal(updates.length, 1);
});
