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
  let configuredTargets = [], entryHandled = false, controlKnown = false;
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
    connected = false; busy = false; active = []; stopping = false; controlKnown = false; entryHandled = false;
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
    const notifications = {not_sent: "尚未提交空位提醒", accepted: "微信提醒已提交", uncertain: "微信提醒未确认成功", rejected: "微信提醒未发送成功", test_suppressed: "验证运行，未发送微信提醒"};
    let selected = pinned, latestKnown = false, snapshot = null, runState = null, failure = "";
    let version = 0, inFlight = null, pollTimer = null, expiryTimer = null;
    let waiting = "";
    const selectionKey = selection => selection ? `${selection.id}-${selection.attempt}` : "";
    const timestamp = value => typeof value === "string" ? Date.parse(value) : NaN;
    const fresh = value => Number.isFinite(timestamp(value)) && Date.now() - timestamp(value) <= 30000
      && timestamp(value) <= Date.now() + 5000;
    const timeText = value => Number.isFinite(timestamp(value))
      ? new Date(value).toLocaleString("zh-CN", {timeZone: "Asia/Taipei", hour12: false}) : "无有效检测时间";
    const clockText = value => Number.isFinite(timestamp(value))
      ? new Date(value).toLocaleTimeString("zh-CN", {timeZone: "Asia/Taipei", hour12: false}) : "未确认";
    const checking = () => !hasLink && selected?.kind === "check"
      && (!runState || runState.run_attempt === selected.attempt)
      && activeStates.has(runState?.status || selected.status);

    function clearTimers() {
      clearTimeout(pollTimer); clearTimeout(expiryTimer);
      pollTimer = null; expiryTimer = null;
    }

    function validate(data, selection) {
      if (!data || ![1, 2].includes(data.schema_version) || data.run_id !== selection.id
          || data.run_attempt !== selection.attempt
          || typeof data.verification !== "boolean" || !Object.hasOwn(notifications, data.notification)
          || !Number.isFinite(timestamp(data.updated_at))) throw Error("结果内容或会话编号不匹配，暂不显示插座状态。");
      if (data.schema_version === 2) {
        if (!["check", "monitor"].includes(data.kind)
            || !["checking", "monitoring", "snapshot", "ended", "cancelled", "failed"].includes(data.phase)
            || !Number.isSafeInteger(data.round) || data.round < 0
            || !Number.isSafeInteger(data.expected_targets) || data.expected_targets < 1 || data.expected_targets > 32
            || !Array.isArray(data.devices) || data.devices.length > data.expected_targets
            || !Array.isArray(data.events)) throw Error("全场状态格式异常，暂不能确认空位。");
        const seen = new Set();
        for (const device of data.devices) {
          if (!device || !Number.isSafeInteger(device.device_id) || seen.has(device.device_id)
              || typeof device.name !== "string" || !device.name || !Array.isArray(device.free)
              || (device.total !== null && (!Number.isSafeInteger(device.total) || device.total < 1 || device.total > 100))
              || (device.error !== null && typeof device.error !== "string")
              || new Set(device.free).size !== device.free.length
              || device.free.some(port => !Number.isSafeInteger(port) || port < 1 || port > 100 || (device.total !== null && port > device.total))) {
            throw Error("充电桩状态格式异常，暂不能确认空位。");
          }
          seen.add(device.device_id);
        }
        for (const event of data.events) {
          if (!event || !["vacancy", "ended"].includes(event.kind)
              || !["accepted", "uncertain", "rejected", "test_suppressed"].includes(event.notification)) throw Error("提醒记录格式异常。");
        }
        return data;
      }
      if (!phases.has(data.phase) || typeof data.message !== "string" || !Array.isArray(data.cohort) || data.cohort.length > 32) throw Error("旧版结果格式异常。");
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
      $("results-refresh").disabled = !connected || busy || !!inFlight
        || (hasLink ? invalidLink || !selected : !!pendingStart && !pendingStart.retryAllowed);
      $("results-refresh").textContent = hasLink || active.length || checking() ? "刷新" : pendingStart?.retryAllowed ? "重试查询" : "重新查询";
      $("current-view").hidden = !hasLink;
      $("result-scope").textContent = pinned ? "本条提醒对应的查询" : `全部 ${configuredTargets.length || 15} 台充电桩`;
      $("result-groups").replaceChildren();
      $("result-summary").textContent = ""; $("result-summary").hidden = true;
      $("result-updated").textContent = "";
      $("result-note").textContent = "";
      $("result-state").className = "result-banner result-warning";
      if (invalidLink || !connected || !selected) {
        $("result-state").textContent = invalidLink ? "结果链接不完整" : !connected ? "连接后查看结果" : waiting || "正在核对当前查询";
        $("result-message").textContent = invalidLink ? "请从微信提醒重新打开。不会切换到其他查询。"
          : !connected ? "请先连接专用凭据。" : "本次结果尚未确认，旧记录不会作为当前空位显示。";
        return;
      }
      if (!snapshot) {
        $("result-state").textContent = failure ? "尚无可确认的结果" : "正在读取本次结果";
        $("result-message").textContent = failure || "";
        return;
      }
      if (snapshot.schema_version === 2) { renderCurrent(); return; }
      if (!hasLink) $("result-scope").textContent = "旧版监测 · 仅原提醒插座";
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

    function renderCurrent() {
      const sameAttempt = runState?.run_attempt === selected.attempt;
      const monitoring = snapshot.kind === "monitor" && snapshot.phase === "monitoring"
        && runState?.status === "in_progress" && sameAttempt && timestamp(snapshot.monitoring_until) > Date.now();
      const checkedOnce = snapshot.kind === "check" && snapshot.phase === "snapshot" && sameAttempt
        && (runState?.status === "in_progress" || (runState?.status === "completed" && runState.conclusion === "success"));
      const checkingNow = snapshot.kind === "check" && snapshot.phase === "checking"
        && runState?.status === "in_progress" && sameAttempt;
      const current = monitoring || checkedOnce || checkingNow;
      const sessionFresh = fresh(snapshot.updated_at);
      const prefix = snapshot.verification ? "验证运行 · " : "";
      const remaining = Math.max(0, Math.ceil((timestamp(snapshot.monitoring_until) - Date.now()) / 1000));
      if (failure) {
        $("result-state").textContent = prefix + "状态未知";
        $("result-message").textContent = "暂时无法确认当前空位，请稍后刷新。";
      } else if (!sameAttempt) {
        $("result-state").textContent = "已停止更新 · 历史记录";
        $("result-message").textContent = "这是较早一次的查询，不会切换到新一轮。";
      } else if (snapshot.phase === "checking" && activeStates.has(runState?.status)) {
        $("result-state").textContent = prefix + "正在查询全部充电桩";
        $("result-message").textContent = "正在读取本次状态，尚未确认的设备会标为未知。";
      } else if (!current) {
        $("result-state").textContent = prefix + ({cancelled: "监测已手动停止", failed: "本次查询异常结束"}[snapshot.phase] || "本次监测已结束") + " · 最后记录";
        $("result-message").textContent = "以下为保存的最后状态，不代表当前仍然空闲。";
      } else if (!sessionFresh) {
        $("result-state").textContent = prefix + "结果已过期 · 当前状态未知";
        $("result-message").textContent = monitoring ? "超过 30 秒未同步新结果。" : "这次查询已超过 30 秒，请点“重新查询”。";
      } else {
        $("result-state").textContent = prefix + (monitoring
          ? `监测中 · 剩余 ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")} · 第 ${snapshot.round} 轮`
          : "本次查询结果 · 未开启持续监测");
        $("result-message").textContent = monitoring ? "新出现的空位会继续微信提醒，期满会发结束通知。" : "有空位可直接前往；也可开启 15 分钟通知。";
        $("result-state").className = "result-banner result-current";
      }
      const byId = new Map(snapshot.devices.map(device => [device.device_id, device]));
      const rows = !hasLink && configuredTargets.length ? configuredTargets.map(target => {
        const device = byId.get(target.device_id);
        return device?.name === target.name ? device : {device_id: target.device_id, name: target.name,
          total: null, free: [], checked_at: null, error: device ? "设备信息不匹配" : "本轮未取得状态"};
      }) : snapshot.devices;
      const valid = device => current && !failure && sessionFresh && fresh(device.checked_at) && !device.error
        && Number.isSafeInteger(device.total);
      const freeRows = rows.filter(device => valid(device) && device.free.length);
      const busyRows = rows.filter(device => valid(device) && !device.free.length);
      const expected = Math.max(snapshot.expected_targets, rows.length);
      const unknownCount = expected - freeRows.length - busyRows.length;
      if (current && !failure && sessionFresh) {
        const freeCount = freeRows.reduce((count, device) => count + device.free.length, 0);
        const allBusy = !checkingNow && busyRows.length === expected && unknownCount === 0
          && (hasLink || expected === configuredTargets.length);
        $("result-summary").textContent = allBusy ? `${expected} 台全部忙`
          : freeCount ? `${freeCount} 个空闲 · ${freeRows.length} 台可充${unknownCount ? ` · ${unknownCount} 台未知` : ""}`
            : `${busyRows.length} 台无空位 · ${unknownCount} 台未知`;
        $("result-summary").hidden = false;
        if (checkingNow) $("result-message").textContent = unknownCount
          ? `已确认的状态先显示，另有 ${unknownCount} 台尚未查清。`
          : "已取得本轮设备状态，正在完成查询。";
        else if (allBusy) $("result-message").textContent = monitoring
          ? "暂时全部无空位，监测会继续，新空位会微信提醒。"
          : "暂时没有空位，点“有空位通知我”可监测 15 分钟。";
        else if (!freeCount && unknownCount) $("result-message").textContent = monitoring
          ? "部分充电桩暂未查清，监测会继续。"
          : "部分充电桩暂未查清，可继续查询或开启监测。";
      }
      const rank = device => valid(device) && device.free.length ? 0 : valid(device) ? 1 : 2;
      for (const device of rows.map((device, index) => ({device, index})).sort((a, b) => rank(a.device) - rank(b.device) || a.index - b.index).map(item => item.device)) {
        const group = element("section", "result-device");
        group.append(element("h3", "result-device-name", device.name));
        const stale = !sessionFresh || !fresh(device.checked_at);
        if (valid(device) && device.free.length) {
          const ports = element("div", "free-ports");
          for (const number of device.free) ports.append(element("strong", "port-state port-free", `${number} 号空闲`));
          group.append(ports);
        } else if (valid(device)) group.append(element("p", "device-status", "暂无空位"));
        else if (!current && !failure && !device.error && device.checked_at) {
          group.append(element("p", "device-status", `最后记录：${device.free.length ? device.free.map(number => `${number}号`).join("、") + "空闲" : "无空位"}${stale ? "（已过期）" : ""}`));
        } else group.append(element("p", "device-status device-unknown", stale && device.checked_at ? "状态未知 · 已过期" : "状态未知"));
        group.append(element("p", "port-time", `检测 ${timeText(device.checked_at)}`));
        if (device.error) group.append(element("p", "port-error", device.error));
        $("result-groups").append(group);
      }
      if (rows.length < expected) $("result-groups").append(element("p", "minor", `另有 ${expected - rows.length} 台未取得状态，不能判断为全部忙。`));
      $("result-updated").textContent = `最近更新 ${timeText(snapshot.updated_at)}${sessionFresh ? "" : "（已过期）"}`;
      const lastEvent = snapshot.events.at(-1);
      const eventWarning = lastEvent && ["uncertain", "rejected"].includes(lastEvent.notification)
        ? (lastEvent.kind === "ended" ? "结束通知" : "空位提醒") + (lastEvent.notification === "uncertain" ? "送达未确认。" : "发送未成功。") : "";
      if (eventWarning) $("result-message").textContent += " " + eventWarning;
      $("result-note").textContent = [failure, snapshot.message, eventWarning].filter(Boolean).join(" ");
    }

    function scheduleExpiry() {
      clearTimeout(expiryTimer); expiryTimer = null;
      if (!connected || document.hidden || !snapshot) return;
      const checks = snapshot.schema_version === 2 ? snapshot.devices.map(device => device.checked_at)
        : snapshot.cohort.flatMap(device => device.ports.map(port => port.checked_at));
      const deadlines = [timestamp(snapshot.updated_at) + 30000, timestamp(snapshot.monitoring_until || snapshot.tracking_until),
        ...checks.map(value => timestamp(value) + 30000)]
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
          ? {id: String(run.id), attempt: run.run_attempt, status: run.status,
            kind: run.display_title?.startsWith("查看当前空位") ? "check" : "monitor"} : null;
        if (selectionKey(next) === selectionKey(selected)) { if (!selected) render(); return; }
        reset(); selected = next; waiting = ""; render(); refreshResults();
      },
      waiting(message) { if (!hasLink) { reset(); selected = null; waiting = message; render(); } },
      isPinned: () => hasLink,
      checking,
      observeRuns(runs) {
        const run = selected && runs.find(item => String(item.id) === selected.id);
        if (!run || !Number.isSafeInteger(run.run_attempt)) return;
        if (runState?.status === "completed" && runState.run_attempt === run.run_attempt && run.status !== "completed") return;
        runState = run;
      },
      visibilityChanged() {
        if (document.hidden) clearTimers();
        else { render(); scheduleExpiry(); refreshResults(); }
      },
      refresh: refreshResults,
      render,
    };
  })();

  function controls(known = controlKnown) {
    controlKnown = known;
    const monitorRetry = pendingStart?.mode === "开始监控" && pendingStart.retryAllowed;
    $("start").disabled = !connected || !known || busy || (!!pendingStart && !monitorRetry) || active.length > 0 || stopping;
    $("start").hidden = resultView.isPinned() || active.length > 0 || stopping;
    $("start").textContent = monitorRetry ? "重试开始监测" : `有空位通知我 · ${$("minutes").value}分钟`;
    $("stop").disabled = !connected || !known || busy || active.length === 0 || stopping;
    $("stop").hidden = !active.length && !stopping;
    $("minutes").disabled = busy || active.length > 0 || !!pendingStart;
    resultView.render();
  }

  function matchesPending(run, pending) {
    if (!run || run.head_branch !== "main" || !run.display_title?.startsWith(pending.mode)
        || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) return false;
    return pending.runId ? String(run.id) === pending.runId
      : run.display_title.endsWith(` · req:${pending.requestId}`);
  }

  async function refresh() {
    if (!connected || busy) return;
    if (refreshInFlight?.connection === connectionVersion && refreshInFlight.version === refreshVersion) return;
    const connection = connectionVersion, refresh = ++refreshVersion;
    const ticket = refreshInFlight = {connection, version: refresh};
    const current = () => connected && connection === connectionVersion && refresh === refreshVersion && !busy;
    let autoCheck = false;
    try {
      const pending = pendingStart;
      const [data, directRun] = await Promise.all([
        api(WORKFLOW + "/runs?event=workflow_dispatch&per_page=100"),
        pending?.runId ? api(`/actions/runs/${pending.runId}`).catch(error => {
          if (error.status === 404) return null;
          throw error;
        }) : Promise.resolve(null),
      ]);
      if (!current()) return;
      if (!Array.isArray(data.workflow_runs)) throw Error("无法确认任务状态，请稍后刷新。");
      resultView.observeRuns(data.workflow_runs);
      const watches = data.workflow_runs.filter(run => run.head_branch === "main" && run.display_title?.startsWith("开始监控"));
      active = watches.filter(run => activeStates.has(run.status));
      if (pending && pending === pendingStart) {
        const started = matchesPending(directRun, pending) ? directRun
          : data.workflow_runs.find(run => matchesPending(run, pending));
        if (started) {
          pendingStart = null;
          if (pending.mode === "开始监控" && activeStates.has(started.status) && !active.some(run => run.id === started.id)) active.unshift(started);
          if (!resultView.isPinned()) resultView.latest(pending.mode === "开始监控" ? started : active[0] || started);
        } else {
          pending.retryAllowed = Date.now() - pending.at >= 90000;
          if (!resultView.isPinned()) resultView.waiting(pending.retryAllowed ? "尚未确认本次查询 · 可手动重试" : "正在等候本次查询启动");
        }
      }
      if (!resultView.isPinned() && active.length && pendingStart?.mode !== "开始监控") {
        entryHandled = true; resultView.latest(active[0]);
      }
      if (!resultView.isPinned() && !entryHandled && !pendingStart) {
        entryHandled = true;
        autoCheck = active.length === 0;
      }
      knownRuns = new Set(watches.map(run => run.id));
      if (stopping && active.length === 0) stopping = false;
      $("detail").hidden = false;
      if (stopping) {
        $("state").textContent = "正在停止监测";
        $("detail").textContent = "已请求停止，正在等待确认。";
      } else if (pendingStart) {
        $("state").textContent = pendingStart.retryAllowed ? "启动未确认" : "正在等候启动";
        $("detail").textContent = pendingStart.retryAllowed
          ? "超过 90 秒仍未找到本次任务。请手动重试，不会自动重复提交。"
          : "正在等待 GitHub 分配运行环境。";
      } else if (active.length) {
        const running = active.some(run => run.status === "in_progress");
        $("state").textContent = running ? "正在持续监测" : "监测排队中";
        $("detail").textContent = "全程查询全部设备，新出现的空位会微信提醒。";
        $("detail").hidden = running;
      } else {
        $("state").textContent = "未开启通知";
        $("detail").textContent = ""; $("detail").hidden = true;
      }
      $("message").textContent = "";
      controls(true);
    } catch (error) {
      if (!current()) return;
      $("state").textContent = "状态暂不明";
      $("message").textContent = error.message;
      controls(false);
    } finally {
      if (refreshInFlight === ticket) { refreshInFlight = null; scheduleRefresh(); }
    }
    if (autoCheck && connected && connection === connectionVersion && !busy && !pendingStart) await dispatchMode("查看当前空位");
  }

  function requestId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return "lvcc-" + Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
  }

  async function dispatchMode(mode) {
    if (!connected || !controlKnown || busy || stopping || (pendingStart && !pendingStart.retryAllowed)) return;
    if (mode === "开始监控" && active.length) return;
    const connection = connectionVersion;
    refreshVersion++; busy = true; entryHandled = true;
    const pending = {mode, requestId: requestId(), at: Date.now(), retryAllowed: false};
    pendingStart = pending;
    let actionError = "";
    if (!resultView.isPinned()) resultView.waiting(mode === "开始监控" ? "正在提交监测" : "正在查询当前全部充电桩");
    $("state").textContent = mode === "开始监控" ? "正在提交监测" : "正在提交当前查询";
    $("detail").hidden = false;
    $("detail").textContent = mode === "开始监控" ? "开启请求尚未确认。" : "本次只查询一次，不会发送微信通知。";
    $("message").textContent = "";
    controls(true);
    try {
      const result = await api(WORKFLOW + "/dispatches", "POST", {ref: "main", return_run_details: true,
        inputs: {mode, minutes: $("minutes").value, request_id: pending.requestId}});
      if (connection === connectionVersion && result?.workflow_run_id && /^[1-9]\d*$/.test(String(result.workflow_run_id))) {
        pending.runId = String(result.workflow_run_id);
      }
    } catch (error) {
      if (connection === connectionVersion) {
        actionError = error.message;
        if (error.status >= 400 && error.status < 500) {
          pendingStart = null;
          if (!resultView.isPinned()) resultView.waiting("本次查询未能提交 · 请手动重试");
        }
      }
    } finally {
      if (connection === connectionVersion) {
        busy = false; await refresh();
        if (connection === connectionVersion && actionError) $("message").textContent = actionError;
      }
    }
  }

  async function checkCurrent() {
    if (resultView.isPinned()) return resultView.refresh();
    if (active.length) { resultView.latest(active[0]); return resultView.refresh(); }
    if (resultView.checking()) return resultView.refresh();
    return dispatchMode("查看当前空位");
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
      configuredTargets = targets;
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

  $("start").addEventListener("click", () => dispatchMode("开始监控"));
  $("minutes").addEventListener("change", () => controls());

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
  $("results-refresh").addEventListener("click", checkCurrent);
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
