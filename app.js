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
  let refreshTimer = null;
  const requests = new Set();

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = null;
    if (!connected || document.hidden) return;
    const transitioning = pendingStart || stopping || active.some(run => run.status !== "in_progress");
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (!document.hidden) refresh();
    }, transitioning ? 3000 : 10000);
  }

  function invalidateConnection() {
    connectionVersion++; refreshVersion++;
    clearTimeout(refreshTimer); refreshTimer = null;
    for (const request of requests) request.abort();
    connected = false; busy = false; active = []; stopping = false;
    resultView.disconnected();
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

  // Result selection is separate from the current monitor's start/stop controls.
  const resultView = (() => {
    const params = new URLSearchParams(location.search);
    const hasLink = params.has("run") || params.has("attempt");
    const digits = value => typeof value === "string" && /^[1-9]\d*$/.test(value);
    const validLink = digits(params.get("run")) && digits(params.get("attempt"))
      && Number.isSafeInteger(Number(params.get("attempt")));
    const pinned = hasLink && validLink ? {id: params.get("run"), attempt: Number(params.get("attempt"))} : null;
    const invalidLink = hasLink && !validLink;
    const labels = {free: "空闲", occupied: "已占用", fault: "故障", disabled: "停用", unknown: "未知"};
    const phases = new Set(["searching", "tracking", "ended", "cancelled", "failed"]);
    const notifications = {not_sent: "尚未提交空位提醒", accepted: "微信提醒已提交", uncertain: "微信提醒未确认成功", test_suppressed: "验证运行，未发送微信提醒"};
    let selected = pinned, latestKnown = false, snapshot = null, runState = null, failure = "";
    let version = 0, inFlight = null, pollTimer = null, expiryTimer = null;
    const selectionKey = selection => selection ? `${selection.id}-${selection.attempt}` : "";
    const timestamp = value => typeof value === "string" ? Date.parse(value) : NaN;
    const fresh = value => Number.isFinite(timestamp(value)) && Date.now() - timestamp(value) <= 30000
      && timestamp(value) <= Date.now() + 5000;
    const timeText = value => Number.isFinite(timestamp(value))
      ? new Date(value).toLocaleString("zh-CN", {timeZone: "Asia/Taipei", hour12: false}) : "无有效检测时间";
    const clockText = value => Number.isFinite(timestamp(value))
      ? new Date(value).toLocaleTimeString("zh-CN", {timeZone: "Asia/Taipei", hour12: false}) : "未确认";

    function clearTimers() {
      clearTimeout(pollTimer); clearTimeout(expiryTimer);
      pollTimer = null; expiryTimer = null;
    }

    function validate(data, selection) {
      if (!data || data.schema_version !== 1 || data.run_id !== selection.id
          || data.run_attempt !== selection.attempt || !phases.has(data.phase)
          || typeof data.verification !== "boolean" || !Object.hasOwn(notifications, data.notification)
          || typeof data.message !== "string" || !Array.isArray(data.cohort) || data.cohort.length > 32
          || !Number.isFinite(timestamp(data.updated_at))) throw Error("结果内容或会话编号不匹配，暂不显示插座状态。");
      const devices = new Set();
      for (const device of data.cohort) {
        if (!device || !Number.isSafeInteger(device.device_id) || devices.has(device.device_id)
            || typeof device.name !== "string" || !device.name || !Array.isArray(device.ports)
            || device.ports.length > 100) throw Error("结果设备格式异常，暂不显示插座状态。");
        devices.add(device.device_id);
        const ports = new Set();
        for (const port of device.ports) {
          if (!port || !Number.isSafeInteger(port.number) || port.number < 1 || ports.has(port.number)
              || !Object.hasOwn(labels, port.status)) throw Error("插座结果格式异常，暂不显示状态。");
          ports.add(port.number);
        }
      }
      return data;
    }

    function element(tag, className, text) {
      const node = document.createElement(tag);
      node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    function render() {
      $("results").hidden = !connected;
      $("target-list").hidden = !connected;
      $("results-refresh").disabled = !connected || invalidLink || !selected || !!inFlight;
      $("result-scope").textContent = pinned ? "本条提醒 · 固定查看" : "最近一次查询";
      $("result-groups").replaceChildren();
      $("result-summary").textContent = ""; $("result-summary").hidden = true;
      $("result-updated").textContent = "";
      $("result-note").textContent = "";
      $("result-state").className = "result-banner result-warning";
      if (invalidLink || !connected || !selected) {
        $("result-state").textContent = invalidLink ? "结果链接不完整" : !connected ? "连接后查看结果" : latestKnown ? "暂无监控记录" : "正在查找监控记录";
        $("result-message").textContent = invalidLink ? "请从微信提醒重新打开。不会切换到其他查询。"
          : !connected ? "请先连接专用凭据。" : "开启查询后，这里会显示结果。";
        return;
      }
      if (!snapshot) {
        $("result-state").textContent = failure ? "尚无可确认的结果" : "正在读取本次结果";
        $("result-message").textContent = failure || "";
        return;
      }
      const sameAttempt = runState?.run_attempt === selected.attempt;
      const tracking = snapshot.phase === "tracking" && runState?.status === "in_progress"
        && sameAttempt && timestamp(snapshot.tracking_until) > Date.now();
      const sessionFresh = fresh(snapshot.updated_at);
      const verified = snapshot.verification ? "验证运行 · " : "";
      let state, explanation;
      if (failure) {
        state = "状态未知"; explanation = "暂未确认当前空位，请稍后刷新。";
      } else if (!tracking) {
        state = snapshot.phase === "searching" && !snapshot.cohort.length && runState?.status === "in_progress" && sameAttempt
          ? "正在查找空位" : "已停止更新 · 历史记录";
        explanation = state === "正在查找空位" ? "发现空位后会发微信。" : !sameAttempt ? "这是较早一次的记录，跟踪已结束。"
          : "最后保存的状态，不代表现在仍然空闲。";
      } else if (!sessionFresh) {
        state = "数据已过期 · 状态未知"; explanation = "超过 30 秒没更新，当前空位未知。";
      } else {
        state = `跟踪中 · ${clockText(snapshot.tracking_until)} 结束`;
        explanation = "";
        $("result-state").className = "result-banner result-current";
      }
      $("result-state").textContent = verified + state;
      const notificationText = notifications[snapshot.notification]
        + (snapshot.notification === "uncertain" && tracking ? "，网页继续跟踪" : "");
      $("result-message").textContent = [explanation, snapshot.notification === "uncertain" ? notificationText : ""].filter(Boolean).join(" ");
      $("result-note").textContent = [failure, notificationText, snapshot.message].filter(Boolean).join(" ");
      $("result-updated").textContent = `更新于 ${timeText(snapshot.updated_at)}${sessionFresh ? "" : "（已过期）"}`;
      const validCurrent = port => tracking && !failure && sessionFresh && fresh(port.checked_at) && !port.error;
      const available = port => validCurrent(port) && port.status === "free";
      if (tracking && !failure && sessionFresh) {
        const counts = {free: 0, occupied: 0, fault: 0, disabled: 0};
        for (const device of snapshot.cohort) for (const port of device.ports) {
          if (validCurrent(port) && Object.hasOwn(counts, port.status)) counts[port.status]++;
        }
        $("result-summary").textContent = Object.entries(counts).filter(([, count]) => count)
          .map(([status, count]) => `${count} 个${labels[status]}`).join(" · ") || "暂无可确认的插座状态";
        $("result-summary").hidden = false;
      }
      const devices = snapshot.cohort.map((device, index) => ({device, index, available: device.ports.some(available)}))
        .sort((a, b) => Number(b.available) - Number(a.available) || a.index - b.index);
      for (const {device} of devices) {
        const group = element("section", "result-device");
        group.append(element("h3", "result-device-name", device.name));
        const list = element("ul", "port-results");
        const ports = device.ports.map((port, index) => ({port, index}))
          .sort((a, b) => Number(available(b.port)) - Number(available(a.port)) || a.index - b.index);
        for (const {port} of ports) {
          const row = element("li", "port-result"), stale = !sessionFresh || !fresh(port.checked_at);
          let status = port.status, text = labels[status], className = "port-state";
          if (failure || port.error) { status = "unknown"; text = "未知 · 暂未确认"; }
          else if (!tracking) { text = `最后记录：${text}${stale ? "（已过期）" : ""}`; }
          else if (stale) { status = "unknown"; text = "未知 · 数据已过期"; }
          else className += " port-" + status;
          row.append(element("span", "port-number", `${port.number} 号插座`), element("strong", className, text));
          row.append(element("span", "port-time", `更新 ${tracking && !stale ? clockText(port.checked_at) : timeText(port.checked_at)}`));
          if (typeof port.error === "string" && port.error) row.append(element("span", "port-error", port.error));
          list.append(row);
        }
        group.append(list); $("result-groups").append(group);
      }
    }

    function scheduleExpiry() {
      clearTimeout(expiryTimer); expiryTimer = null;
      if (!connected || document.hidden || !snapshot) return;
      const deadlines = [timestamp(snapshot.updated_at) + 30000, timestamp(snapshot.tracking_until),
        ...snapshot.cohort.flatMap(device => device.ports.map(port => timestamp(port.checked_at) + 30000))]
        .filter(value => Number.isFinite(value) && value >= Date.now());
      if (deadlines.length) expiryTimer = setTimeout(() => { render(); scheduleExpiry(); }, Math.max(1, Math.min(...deadlines) - Date.now() + 1));
    }

    function schedulePoll() {
      clearTimeout(pollTimer); pollTimer = null;
      if (connected && !document.hidden && selected && !invalidLink) pollTimer = setTimeout(refreshResults, 5000);
    }

    async function refreshResults() {
      if (!connected || document.hidden || !selected || invalidLink || inFlight) return;
      clearTimeout(pollTimer); pollTimer = null;
      const selection = {...selected}, connection = connectionVersion;
      const ticket = inFlight = ++version;
      const current = () => connected && connection === connectionVersion && inFlight === ticket
        && selectionKey(selected) === selectionKey(selection);
      $("results-refresh").disabled = true;
      try {
        const [run, file] = await Promise.all([
          api(`/actions/runs/${selection.id}`).catch(error => {
            if (error.status === 404) { error.noResults = true; error.message = "本次任务记录已不可访问，或旧版尚无结果。这里不会显示其他会话。"; }
            throw error;
          }),
          api(`/contents/sessions/${selectionKey(selection)}.json?ref=codex%2Fruntime-state`).catch(error => {
            if (error.status === 404) { error.noResults = true; error.message = "这次任务可能是旧版，或尚未发布结果。不会改为显示其他任务。"; }
            throw error;
          }),
        ]);
        if (!current()) return;
        if (String(run.id) !== selection.id || !Number.isSafeInteger(run.run_attempt) || typeof run.status !== "string") throw Error("无法确认指定任务的状态，暂不显示实时结果。");
        if (file.encoding !== "base64" || typeof file.content !== "string") throw Error("无法读取结果文件，请稍后刷新。");
        const bytes = Uint8Array.from(atob(file.content.replace(/\s/g, "")), c => c.charCodeAt(0));
        snapshot = validate(JSON.parse(new TextDecoder().decode(bytes)), selection);
        runState = run; failure = "";
      } catch (error) {
        if (!current()) return;
        failure = error.message;
        if (error.noResults) { snapshot = null; runState = null; }
      } finally {
        if (current()) {
          inFlight = null;
          render(); scheduleExpiry(); schedulePoll();
        }
      }
    }

    function reset() {
      ++version; inFlight = null; clearTimers(); snapshot = null; runState = null; failure = "";
    }

    return {
      disconnected() { reset(); selected = pinned; latestKnown = false; render(); },
      connected() { render(); if (pinned) refreshResults(); },
      latest(run) {
        if (hasLink) return;
        latestKnown = true;
        const next = run && digits(String(run.id)) && Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0
          ? {id: String(run.id), attempt: run.run_attempt} : null;
        if (selectionKey(next) === selectionKey(selected)) { if (!selected) render(); return; }
        reset(); selected = next; render(); refreshResults();
      },
      visibilityChanged() {
        if (document.hidden) clearTimers();
        else { render(); scheduleExpiry(); refreshResults(); }
      },
      refresh: refreshResults,
      render,
    };
  })();

  function controls(known) {
    $("start").disabled = !connected || !known || busy || (!!pendingStart && !pendingStart.retryAllowed) || active.length > 0 || stopping;
    $("start").textContent = pendingStart?.retryAllowed ? "重试开启" : "开启";
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
      resultView.latest(watches[0] || null);
      if (pendingStart) {
        const started = watches.find(run => pendingStart.id ? run.id === pendingStart.id : !pendingStart.seenIds.has(run.id) && Date.parse(run.created_at) >= pendingStart.at - 1000);
        if (started) pendingStart = null;
        else pendingStart.retryAllowed = Date.now() - pendingStart.at >= 90000;
      }
      knownRuns = new Set(watches.map(run => run.id));
      if (stopping && active.length === 0) stopping = false;
      $("detail").hidden = false;
      if (stopping) {
        $("state").textContent = "正在关闭";
        $("detail").textContent = "已请求停止，正在等待 GitHub 确认。";
      } else if (pendingStart) {
        $("state").textContent = pendingStart.retryAllowed ? "未确认启动" : "正在确认启动";
        $("detail").textContent = pendingStart.retryAllowed
          ? "超过 90 秒仍未找到任务。可点击“重试开启”，不会自动重发。"
          : "等待 GitHub 创建任务。暂时不要重复点击。";
      } else if (active.length) {
        const running = active.some(run => run.status === "in_progress");
        $("state").textContent = running ? "监控运行中" : "等待 GitHub 启动";
        $("detail").textContent = running ? "发现空位发一次微信，并继续跟踪这些插座 15 分钟。" : "任务已提交，GitHub 正在排队分配运行环境。";
        $("detail").hidden = running;
      } else {
        $("state").textContent = "已关闭";
        const failed = watches[0]?.conclusion === "failure";
        $("detail").textContent = failed ? "上一轮异常结束，请查看微信绑定或任务记录。" : "当前没有正在运行的查询。";
        $("detail").hidden = !failed;
      }
      $("message").textContent = "";
      controls(true);
    } catch (error) {
      if (!current()) return;
      $("state").textContent = "状态暂不明";
      $("message").textContent = error.message;
      controls(false);
    } finally {
      if (refreshInFlight === ticket) {
        refreshInFlight = null;
        scheduleRefresh();
      }
    }
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
      $("target-summary").textContent = `监控 ${targets.length} 台充电桩 · 查看名单`;
      $("target-list").open = false;
      connected = true;
      if (save) {
        sessionStorage.setItem(KEY_NAME, candidate);
        if ($("remember").checked) localStorage.setItem(KEY_NAME, candidate); else localStorage.removeItem(KEY_NAME);
      }
      $("access-key").value = "";
      $("connect-panel").hidden = true; $("control-panel").hidden = false;
      resultView.connected();
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
    $("state").textContent = "正在提交开启";
    $("detail").hidden = false;
    $("detail").textContent = "正在向 GitHub 发送开启请求，任务尚未确认启动。";
    $("message").textContent = "";
    try {
      const result = await api(WORKFLOW + "/dispatches", "POST", {ref: "main", inputs: {mode: "开始监控", minutes: $("minutes").value}});
      if (connection === connectionVersion) {
        pending.id = result?.workflow_run_id;
        $("state").textContent = "正在确认启动";
        $("detail").textContent = "开启请求已提交，正在等待 GitHub 创建任务。";
      }
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
    $("state").textContent = "正在提交关闭";
    $("detail").hidden = false;
    $("detail").textContent = "正在向 GitHub 发送停止请求，任务尚未确认停止。";
    $("message").textContent = "";
    try {
      for (const run of runs) {
        if (connection !== connectionVersion) return;
        await api(`/actions/runs/${run.id}/cancel`, "POST");
      }
      if (connection === connectionVersion) {
        stopping = true;
        $("state").textContent = "正在关闭";
        $("detail").textContent = "已请求停止，正在等待 GitHub 确认。";
      }
    } catch (error) { if (connection === connectionVersion) actionError = error.message; }
    finally {
      if (connection === connectionVersion) {
        busy = false; await refresh();
        if (connection === connectionVersion && actionError) $("message").textContent = actionError;
      }
    }
  });

  $("refresh").addEventListener("click", refresh);
  $("results-refresh").addEventListener("click", resultView.refresh);
  $("disconnect").addEventListener("click", () => {
    invalidateConnection();
    sessionStorage.removeItem(KEY_NAME); localStorage.removeItem(KEY_NAME); key = ""; connected = false;
    $("connect").disabled = false;
    $("connect-panel").hidden = false; $("control-panel").hidden = true;
    $("message").textContent = "已断开本设备连接。这不会停止正在运行的查询。";
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { clearTimeout(refreshTimer); refreshTimer = null; }
    else refresh();
    resultView.visibilityChanged();
  });
  resultView.render();
  if (key) connect(false);
})();
