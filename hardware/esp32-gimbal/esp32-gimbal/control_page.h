#pragma once

#include <Arduino.h>

static const char CONTROL_PAGE[] PROGMEM = R"HTML(<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#eef2f8">
<title>双轴云台</title>
<style>
  :root {
    color-scheme: light;
    --background: #eef2f8;
    --surface: #fff;
    --text: #182439;
    --muted: #526076;
    --line: #d6dfec;
    --primary: #2154bd;
    --soft: #eaf0fd;
    --success: #166246;
    --danger: #a52830;
    --track: #c3cde0;
  }
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    color: var(--text);
    background: var(--background);
    font: 1rem/1.55 Inter, system-ui, "Microsoft YaHei", sans-serif;
  }
  main {
    max-width: 34rem;
    margin: auto;
    padding:
      max(1.75rem, env(safe-area-inset-top))
      max(1rem, env(safe-area-inset-right))
      max(1.75rem, env(safe-area-inset-bottom))
      max(1rem, env(safe-area-inset-left));
  }
  header { margin-bottom: 1.25rem; }
  h1, h2, p { margin: 0; }
  h1 { font-size: clamp(1.75rem, 7vw, 2.25rem); line-height: 1.2; }
  h2 { font-size: 1rem; }
  .connection {
    display: inline-flex;
    margin-top: .625rem;
    align-items: center;
    gap: .5rem;
    color: var(--muted);
    font-size: .875rem;
  }
  .connection::before {
    content: "";
    width: .5rem;
    height: .5rem;
    border-radius: 50%;
    background: currentColor;
  }
  .connection[data-state="online"] { color: var(--success); }
  .connection[data-state="offline"] { color: var(--danger); }
  .card {
    margin-bottom: .75rem;
    padding: 1rem;
    border: 1px solid var(--line);
    border-radius: 1rem;
    background: var(--surface);
  }
  .row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: .125rem .5rem;
  }
  .hint, .scale { color: var(--muted); font-size: .875rem; }
  .hint { margin-top: .375rem; }
  .drive { font-size: .875rem; color: var(--muted); }
  .drive[data-enabled="true"] { color: var(--success); }
  .buttons {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: .5rem;
    margin-top: .875rem;
  }
  button {
    min-height: 3rem;
    padding: .5rem .625rem;
    border: 1px solid var(--primary);
    border-radius: .625rem;
    color: var(--primary);
    background: var(--soft);
    font: inherit;
    font-weight: 650;
    cursor: pointer;
  }
  .enable { color: var(--surface); background: var(--primary); }
  .release { color: var(--danger); border-color: var(--danger); background: var(--surface); }
  button:active:not(:disabled) { filter: brightness(.88); }
  button:disabled {
    border-color: var(--line);
    background: var(--background);
    color: var(--muted);
    cursor: default;
  }
  :focus-visible { outline: 2px solid var(--primary); outline-offset: 3px; }
  .axis { padding: .875rem 0; }
  .axis + .axis { border-top: 1px solid var(--line); }
  label { font-weight: 650; }
  output {
    color: var(--primary);
    font-variant-numeric: tabular-nums;
    font-weight: 650;
  }
  input[type="range"] {
    appearance: none;
    -webkit-appearance: none;
    display: block;
    width: 100%;
    height: 3rem;
    margin: 0;
    border-radius: .375rem;
    background: transparent;
  }
  input[type="range"]::-webkit-slider-runnable-track {
    height: .375rem;
    border-radius: .25rem;
    background: var(--track);
  }
  input[type="range"]::-moz-range-track {
    height: .375rem;
    border-radius: .25rem;
    background: var(--track);
  }
  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 1.625rem;
    height: 1.625rem;
    margin-top: -.625rem;
    border: .1875rem solid var(--surface);
    border-radius: 50%;
    background: var(--primary);
    box-shadow: 0 0 0 1px var(--primary);
  }
  input[type="range"]::-moz-range-thumb {
    width: 1.25rem;
    height: 1.25rem;
    border: .1875rem solid var(--surface);
    border-radius: 50%;
    background: var(--primary);
    box-shadow: 0 0 0 1px var(--primary);
  }
  input[type="range"]:disabled { opacity: .55; }
  .scale { display: flex; justify-content: space-between; gap: .375rem; }
  .center { width: 100%; }
  .error { margin: .75rem .25rem 0; color: var(--danger); font-size: .875rem; }
</style>
</head>
<body>
<main>
  <header>
    <h1>双轴云台</h1>
    <div class="connection" id="connection" role="status">正在连接 ESP32</div>
  </header>
  <section class="card" aria-labelledby="drive-title">
    <div class="row">
      <h2 id="drive-title">舵机输出</h2>
      <span class="drive" id="drive" role="status">正在读取</span>
    </div>
    <p id="release-hint" class="hint">启用时舵机转到中位。关闭输出前请托住云台，舵机可能失去保持力。</p>
    <div class="buttons">
      <button class="enable" id="enable" type="button" disabled>启用舵机</button>
      <button class="release" id="disable" type="button" aria-describedby="release-hint" disabled>关闭输出</button>
    </div>
  </section>
  <section class="card" aria-labelledby="axes-title">
    <h2 id="axes-title">目标位置</h2>
    <p id="range-hint" class="hint">百分比表示相对于中位的设定行程。</p>
    <div class="axis">
      <div class="row">
        <label for="pan">水平</label>
        <output id="pan-value" for="pan" aria-live="off">—</output>
      </div>
      <input id="pan" type="range" min="-100" max="100" value="0" aria-describedby="range-hint" disabled>
      <div class="scale" aria-hidden="true"><span>-100%</span><span>中位</span><span>+100%</span></div>
    </div>
    <div class="axis">
      <div class="row">
        <label for="tilt">俯仰</label>
        <output id="tilt-value" for="tilt" aria-live="off">—</output>
      </div>
      <input id="tilt" type="range" min="-100" max="100" value="0" aria-describedby="range-hint" disabled>
      <div class="scale" aria-hidden="true"><span>-100%</span><span>中位</span><span>+100%</span></div>
    </div>
    <button class="center" id="center" type="button" disabled>两轴回中</button>
  </section>
  <p class="error" id="error" role="status"></p>
  <noscript><p>请启用浏览器的 JavaScript。</p></noscript>
</main>
<script>
  const axes = ['pan', 'tilt'];
  const elements = Object.fromEntries(
    ['connection', 'drive', 'enable', 'disable', 'center', 'error', 'pan', 'tilt', 'pan-value', 'tilt-value']
      .map(id => [id, document.getElementById(id)])
  );
  const actionText = { enable: '正在启用', disable: '正在关闭', center: '正在回中' };
  let connection = 'connecting';
  let board = null;
  let queuedPosition = null;
  let action = null;
  let request = null;
  let positionTimer = 0;
  let nextPositionAt = 0;
  let issue = '';

  function updateText(element, text) {
    if (element.textContent !== text) element.textContent = text;
  }

  function render() {
    const enabled = board?.enabled === true;
    const available = board?.available === true;
    const connectionLabel = {
      connecting: '正在连接 ESP32',
      online: '已连接 ESP32',
      offline: '连接已断开'
    }[connection];
    elements.connection.dataset.state = connection;
    updateText(elements.connection, connectionLabel);
    elements.drive.dataset.enabled = String(enabled);
    let driveLabel = '状态未知';
    if (board) driveLabel = available ? (enabled ? '已启用' : '已关闭') : '输出不可用';
    if (action) driveLabel = actionText[action];
    updateText(elements.drive, driveLabel);
    elements.enable.disabled = !available || enabled || !!action;
    elements.disable.disabled = !available || !enabled || !!action;
    elements.center.disabled = !available || !enabled || !!action;
    updateText(elements.error, issue);

    const target = connection === 'online' ? queuedPosition ?? request?.position ?? board : null;
    for (const axis of axes) {
      const input = elements[axis];
      input.disabled = !available || !enabled || !!action;
      if (target) input.value = target[axis];
      const percent = Number(input.value);
      const text = percent === 0 ? '0%' : (percent > 0 ? '+' : '') + percent + '%';
      input.setAttribute('aria-valuetext', percent === 0 ? '中位' : text);
      elements[axis + '-value'].textContent = target ? text : '—';
    }
  }

  function discardPosition() {
    queuedPosition = null;
    clearTimeout(positionTimer);
    positionTimer = 0;
  }

  function markOffline() {
    discardPosition();
    action = null;
    board = null;
    connection = 'offline';
    issue = '请确认手机仍连接着 ESP32 的 Wi-Fi 热点。';
    render();
  }

  async function send(endpoint, position = null) {
    const controller = new AbortController();
    request = { controller, position };
    const timeout = setTimeout(() => controller.abort(), 2500);
    const options = { cache: 'no-store', signal: controller.signal };
    if (endpoint !== 'state') {
      options.method = 'POST';
      options.headers = { 'X-Gimbal-Control': '1' };
      if (position) options.body = new URLSearchParams(position);
    }

    try {
      const response = await fetch('/api/' + endpoint, options);
      const data = await response.json();
      if (controller.signal.aborted) {
        markOffline();
        return;
      }
      const wasOnline = connection === 'online';
      connection = 'online';
      if (!response.ok) {
        discardPosition();
        board = null;
        issue = typeof data?.error === 'string' ? data.error : '操作未完成，请重试。';
        return;
      }
      if (typeof data?.enabled !== 'boolean' || typeof data.available !== 'boolean' ||
          axes.some(axis => !Number.isInteger(data[axis]) || Math.abs(data[axis]) > 100)) {
        throw new Error('Invalid device state');
      }
      board = data;
      if (!board.available || !board.enabled) discardPosition();
      if (endpoint !== 'state' || !wasOnline) issue = '';
    } catch {
      markOffline();
    } finally {
      clearTimeout(timeout);
      request = null;
      if (endpoint === action) action = null;
      render();
      pump();
    }
  }

  function pump() {
    if (request || connection !== 'online') return;
    if (action) {
      send(action);
      return;
    }
    if (!queuedPosition || positionTimer) return;
    const delay = nextPositionAt - performance.now();
    if (delay > 0) {
      positionTimer = setTimeout(() => {
        positionTimer = 0;
        pump();
      }, delay);
      return;
    }
    const position = queuedPosition;
    queuedPosition = null;
    nextPositionAt = performance.now() + 100;
    send('position', position);
  }

  function syncState() {
    if (!document.hidden && !request && !queuedPosition && !action) send('state');
  }

  for (const axis of axes) {
    elements[axis].addEventListener('input', () => {
      if (elements[axis].disabled) return;
      queuedPosition = { pan: Number(elements.pan.value), tilt: Number(elements.tilt.value) };
      render();
      pump();
    });
  }
  for (const command of ['enable', 'disable', 'center']) {
    elements[command].addEventListener('click', () => {
      if (elements[command].disabled) return;
      discardPosition();
      action = command;
      render();
      pump();
    });
  }
  window.addEventListener('offline', () => {
    request?.controller.abort();
    markOffline();
  });
  window.addEventListener('online', syncState);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      discardPosition();
      render();
    } else {
      syncState();
    }
  });
  setInterval(syncState, 1500);
  syncState();
</script>
</body>
</html>
)HTML";
