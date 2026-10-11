/* Synthetic data only. This model never performs a network request. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LvccFixture = factory();
})(globalThis, function () {
  return function createFixture({scenario = "free", now = () => Date.now(), runId = 901, attempt = 1, dispatchStatus = 200} = {}) {
    const targets = Array.from({length: 15}, (_, index) => ({device_id: index + 1,
      name: `示例校园 ${String(index + 1).padStart(2, "0")} 号充电桩`, sim_id: String(700000000000000 + index)}));
    const calls = [], runs = new Map();
    let nextId = 1001, networkFailure = false, freeNumbers = [2, 4], sampledAt = now();
    const iso = milliseconds => new Date(milliseconds).toISOString();
    function record(id, mode, requestId = "fixture", status = "completed") {
      return {id, run_attempt: attempt, head_branch: "main", status,
        conclusion: status === "completed" ? "success" : null,
        display_title: `${mode} · 最多 15 分钟 · req:${requestId}`, created_at: iso(now()), mode};
    }
    if (["monitoring", "legacy", "historical", "pinned", "verification"].includes(scenario)) {
      runs.set(runId, record(runId, scenario === "verification" ? "验证持续监测" : "开始监控", "fixture",
        ["historical", "pinned"].includes(scenario) ? "completed" : "in_progress"));
    }
    function state(run) {
      const isMonitor = run.mode !== "查看当前空位", at = scenario === "stale" ? sampledAt - 45000 : sampledAt;
      const phase = run.status === "queued" || (scenario === "incremental" && !isMonitor && run.status === "in_progress") ? "checking" : isMonitor
        ? run.status === "completed" ? "ended" : "monitoring" : "snapshot";
      if (scenario === "legacy") return {schema_version: 1, run_id: String(run.id), run_attempt: run.run_attempt,
        phase: "tracking", started_at: iso(at), updated_at: iso(at), notified_at: iso(at), tracking_until: iso(at + 900000),
        ended_at: null, notification: "accepted", verification: false, message: "旧版示例记录",
        cohort: [{device_id: 1, name: targets[0].name, ports: [{number: 2, status: "free", first_seen_at: iso(at), checked_at: iso(at), changed_at: iso(at), error: null}]}]};
      const devices = targets.map((target, index) => ({device_id: target.device_id, name: target.name, total: 8,
        free: scenario === "busy" ? [] : index === 2 ? freeNumbers.slice() : [], checked_at: iso(at), error: null}));
      if (scenario === "partial") { devices[2].free = []; devices[7] = {...devices[7], total: null, checked_at: null, error: "示例：本次接口没有返回状态"}; }
      if (scenario === "incremental") devices[0].free = [2];
      return {schema_version: 2, kind: isMonitor ? "monitor" : "check", run_id: String(run.id), run_attempt: run.run_attempt,
        phase, started_at: iso(at), updated_at: iso(at), notified_at: null, monitoring_until: isMonitor ? iso(at + 900000) : null,
        ended_at: run.status === "completed" ? iso(at) : null, notification: "not_sent", verification: scenario === "verification",
        message: "合成测试数据", cohort: [], expected_targets: 15, round: phase === "checking" ? 0 : 4,
        devices: scenario === "incremental" && !isMonitor ? devices.slice(0, 1) : phase === "checking" ? [] : devices,
        events: scenario === "verification" ? [{id: "fake-event", kind: "vacancy", at: iso(at), notification: "test_suppressed"}] : []};
    }
    const encode = value => typeof Buffer !== "undefined" ? Buffer.from(JSON.stringify(value)).toString("base64")
      : btoa(unescape(encodeURIComponent(JSON.stringify(value))));
    const file = value => ({encoding: "base64", content: encode(value), download_url: "https://do-not-fetch.invalid/synthetic"});
    const response = (value, status = 200) => ({ok: status >= 200 && status < 300, status, json: async () => value});
    async function fetch(url, options = {}) {
      calls.push({url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null});
      if (networkFailure) throw TypeError("Synthetic network failure");
      const parsed = new URL(url), path = parsed.pathname;
      if (path.endsWith("/contents/targets.json")) return response(file(targets));
      if (path.endsWith("/actions/workflows/watch.yml/runs")) return response({workflow_runs: [...runs.values()].sort((a, b) => b.id - a.id)});
      if (path.endsWith("/actions/workflows/watch.yml/dispatches")) {
        const body = JSON.parse(options.body), id = nextId++;
        const status = scenario === "queued" ? "queued" : scenario === "incremental" || body.inputs.mode === "开始监控" ? "in_progress" : "completed";
        runs.set(id, record(id, body.inputs.mode, body.inputs.request_id, status));
        sampledAt = now();
        return response(dispatchStatus === 204 ? null : {workflow_run_id: id}, dispatchStatus);
      }
      const cancel = path.match(/\/actions\/runs\/(\d+)\/cancel$/);
      if (cancel) {
        const run = runs.get(Number(cancel[1]));
        if (!run) return response({}, 404);
        run.status = "completed"; run.conclusion = "cancelled";
        return response({message: "Synthetic cancellation"}, 202);
      }
      const metadata = path.match(/\/actions\/runs\/(\d+)$/);
      if (metadata) return runs.has(Number(metadata[1])) ? response(runs.get(Number(metadata[1]))) : response({}, 404);
      const session = path.match(/\/contents\/sessions\/(\d+)-(\d+)\.json$/);
      if (session) {
        const run = runs.get(Number(session[1]));
        if (!run) return response({}, 404);
        const data = state(run); data.run_attempt = Number(session[2]);
        return response(file(data));
      }
      throw Error("Unexpected fixture URL: " + path);
    }
    return {targets, calls, runs, fetch, state, response, file,
      setNetworkFailure(value) { networkFailure = value; },
      setFree(numbers) { freeNumbers = numbers; sampledAt = now(); },
      addRun(id, mode = "开始监控", status = "in_progress", requestId = "other") { const run = record(id, mode, requestId, status); runs.set(id, run); return run; }};
  };
});
