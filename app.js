"use strict";
(() => {
  // Delete the old controller credential without ever reading its value.
  for (const name of ["localStorage", "sessionStorage"]) {
    try { globalThis[name].removeItem("lvcc-controller-key"); } catch { /* Storage can be disabled. */ }
  }
  const $ = id => document.getElementById(id);
  const {FRESH_MS, STATUS_LABELS, currentState, summarize, unknown, createQuery} = LvccQuery;
  const query = createQuery(LvccSite), AUTO_MS = 30000;
  let states = query.targets.map(target => unknown(target)), loading = false, hasResult = false;
  let autoTimer = null, expiryTimer = null, retryTimer = null, retryAt = 0, restriction = "", lastCompletedAt = null;
  const params = new URLSearchParams(location.search);
  $("legacy-link-note").hidden = !params.has("run") && !params.has("attempt");
  $("result-scope").textContent = `明向校区 · ${query.targets.length} 台充电桩`;
  const timeText = value => new Date(value).toLocaleTimeString("zh-CN", {timeZone: "Asia/Taipei", hour12: false});
  function element(tag, className, text) {
    const node = document.createElement(tag); node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function scheduleExpiry() {
    clearTimeout(expiryTimer);
    const remaining = states.filter(state => currentState(state).fresh).map(state => state.checkedAt + FRESH_MS - Date.now());
    if (remaining.length) expiryTimer = setTimeout(render, Math.max(1, Math.min(...remaining)));
  }
  function render() {
    const summary = summarize(states), cooling = Date.now() < retryAt;
    $("results-refresh").disabled = loading || cooling;
    $("results-refresh").textContent = loading ? "查询中…" : "刷新";
    $("auto-refresh").disabled = cooling;
    $("results").setAttribute("aria-busy", String(loading));
    $("result-summary").textContent = summary.free
      ? `${summary.free} 个空闲 · ${summary.available} 台可充${summary.unknown ? ` · ${summary.unknown} 台未知` : ""}`
      : summary.noVacancy ? `${summary.noVacancy} 台暂无空位${summary.unknown ? ` · ${summary.unknown} 台未知` : ""}`
        : loading ? "正在查询空位" : "当前状态未知";
    const expired = states.some(state => !state.error && !currentState(state).fresh);
    $("result-state").textContent = restriction || (loading ? "正在读取本次状态，已查到的结果会先显示。"
      : expired ? "部分结果已过期，请刷新确认。"
        : summary.unknown ? "部分设备尚未查清，未知不代表已占用。" : "已完成本次查询，空位可能随时变化。");
    $("result-state").className = `result-banner ${restriction || summary.unknown && !loading ? "result-warning" : "result-current"}`;
    $("result-updated").textContent = lastCompletedAt ? `本轮完成 ${timeText(lastCompletedAt)} · 单台结果超过 30 秒即过期`
      : "以各台充电桩的查询时间为准";
    $("auto-status").textContent = $("auto-refresh").checked
      ? document.hidden ? "自动刷新已暂停" : "页面可见时，每 30 秒刷新一轮" : "自动刷新已关闭";
    const sorted = summary.devices.map((device, index) => ({device, index}))
      .sort((a, b) => Number(Boolean(b.device.free.length)) - Number(Boolean(a.device.free.length)) || a.index - b.index);
    const groups = [];
    for (const {device} of sorted) {
      const group = element("section", "result-device"); group.append(element("h3", "result-device-name", device.name));
      if (device.free.length) {
        const ports = element("div", "free-ports");
        for (const number of device.free) ports.append(element("span", "port-state port-free", `${number} 号空闲`));
        group.append(ports);
      } else group.append(element("p", `device-status${device.fresh ? "" : " device-unknown"}`,
        device.fresh ? "暂无空闲插座" : `未知 · ${device.error}`));
      if (device.checkedAt !== null) group.append(element("p", "port-time", `查询于 ${timeText(device.checkedAt)}${device.fresh ? "" : " · 已过期"}`));
      if (device.fresh && device.ports) {
        const details = element("details", "ports-details"); details.append(element("summary", "", `全部 ${device.total} 个插座状态`));
        const list = element("ul", "port-results");
        device.ports.forEach((status, index) => {
          const row = element("li", "port-result"), style = {0: "free", 1: "occupied", "-1": "fault", "-2": "disabled"}[status];
          row.append(element("span", "port-number", `${index + 1} 号插座`), element("span", `port-state port-${style}`, STATUS_LABELS[status]));
          list.append(row);
        });
        details.append(list); group.append(details);
      }
      groups.push(group);
    }
    $("result-groups").replaceChildren(...groups); scheduleExpiry();
  }
  function scheduleAuto() {
    clearTimeout(autoTimer); autoTimer = null;
    if (!$("auto-refresh").checked || document.hidden || loading || retryAt > Date.now()) return;
    autoTimer = setTimeout(refresh, AUTO_MS);
  }
  async function refresh() {
    if (loading || Date.now() < retryAt || document.hidden) return;
    clearTimeout(autoTimer); clearTimeout(retryTimer); loading = true; restriction = ""; lastCompletedAt = null;
    await query.run(update => {
      states = update.states;
      if (update.blocked) {
        $("auto-refresh").checked = false; retryAt = update.retryAt;
        restriction = `${update.message}。${timeText(retryAt)} 后可手动刷新。`;
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => { restriction = "查询已暂停，可手动刷新重试。"; render(); }, Math.max(1, retryAt - Date.now()));
      }
      loading = !update.done;
      if (update.done) { hasResult = true; lastCompletedAt = Date.now(); }
      render(); if (update.done) scheduleAuto();
    });
  }
  function pause() {
    clearTimeout(autoTimer); autoTimer = null;
    if (loading) { query.cancel(); loading = false; states = states.map(state => state.error ? unknown(state, "查询已暂停，请刷新") : state); }
    render();
  }
  $("results-refresh").addEventListener("click", refresh);
  $("auto-refresh").addEventListener("change", () => {
    if ($("auto-refresh").checked && !loading && !document.hidden) refresh(); else scheduleAuto();
    render();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pause();
    else { render(); if (!hasResult || $("auto-refresh").checked) refresh(); }
  });
  window.addEventListener("pagehide", pause);
  window.addEventListener("pageshow", event => { if (event.persisted) { render(); if ($("auto-refresh").checked) refresh(); } });
  render(); if (!document.hidden) refresh();
})();
