"use strict";
(() => {
  const API = "https://api.github.com/repos/Starsky618/lvcc-alert";
  const WORKFLOW = "/actions/workflows/watch.yml";
  const KEY_NAME = "lvcc-controller-key";
  const $ = id => document.getElementById(id);
  const activeStates = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);
  let key = sessionStorage.getItem(KEY_NAME) || localStorage.getItem(KEY_NAME) || "";
  let active = [], connected = false, busy = false, pendingStart = null, stopping = false;
  let connectionVersion = 0, refreshVersion = 0, knownRuns = new Set(), refreshInFlight = null;
  const requests = new Set();

  function invalidateConnection() {
    connectionVersion++; refreshVersion++;
    for (const request of requests) request.abort();
    connected = false; busy = false; active = []; stopping = false;
    controls(false);
    return connectionVersion;
  }

  async function api(path, method = "GET", data) {
    const abort = new AbortController();
    requests.add(abort);
    const timeout = setTimeout(() => abort.abort(), 15000);
    try {
      const response = await fetch(API + path, {
        method, signal: abort.signal, cache: "no-store", credentials: "omit",
        headers: {Authorization: "Bearer " + key, Accept: "application/vnd.github+json",
          ...(data ? {"Content-Type": "application/json"} : {})},
        ...(data ? {body: JSON.stringify(data)} : {}),
      });
      if (!response.ok) {
        const errors = {401: "连接凭据已失效，请重新连接。", 403: "凭据权限不足或 GitHub 暂时限制请求。", 404: "无法访问监控仓库，请检查凭据授权范围。", 409: "任务状态刚刚发生变化，请刷新确认。", 422: "GitHub 未接受本次操作，请检查工作流配置。"};
        const failure = Error(errors[response.status] || `GitHub 返回 HTTP ${response.status}`); failure.status = response.status; throw failure;
      }
      return response.status === 204 ? null : await response.json();
    } catch (error) {
      if (error.name === "AbortError" || error instanceof TypeError) throw Error("暂时连不上 GitHub；查询可能仍在运行，请恢复网络后刷新确认。");
      throw error;
    } finally { clearTimeout(timeout); requests.delete(abort); }
  }

  function controls(known) {
    $("start").disabled = !connected || !known || busy || (!!pendingStart && !pendingStart.retryAllowed) || active.length > 0 || stopping;
    $("start").textContent = pendingStart?.retryAllowed ? "重新尝试开启" : "开启查询";
    $("stop").disabled = !connected || !known || busy || active.length === 0 || stopping;
    $("minutes").disabled = busy || active.length > 0 || !!pendingStart;
  }

  async function refresh() {
    if (!connected || busy) return;
    if (refreshInFlight?.connection === connectionVersion && refreshInFlight.version === refreshVersion) return;
    const connection = connectionVersion, refresh = ++refreshVersion;
    const ticket = refreshInFlight = {connection, version: refresh};
    const current = () => connected && connection === connectionVersion && refresh === refreshVersion && !busy;
    try {
      const data = await api(WORKFLOW + "/runs?event=workflow_dispatch&per_page=100");
      if (!current()) return;
      if (!Array.isArray(data.workflow_runs)) throw Error("无法确认任务状态，请稍后刷新。");
      const watches = data.workflow_runs.filter(run => run.head_branch === "main" && run.display_title?.startsWith("开始监控"));
      active = watches.filter(run => activeStates.has(run.status));
      if (pendingStart) {
        const started = watches.find(run => pendingStart.id ? run.id === pendingStart.id : !pendingStart.seenIds.has(run.id) && Date.parse(run.created_at) >= pendingStart.at - 1000);
        if (started) pendingStart = null;
        else pendingStart.retryAllowed = Date.now() - pendingStart.at >= 90000;
      }
      knownRuns = new Set(watches.map(run => run.id));
      if (stopping && active.length === 0) stopping = false;
      if (stopping) {
        $("state").textContent = "正在关闭";
        $("detail").textContent = "已请求停止，正在等待 GitHub 确认。";
      } else if (pendingStart) {
        $("state").textContent = pendingStart.retryAllowed ? "未确认启动" : "正在确认启动";
        $("detail").textContent = pendingStart.retryAllowed
          ? "已超过 90 秒，仍未找到本次任务。可点击“重新尝试开启”手动重试；系统不会自动重发。"
          : "等待 GitHub 创建任务。暂时不要重复点击。";
      } else if (active.length) {
        const running = active.some(run => run.status === "in_progress");
        $("state").textContent = running ? "正在查询" : "等待 GitHub 启动";
        $("detail").textContent = running ? "有空位会发微信，提醒一次后自动结束。" : "任务已提交，GitHub 正在排队分配运行环境。";
      } else {
        $("state").textContent = "已关闭";
        const failed = watches[0]?.conclusion === "failure";
        $("detail").textContent = failed ? "上一轮异常结束，请查看微信绑定或任务记录。" : "当前没有正在运行的查询。";
      }
      $("message").textContent = "";
      controls(true);
    } catch (error) {
      if (!current()) return;
      $("state").textContent = "状态暂不明";
      $("message").textContent = error.message;
      controls(false);
    } finally { if (refreshInFlight === ticket) refreshInFlight = null; }
  }

  async function connect(save, candidate = key) {
    const connection = invalidateConnection();
    key = candidate; $("connect").disabled = true;
    try {
      if (!/^github_pat_[A-Za-z0-9_]+$/.test(candidate)) throw Error("请使用仅授权 lvcc-alert 仓库的专用连接凭据，不要填写微信推送密钥。");
      const file = await api("/contents/targets.json?ref=main");
      if (connection !== connectionVersion) return;
      if (file.encoding !== "base64") throw Error("无法读取监控目标配置。");
      const raw = Uint8Array.from(atob(file.content.replace(/\s/g, "")), c => c.charCodeAt(0));
      const targets = JSON.parse(new TextDecoder().decode(raw));
      if (!Array.isArray(targets) || !targets.length) throw Error("尚未配置监控目标。");
      $("targets").replaceChildren();
      for (const target of targets) {
        const item = document.createElement("p"); item.className = "target"; item.textContent = target.name;
        $("targets").append(item);
      }
      connected = true;
      if (save) {
        sessionStorage.setItem(KEY_NAME, candidate);
        if ($("remember").checked) localStorage.setItem(KEY_NAME, candidate); else localStorage.removeItem(KEY_NAME);
      }
      $("access-key").value = "";
      $("connect-panel").hidden = true; $("control-panel").hidden = false;
      await refresh();
    } catch (error) {
      if (connection === connectionVersion) $("message").textContent = error.message;
    } finally {
      if (connection === connectionVersion) $("connect").disabled = false;
    }
  }

  $("connect").addEventListener("click", () => connect(true, $("access-key").value.trim()));

  $("start").addEventListener("click", async () => {
    if (!connected || busy || active.length || stopping || (pendingStart && !pendingStart.retryAllowed)) return;
    const connection = connectionVersion;
    refreshVersion++; busy = true; let actionError = "";
    const pending = {at: Date.now(), seenIds: new Set(knownRuns), retryAllowed: false};
    pendingStart = pending; controls(true);
    try {
      const result = await api(WORKFLOW + "/dispatches", "POST", {ref: "main", inputs: {mode: "开始监控", minutes: $("minutes").value}});
      if (connection === connectionVersion) pending.id = result?.workflow_run_id;
    } catch (error) {
      if (connection === connectionVersion) {
        actionError = error.message;
        if (error.status >= 400 && error.status < 500) pendingStart = null;
      }
    } finally {
      if (connection === connectionVersion) {
        busy = false; await refresh();
        if (connection === connectionVersion && actionError) $("message").textContent = actionError;
      }
    }
  });

  $("stop").addEventListener("click", async () => {
    if (!connected || busy || !active.length) return;
    const connection = connectionVersion, runs = active.slice();
    refreshVersion++; busy = true; controls(true); let actionError = "";
    try {
      for (const run of runs) {
        if (connection !== connectionVersion) return;
        await api(`/actions/runs/${run.id}/cancel`, "POST");
      }
      if (connection === connectionVersion) stopping = true;
    } catch (error) { if (connection === connectionVersion) actionError = error.message; }
    finally {
      if (connection === connectionVersion) {
        busy = false; await refresh();
        if (connection === connectionVersion && actionError) $("message").textContent = actionError;
      }
    }
  });

  $("refresh").addEventListener("click", refresh);
  $("disconnect").addEventListener("click", () => {
    invalidateConnection();
    sessionStorage.removeItem(KEY_NAME); localStorage.removeItem(KEY_NAME); key = ""; connected = false;
    $("connect").disabled = false;
    $("connect-panel").hidden = false; $("control-panel").hidden = true;
    $("message").textContent = "已断开本设备连接。这不会停止正在运行的查询。";
  });
  if (key) connect(false);
  setInterval(() => { if (!document.hidden) refresh(); }, 10000);
})();
