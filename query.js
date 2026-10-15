/* Anonymous, read-only queries. Only allowlisted availability leaves this module. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LvccQuery = factory();
})(globalThis, function () {
  "use strict";
  const ORIGIN = "https://appapi.lvcchong.com";
  const LIST_PATH = "/appBaseApi/nearbyDeviceListWithoutLogin";
  const DETAIL_PATH = "/portDetail";
  const FRESH_MS = 30000;
  const STATUS_LABELS = {0: "空闲", 1: "已占用", "-1": "故障", "-2": "停用"};
  class QueryError extends Error {
    constructor(message, {blocked = false, retryAt = 0, cancelled = false} = {}) {
      super(message); this.name = "QueryError";
      this.blocked = blocked; this.retryAt = retryAt; this.cancelled = cancelled;
    }
  }
  const cancelled = () => new QueryError("查询已暂停", {cancelled: true});
  const validInteger = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
  const base = target => ({device_id: target.device_id, name: target.name, label: target.label || target.name});
  const unknown = (target, error = "尚未查询") => ({...base(target), total: null, free: [], ports: null,
    checkedAt: null, source: null, error});

  function validateConfig(config) {
    if (!config?.site || typeof config.site.name !== "string" || !config.site.name
        || !Number.isFinite(config.site.lng) || Math.abs(config.site.lng) > 180
        || !Number.isFinite(config.site.lat) || Math.abs(config.site.lat) > 90
        || !Array.isArray(config.targets) || !config.targets.length || config.targets.length > 32) {
      throw new QueryError("站点配置无效");
    }
    const seen = new Set(), sims = new Set();
    for (const target of config.targets) {
      if (!validInteger(target?.device_id, 1, Number.MAX_SAFE_INTEGER) || seen.has(target.device_id)
          || typeof target.sim_id !== "string" || !/^\d{10,20}$/.test(target.sim_id) || sims.has(target.sim_id)
          || typeof target.name !== "string" || !target.name
          || (target.label !== undefined && typeof target.label !== "string")) throw new QueryError("设备白名单无效");
      seen.add(target.device_id); sims.add(target.sim_id);
    }
    return {site: {name: config.site.name, lng: config.site.lng, lat: config.site.lat},
      targets: config.targets.map(target => ({...base(target), sim_id: target.sim_id}))};
  }
  function responseData(response) {
    if (!response || response.code !== 200 || response.success !== true) throw new QueryError("服务暂未返回有效状态");
    return response.data;
  }
  function validateDevice(device, target) {
    if (!device || device.id !== target.device_id || String(device.simId) !== target.sim_id || device.name !== target.name) {
      throw new QueryError("设备身份与查询目标不一致");
    }
    if (!validInteger(device.portNumber, 1, 100) || !validInteger(device.freePortCount, 0, device.portNumber)) {
      throw new QueryError("插座数量异常");
    }
    if (device.online !== 1 || device.status !== 1) throw new QueryError("设备离线或停用");
  }
  function parseList(response, targets, checkedAt) {
    const devices = responseData(response);
    if (!Array.isArray(devices)) throw new QueryError("设备列表格式异常");
    const indexed = new Map();
    for (const device of devices) {
      if (!Number.isSafeInteger(device?.id)) continue;
      const entries = indexed.get(device.id) || [];
      entries.push(device); indexed.set(device.id, entries);
    }
    const candidates = [];
    const states = targets.map(target => {
      try {
        const matches = indexed.get(target.device_id) || [];
        if (matches.length !== 1) throw new QueryError("列表缺少设备或设备编号重复");
        const device = matches[0]; validateDevice(device, target);
        if (device.freePortCount > 0) {
          candidates.push(target); return unknown(target, "正在核实空闲插座");
        }
        // A zero list count cannot distinguish occupied, faulty, or disabled ports.
        return {...base(target), total: device.portNumber, free: [], ports: null,
          checkedAt, source: "list", error: null};
      } catch (error) { return unknown(target, error.message); }
    });
    return {states, candidates};
  }
  function parseDetail(response, target, checkedAt) {
    const data = responseData(response); validateDevice(data?.device, target);
    if (data.machineFault !== 0 || data.accessJudgmentFlag !== 0
        || ![0, undefined, null].includes(data.scramDeviceFlag)) throw new QueryError("设备故障或暂不可用");
    const {portNumber: total, freePortCount: count} = data.device;
    if (!Array.isArray(data.ports) || data.ports.length !== total + 1
        || data.ports.slice(1).some(value => !Number.isInteger(value) || !Object.hasOwn(STATUS_LABELS, value))) {
      throw new QueryError("插座状态格式异常");
    }
    // Index zero is an upstream placeholder, never a physical socket.
    const ports = data.ports.slice(1);
    const free = ports.flatMap((status, index) => status === 0 ? [index + 1] : []);
    if (free.length !== count) throw new QueryError("空闲数量与插座明细不一致");
    return {...base(target), total, free, ports, checkedAt, source: "detail", error: null};
  }
  function currentState(state, now = Date.now()) {
    const fresh = !state.error && Number.isFinite(state.checkedAt)
      && state.checkedAt <= now && now - state.checkedAt < FRESH_MS;
    return fresh ? {...state, fresh: true} : {...state, free: [], ports: null, fresh: false,
      error: state.error || "结果已过期，请刷新"};
  }
  function summarize(states, now = Date.now()) {
    const current = states.map(state => currentState(state, now));
    return {devices: current, free: current.reduce((count, device) => count + device.free.length, 0),
      available: current.filter(device => device.free.length).length,
      unknown: current.filter(device => !device.fresh).length,
      noVacancy: current.filter(device => device.fresh && !device.free.length).length};
  }
  function sleep(ms, signal) {
    if (signal?.aborted) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
      const onAbort = () => { clearTimeout(timer); reject(cancelled()); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
      signal?.addEventListener("abort", onAbort, {once: true});
    });
  }
  function createClient({fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = 7000,
    spacingMs = 1000, delay = sleep} = {}) {
    let cooldownUntil = 0, nextStart = 0;
    async function post(path, values, signal) {
      if (![LIST_PATH, DETAIL_PATH].includes(path)) throw new QueryError("查询地址不允许");
      if (signal?.aborted) throw cancelled();
      if (now() < cooldownUntil) throw new QueryError("查询暂时受限，请稍后手动刷新", {blocked: true, retryAt: cooldownUntil});
      const startAt = Math.max(now(), nextStart); nextStart = startAt + spacingMs;
      if (startAt > now()) await delay(startAt - now(), signal);
      if (signal?.aborted) throw cancelled();
      if (now() < cooldownUntil) throw new QueryError("查询暂时受限，请稍后手动刷新", {blocked: true, retryAt: cooldownUntil});
      const abort = new AbortController(); let timer, onAbort;
      const interrupted = new Promise((_, reject) => {
        onAbort = () => { abort.abort(); reject(cancelled()); };
        signal?.addEventListener("abort", onAbort, {once: true});
        timer = setTimeout(() => { abort.abort(); reject(new QueryError("查询超时，当前状态未知")); }, timeoutMs);
      });
      const checkedAt = now();
      try {
        const result = (async () => {
          const response = await fetchImpl(ORIGIN + path, {method: "POST", mode: "cors", credentials: "omit",
            cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: abort.signal,
            headers: {"Content-Type": "application/x-www-form-urlencoded"}, body: new URLSearchParams(values).toString()});
          if (abort.signal.aborted) throw cancelled();
          if ([403, 405, 429].includes(response.status)) {
            const retryHeader = response.headers?.get("Retry-After"), numeric = Number(retryHeader);
            const retryDelay = retryHeader && Number.isFinite(numeric) ? numeric * 1000 : Date.parse(retryHeader) - now();
            cooldownUntil = now() + Math.max(60000, Math.min(3600000, Number.isFinite(retryDelay) && retryDelay > 0 ? retryDelay : 300000));
            throw new QueryError(`服务暂时限制查询（HTTP ${response.status}），自动刷新已关闭`, {blocked: true, retryAt: cooldownUntil});
          }
          if (!response.ok) throw new QueryError(`查询失败（HTTP ${response.status}）`);
          let data;
          try { data = await response.json(); } catch { throw new QueryError("服务返回格式异常"); }
          return {data, checkedAt};
        })();
        return await Promise.race([result, interrupted]);
      } catch (error) {
        if (error instanceof QueryError) throw error;
        throw new QueryError("网络连接失败，当前状态未知");
      } finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
    }
    return {
      list: (site, signal) => post(LIST_PATH, {positioningFlag: 1, deviceFamily: 0, mapType: 2,
        name: site.name, lng: site.lng, lat: site.lat, appEntrance: 2, entrance: 2, version: "new"}, signal),
      detail: (target, signal) => post(DETAIL_PATH, {simId: target.sim_id, mapType: 2, appEntrance: 2,
        entrance: 2, version: "new"}, signal),
      get retryAt() { return cooldownUntil; },
    };
  }
  function createQuery(config, {client = createClient()} = {}) {
    const {site, targets} = validateConfig(config); let version = 0, active = null;
    async function run(onUpdate = () => {}) {
      active?.abort(); const abort = new AbortController(), round = ++version; active = abort;
      let states = targets.map(target => unknown(target, "正在查询")), blocked = null, next = 0;
      const publish = done => {
        if (round === version) onUpdate({states: states.map(state => ({...state,
          free: state.free.slice(), ports: state.ports?.slice() || null})), done,
          blocked: Boolean(blocked), retryAt: blocked?.retryAt || 0, message: blocked?.message || ""});
      };
      publish(false);
      try {
        const list = await client.list(site, abort.signal);
        if (round !== version) return;
        const parsed = parseList(list.data, targets, list.checkedAt); states = parsed.states; publish(false);
        async function worker() {
          while (!blocked && !abort.signal.aborted && next < parsed.candidates.length) {
            const target = parsed.candidates[next++], index = targets.findIndex(item => item.device_id === target.device_id);
            try {
              const detail = await client.detail(target, abort.signal);
              if (round !== version) return;
              states[index] = parseDetail(detail.data, target, detail.checkedAt);
            } catch (error) {
              if (round !== version) return;
              states[index] = unknown(target, error.message);
              if (error.blocked) { blocked = error; abort.abort(); }
            }
            publish(false);
          }
        }
        await Promise.all([worker(), worker()]);
        if (blocked) states = states.map(state => state.error ? unknown(state, "查询受限，当前状态未知") : state);
      } catch (error) {
        if (round !== version) return;
        if (error.blocked) blocked = error;
        states = targets.map(target => unknown(target, error.message));
      } finally {
        if (round === version) { active = null; publish(true); }
      }
    }
    return {run, cancel() { version++; active?.abort(); active = null; }, targets};
  }
  return {FRESH_MS, STATUS_LABELS, QueryError, validateConfig, parseList, parseDetail,
    unknown, currentState, summarize, createClient, createQuery};
});
