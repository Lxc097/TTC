/* TTC 企业面试候选人端。只连接当前房间，不读取面试官场次列表。 */
(function () {
  'use strict';

  const app = document.getElementById('app');
  const state = {
    room: null,
    consent: null,
    ws: null,
    sessionId: null,
    interviewerOnline: false,
    transcript: [],
    sttEnabled: false,
    microphone: null,
    microphoneStream: null,
    microphoneTimer: null,
    microphoneGeneration: 0,
    cameraStream: null,
    frameTimer: null,
    clipRecorder: null,
    clipTimer: null,
    recordRequest: null,
    report: null,
    leaving: false,
    wakeLock: null,
  };

  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const text = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
  const PHONE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z"/></svg>';
  const show = (id, visible) => { const el = document.getElementById(id); if (el) el.classList.toggle('hidden', !visible); };
  const codeFromUrl = () => new URLSearchParams(location.search).get('room') || '';

  /* 设备识别：布局交给 CSS 媒体查询，这里只标记设备类型供运行期分支使用 */
  const MOBILE_MQ = window.matchMedia('(max-width: 760px)');
  const isMobile = () => MOBILE_MQ.matches;
  // 微信内置浏览器（X5 / WKWebView）基本拿不到摄像头，要提示用户换系统浏览器
  const IN_WECHAT = /MicroMessenger/i.test(navigator.userAgent || '');
  function syncDevice() {
    const touch = (navigator.maxTouchPoints || 0) > 0;
    document.documentElement.dataset.device = isMobile() ? 'mobile' : (touch ? 'tablet' : 'desktop');
  }
  syncDevice();
  if (MOBILE_MQ.addEventListener) MOBILE_MQ.addEventListener('change', syncDevice);
  else if (MOBILE_MQ.addListener) MOBILE_MQ.addListener(syncDevice);

  /* 手机软键盘：iOS 只缩可视视口、不触发 resize，用 --kb 把输入区顶上来 */
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const syncViewport = () => {
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty('--kb', Math.round(kb) + 'px');
    };
    vv.addEventListener('resize', syncViewport);
    vv.addEventListener('scroll', syncViewport);
    syncViewport();
  }
  const wsReady = () => state.ws && state.ws.readyState === WebSocket.OPEN;
  const send = (message) => { if (wsReady()) state.ws.send(JSON.stringify(message)); };
  const timeLabel = (seconds) => {
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    return String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0');
  };

  async function readError(response) {
    try {
      const body = await response.json();
      const detail = body.detail || body.error;
      if (typeof detail === 'string' && detail.length < 160) return detail;
    } catch (_) { /* HTML or an empty error body. */ }
    return response.status === 404 ? '房间不存在，请核对房间号。' : '房间服务暂不可用，请稍后重试。';
  }

  function stopMicrophone() {
    // Invalidate the active segment before stopping it. Its final blob is discarded.
    state.microphoneGeneration += 1;
    if (state.microphoneTimer) clearTimeout(state.microphoneTimer);
    state.microphoneTimer = null;
    const recorder = state.microphone;
    state.microphone = null;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    if (state.microphoneStream) state.microphoneStream.getTracks().forEach((track) => track.stop());
    state.microphoneStream = null;
    text('mic-status', '麦克风未开启；你仍可使用文字发送回答。');
    text('mic-button', '开启语音转写');
  }

  function stopCamera() {
    if (state.wakeLock) { try { state.wakeLock.release(); } catch (_) { /* 已释放 */ } state.wakeLock = null; }
    if (state.frameTimer) clearInterval(state.frameTimer);
    state.frameTimer = null;
    if (state.clipTimer) clearTimeout(state.clipTimer);
    state.clipTimer = null;
    if (state.clipRecorder && state.clipRecorder.state !== 'inactive') state.clipRecorder.stop();
    state.clipRecorder = null;
    if (state.cameraStream) state.cameraStream.getTracks().forEach((track) => track.stop());
    state.cameraStream = null;
    const video = document.getElementById('camera-preview');
    if (video) { video.srcObject = null; video.classList.remove('active'); }
    show('video-placeholder', true);
    text('camera-status', '摄像头未开启，不会发送画面。');
    text('camera-button', '开启摄像头');
  }

  function disconnect() {
    state.leaving = true;
    clearRotateHint();
    exitLandscape();
    sessionStorage.removeItem('ttc_rotate_skip');
    stopMicrophone();
    stopCamera();
    const socket = state.ws;
    state.ws = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  }

  function updateUrl(code) {
    const url = new URL(location.href);
    if (code) url.searchParams.set('room', code);
    else url.searchParams.delete('room');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }

  function renderJoin(message) {
    document.body.classList.remove('room-wide');
    clearRotateHint();
    app.innerHTML = '<div class="intro"><div class="intro-copy">'
      + '<span class="eyebrow">TTC · 正式面试</span><h1>认真对话，<br>也看见自己的进步。</h1>'
      + '<p class="lede">输入企业提供的六位房间号。面试结束后，这里会展示你的对话记录和基于实际回答的表达建议。</p>'
      + '<div class="intro-points"><div class="intro-point"><i>1</i><span>核对真实房间，查看岗位信息</span></div>'
      + '<div class="intro-point"><i>2</i><span>自己决定是否同意画面分析</span></div>'
      + '<div class="intro-point"><i>3</i><span>面试中可看纪要，结束后查看个人复盘</span></div></div></div>'
      + '<form id="join-form" class="card join-card"><h2>加入面试</h2><p>房间号由面试官提供；此页面不会创建模拟房间。</p>'
      + '<div class="field"><label for="room-code">六位房间号</label><input id="room-code" class="room-code" maxlength="6" autocomplete="off" spellcheck="false" inputmode="text" placeholder="例如 C7K2P9" required value="' + esc(codeFromUrl().toUpperCase().slice(0, 6)) + '"><span class="field-hint">不区分大小写，请勿输入其他人的房间号。</span></div>'
      + '<p id="join-error" class="inline-error' + (message ? '' : ' hidden') + '" role="alert">' + esc(message || '') + '</p>'
      + '<button id="join-button" type="submit" class="btn btn-primary btn-block">核对并继续</button></form></div>';
    document.getElementById('room-code').addEventListener('input', (event) => { event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); });
    document.getElementById('join-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const code = document.getElementById('room-code').value.trim().toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(code)) { text('join-error', '请输入六位字母或数字房间号。'); show('join-error', true); return; }
      const button = document.getElementById('join-button');
      button.disabled = true;
      button.textContent = '正在核对房间…';
      show('join-error', false);
      try {
        const response = await fetch('/api/rooms/' + encodeURIComponent(code), {cache:'no-store'});
        if (!response.ok) throw new Error(await readError(response));
        if (!(response.headers.get('content-type') || '').includes('application/json')) throw new Error('当前站点未连接房间服务。');
        const room = await response.json();
        if (!room || room.code !== code || !room.job_title) throw new Error('房间返回的数据不完整，请稍后重试。');
        state.room = room;
        state.consent = null;
        state.sessionId = null;
        state.interviewerOnline = false;
        state.transcript = [];
        state.recordRequest = null;
        state.report = null;
        updateUrl(code);
        if (room.status === 'ended' || room.status === 'closed') {
          await loadCandidateReport(code);
          return;
        }
        renderConsent();
      } catch (error) {
        text('join-error', error instanceof Error ? error.message : '无法核对房间。');
        show('join-error', true);
      } finally { button.disabled = false; button.textContent = '核对并继续'; }
    });
  }

  function renderConsent() {
    document.body.classList.remove('room-wide');
    clearRotateHint();
    const room = state.room;
    app.innerHTML = '<button class="back-link" id="back-join" type="button">← 返回输入房间号</button>'
      + '<div class="page-head"><span class="eyebrow">面试前确认</span><h1>这是你的面试空间</h1><p>请核对岗位和房间号，再决定是否授权画面分析。不同意也能通过文字或主动开启的语音转写参与。</p>'
      + '<div class="room-meta"><span class="pill orange">房间 ' + esc(room.code) + '</span><span class="pill">岗位 ' + esc(room.job_title) + '</span></div></div>'
      + '<div class="consent-grid"><section class="card section-card"><h2>画面分析由你决定</h2><p>授权后，只有你主动开启摄像头，才会发送画面供本场面试的信号分析。摄像头和麦克风都可随时停止。</p>'
      + '<label class="consent-choice"><input type="radio" name="consent" value="no"><strong>暂不同意画面分析</strong><span>不读取或发送视频；仍可参与文字对话与主动开启的语音转写。</span></label>'
      + '<label class="consent-choice"><input type="radio" name="consent" value="yes"><strong>同意本场画面分析</strong><span>开启摄像头后，你的画面会实时显示给面试官并用于本场信号分析；若需要录制核实片段，会再次询问你。</span></label>'
      + '<p id="consent-error" class="inline-error hidden" role="alert"></p><div class="consent-actions"><button class="btn btn-primary" id="enter-room" type="button">进入真实房间</button></div></section>'
      + '<aside class="card section-card"><h2>你可以控制什么</h2><div class="fact-list"><div><strong>对话纪要</strong><p>你发送的文字或主动开启语音转写得到的文本会进入本场纪要，双方可见。</p></div><div><strong>画面采集</strong><p>只在你同意并主动开启摄像头后发送；离开时立即停止本机媒体轨道。</p></div><div><strong>个人复盘</strong><p>面试官结束本场后展示，不产生录用建议、候选人分数或排名。</p></div></div><div class="notice">你主动开启摄像头后，画面会实时显示给面试官并用于本场信号分析；画面只走实时连接，不录制、不落盘。这里没有双向音视频通话。</div></aside></div>';
    document.getElementById('back-join').onclick = () => renderJoin();
    document.getElementById('enter-room').onclick = () => {
      const selected = document.querySelector('input[name="consent"]:checked');
      if (!selected) { text('consent-error', '请先明确选择是否同意画面分析。'); show('consent-error', true); return; }
      state.consent = selected.value === 'yes';
      renderRoom();
      connectRoom();
    };
  }

  function setConnection(message, kind) {
    text('connection-text', message);
    const dot = document.getElementById('connection-dot');
    if (dot) dot.className = 'connection-dot ' + (kind || '');
    show('reconnect-button', kind === 'off');
  }

  /* ---------- 面试间横屏：网页不能强制转屏，能做的只有「横屏布局 + 提示 + 尽力锁定」 ---------- */
  function clearRotateHint() {
    const hint = document.getElementById('rotateHint');
    if (hint) hint.remove();
  }

  async function requestLandscape() {
    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      }
    } catch (_) { /* 全屏被拒就继续试锁定 */ }
    try {
      if (screen.orientation && screen.orientation.lock) {
        await screen.orientation.lock('landscape');
        return true;
      }
    } catch (_) { /* iOS Safari 没有 lock，Android 非全屏也会失败 */ }
    return false;
  }

  function exitLandscape() {
    try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (_) {}
    try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen(); } catch (_) {}
  }

  function showRotateHint() {
    if (!isMobile() || !state.room) return;
    if (document.getElementById('rotateHint')) return;
    if (sessionStorage.getItem('ttc_rotate_skip') === '1') return;
    const hint = document.createElement('div');
    hint.className = 'rotate-hint';
    hint.id = 'rotateHint';
    hint.innerHTML = '<div class="rotate-card"><div class="rotate-icon"></div>'
      + '<b>把手机横过来</b>'
      + '<p>面试间按横屏设计：横过来能同时看到画面、纪要和回答框。旋转手机后这个提示会自动消失。</p>'
      + '<div class="rotate-actions"><button class="btn btn-primary" id="rotateFull" type="button">横屏全屏使用</button>'
      + '<button class="btn btn-quiet" id="rotateSkip" type="button">继续竖屏</button></div>'
      + '<p class="rotate-tip" id="rotateTip"></p></div>';
    document.body.appendChild(hint);
    document.getElementById('rotateSkip').onclick = () => {
      sessionStorage.setItem('ttc_rotate_skip', '1');
      hint.remove();
    };
    document.getElementById('rotateFull').onclick = async () => {
      const ok = await requestLandscape();
      if (!ok) text('rotateTip', '这个浏览器不支持自动横屏，请手动把手机转过来。');
    };
  }

  function renderRoom() {
    document.body.classList.add('room-wide');
    const room = state.room;
    app.innerHTML = '<div class="page-head"><span class="eyebrow">正在参加企业面试</span><h1>' + esc(room.job_title) + '</h1>'
      + '<div class="room-meta"><span class="pill orange">房间 ' + esc(room.code) + '</span><span id="peer-pill" class="pill">等待面试官连接</span><span class="pill">画面分析：' + (state.consent ? '已授权，摄像头仍需主动开启' : '未授权') + '</span></div>'
      + '<button id="leave-room" class="btn btn-danger btn-leave" type="button">' + PHONE_ICON + ' 离开面试</button></div>'
      + '<div class="connection-bar" role="status"><span id="connection-dot" class="connection-dot"></span><span id="connection-text">正在连接房间…</span><button id="reconnect-button" class="btn btn-quiet hidden" type="button">重连</button></div>'
      + (IN_WECHAT ? '<div class="notice">你是从微信里打开的：微信内置浏览器调不到摄像头和麦克风。点右上角「…」→「在浏览器打开」，再回来开摄像头。</div>' : '')
      + '<div class="room-layout"><div class="room-main"><section class="card video-card"><div class="video-stage"><video id="camera-preview" class="preview" autoplay muted playsinline aria-label="我的摄像头预览"></video><div id="video-placeholder" class="video-empty"><span>' + (state.consent ? '开启摄像头后，你的画面会显示在这里' : '你未授权画面分析，摄像头不可开启') + '</span><button id="camera-cta" class="btn btn-soft" type="button" ' + (state.consent ? '' : 'disabled') + '>' + (state.consent ? '开启摄像头' : '需要先授权画面') + '</button></div><span class="video-tag">我的画面</span></div></section>'
      + '<section class="card answer-bar"><form id="answer-form"><textarea id="answer-text" class="answer-box" maxlength="1000" placeholder="写下你的回答…" aria-label="回答内容"></textarea><button id="send-answer" type="submit" class="btn btn-primary">发送</button></form><p id="answer-status" class="device-status" role="status"></p></section></div>'
      + '<aside class="room-side"><section class="card section-card"><h2>我的设备</h2><p>设备不会自动开启。语音由后端转写；画面只在获得授权后传送。</p><div class="device-actions"><button id="mic-button" class="btn btn-quiet" type="button" disabled>检查语音转写…</button><button id="camera-button" class="btn btn-quiet" type="button" ' + (state.consent ? '' : 'disabled') + '>开启摄像头</button>' + (state.consent ? '' : '<button id="reconsent" class="btn btn-soft" type="button">重新选择画面授权</button>') + '</div><p id="mic-status" class="device-status">麦克风未开启。</p><p id="camera-status" class="device-status">' + (state.consent ? '摄像头未开启，不会发送画面。' : '你未授权画面分析，摄像头不可开启。') + '</p></section>'
      + '<section class="card section-card minutes-card"><h2>本场对话纪要</h2><p>来自双方真实发送的文字与语音转写。它不会替代视频通话。</p><div id="transcript-list" class="transcript-list" aria-live="polite"><p class="transcript-empty">还没有纪要。面试官连接后，你们可以开始对话。</p></div></section>'
      + '<section id="record-request" class="card section-card record-request hidden"><h3>本轮可录制核实片段</h3><p id="record-request-copy" class="muted"></p><button id="record-button" class="btn btn-soft" type="button">同意录制本段</button><button id="decline-record" class="btn btn-quiet" type="button">跳过</button><p id="record-status" class="device-status" role="status"></p></section>'
      + '<section class="card section-card"><h2>本场边界</h2><p>候选人离开只会关闭自己的连接，不会结束面试官的房间。面试官结束后，个人复盘才会出现。</p><div class="room-footer"><span>房间号 ' + esc(room.code) + '</span></div></section></aside></div>';
    document.getElementById('reconnect-button').onclick = connectRoom;
    document.getElementById('leave-room').onclick = () => { disconnect(); state.room = null; state.report = null; updateUrl(''); renderJoin(); };
    document.getElementById('answer-form').onsubmit = (event) => {
      event.preventDefault();
      const input = document.getElementById('answer-text');
      const answer = input.value.trim();
      if (!answer) { text('answer-status', '请先输入回答内容。'); return; }
      if (!wsReady()) { text('answer-status', '当前未连接房间；请重连后发送。'); return; }
      send({type:'turn_start'});
      send({type:'stt',text:answer,final:true});
      send({type:'turn_end',transcript:answer,beh:{}});
      input.value = '';
      text('answer-status', '已发送，双方纪要稍后同步。');
    };
    document.getElementById('mic-button').onclick = () => state.microphone ? stopMicrophone() : startMicrophone();
    document.getElementById('camera-button').onclick = () => state.cameraStream ? stopCamera() : startCamera();
    var ctaBtn = document.getElementById('camera-cta');
    if (ctaBtn) ctaBtn.onclick = () => state.cameraStream ? stopCamera() : startCamera();
    var reBtn = document.getElementById('reconsent');
    if (reBtn) reBtn.onclick = () => renderConsent();
    document.getElementById('record-button').onclick = recordClip;
    document.getElementById('decline-record').onclick = () => { state.recordRequest = null; show('record-request', false); };
    checkStt();
    showRotateHint();
  }

  async function checkStt() {
    try {
      const response = await fetch('/api/config', {cache:'no-store'});
      if (!response.ok) return;
      const config = await response.json();
      state.sttEnabled = config.stt_enabled === true;
    } catch (_) { state.sttEnabled = false; }
    const button = document.getElementById('mic-button');
    if (button) { button.disabled = !state.sttEnabled; button.textContent = state.sttEnabled ? '开启语音转写' : '语音转写暂不可用'; }
    if (!state.sttEnabled) text('mic-status', '后端未启用语音转写；请用文字发送回答。');
  }

  function addTranscript(item) {
    if (!item || typeof item.text !== 'string' || !item.text.trim() || item.final === false) return;
    const role = item.role === 'interviewer' ? 'interviewer' : 'candidate';
    const content = item.text.slice(0,1000);
    const timestamp = Number(item.t) || 0;
    const id = item.id || role + ':' + timestamp + ':' + content;
    if (state.transcript.some((row) => row.id === id)) return;
    state.transcript.push({id,role,text:content,t:timestamp});
    if (state.transcript.length > 120) state.transcript.shift();
    const list = document.getElementById('transcript-list');
    if (!list) return;
    list.innerHTML = state.transcript.map((row) => '<div class="transcript-item' + (row.role === 'candidate' ? ' mine' : '') + '"><strong>' + (row.role === 'candidate' ? '我' : '面试官') + ' · ' + timeLabel(row.t) + '</strong><p>' + esc(row.text) + '</p></div>').join('');
    list.scrollTop = list.scrollHeight;
  }

  function connectRoom() {
    if (!state.room || state.consent === null) return;
    if (state.ws && state.ws.readyState < WebSocket.CLOSING) state.ws.close();
    state.leaving = false;
    setConnection('正在连接房间…', '');
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = protocol + '//' + location.host + '/ws/room/' + encodeURIComponent(state.room.code) + '?role=candidate&consent=' + (state.consent ? '1' : '0');
    let socket;
    try { socket = new WebSocket(url); }
    catch (_) { setConnection('无法建立连接，请检查网络后重试。', 'off'); return; }
    state.ws = socket;
    socket.onopen = () => { if (state.ws === socket) setConnection('已接入房间，正在同步状态…', 'on'); };
    socket.onmessage = (event) => {
      if (state.ws !== socket) return;
      let message;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      if (message.type === 'hello_ack') {
        if (message.role !== 'candidate' || message.room?.code !== state.room.code) { socket.close(); setConnection('房间验证失败。', 'off'); return; }
        state.sessionId = message.session_id || null;
        state.interviewerOnline = Boolean(message.room.interviewer_online);
        text('peer-pill', state.interviewerOnline ? '面试官已连接' : '等待面试官连接');
        setConnection('已连接到真实面试房间', 'on');
      } else if (message.type === 'peer' && message.role === 'interviewer') {
        state.interviewerOnline = message.state === 'online';
        text('peer-pill', state.interviewerOnline ? '面试官已连接' : '等待面试官连接');
      } else if (message.type === 'candidate_snapshot') {
        if (typeof message.interviewer_online === 'boolean') {
          state.interviewerOnline = message.interviewer_online;
          text('peer-pill', state.interviewerOnline ? '面试官已连接' : '等待面试官连接');
        }
        if (Array.isArray(message.transcript)) message.transcript.forEach(addTranscript);
      } else if (message.type === 'transcript') {
        addTranscript(message);
      } else if (message.type === 'record_request' && state.consent) {
        state.recordRequest = message;
        const seconds = Math.max(15, Math.min(30, Number(message.seconds) || 20));
        text('record-request-copy', '服务器请求一段约 ' + seconds + ' 秒的画面核实。只有点击“同意录制本段”才会采集和发送；没有摄像头时可跳过。');
        text('record-status', '');
        show('record-request', true);
      } else if (message.type === 'report_ready') {
        state.report = message.report?.role === 'candidate' ? message.report : null;
        state.sessionId = message.session_id || state.sessionId;
        disconnect();
        if (state.report) renderReport(state.report);
        else loadCandidateReport(state.room.code);
      } else if (message.type === 'status' && message.reason) {
        text('answer-status', '服务提示：' + String(message.reason).slice(0,120));
      }
    };
    socket.onerror = () => { if (state.ws === socket) setConnection('房间连接异常，请稍后重连。', 'off'); };
    socket.onclose = () => {
      if (state.ws !== socket || state.leaving) return;
      stopMicrophone();
      stopCamera();
      setConnection('连接已断开。请检查网络并重连；未发送的文字仍在输入框中。', 'off');
    };
  }

  async function startMicrophone() {
    if (!state.sttEnabled || !wsReady()) { text('mic-status', '请先连接房间并确认后端已启用语音转写。'); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { text('mic-status', '当前浏览器不支持麦克风录制。'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});
      if (!wsReady()) { stream.getTracks().forEach((track) => track.stop()); return; }
      const mime = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus'].find((type) => MediaRecorder.isTypeSupported(type));
      if (!mime) { stream.getTracks().forEach((track) => track.stop()); text('mic-status', '浏览器没有可用的语音录制格式，请使用文字。'); return; }
      state.microphoneStream = stream;
      const generation = ++state.microphoneGeneration;
      recordMicrophoneSegment(stream,mime,generation);
      text('mic-status', '麦克风已开启；声音片段会发送至后端转写，双方可见文字。');
      text('mic-button','停止语音转写');
    } catch (_) { stopMicrophone(); text('mic-status', '无法使用麦克风。请检查浏览器权限，或改用文字。'); }
  }

  function recordMicrophoneSegment(stream,mime,generation) {
    if (generation !== state.microphoneGeneration || state.microphoneStream !== stream || !wsReady()) return;
    const recorder = new MediaRecorder(stream,{mimeType:mime});
    const chunks = [];
    state.microphone = recorder;
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onerror = () => {
      stopMicrophone();
      text('mic-status','麦克风录制中断，请改用文字。');
    };
    recorder.onstop = async () => {
      if (state.microphoneTimer) clearTimeout(state.microphoneTimer);
      state.microphoneTimer = null;
      if (state.microphone !== recorder || generation !== state.microphoneGeneration) return;
      state.microphone = null;
      if (chunks.length && wsReady()) {
        try {
          const dataUrl = await blobToDataUrl(new Blob(chunks,{type:mime.split(';')[0]}));
          if (generation !== state.microphoneGeneration || state.microphoneStream !== stream || !wsReady()) return;
          send({type:'audio_chunk',data:dataUrl.split(',')[1],ct:mime.split(';')[0]});
        } catch (_) { text('mic-status','语音片段发送失败，可改用文字。'); }
      }
      if (generation === state.microphoneGeneration && state.microphoneStream === stream && wsReady()) {
        try { recordMicrophoneSegment(stream,mime,generation); }
        catch (_) { stopMicrophone(); text('mic-status','无法继续录制语音片段，请改用文字。'); }
      }
    };
    recorder.start();
    state.microphoneTimer = setTimeout(() => {
      if (generation === state.microphoneGeneration && state.microphone === recorder && recorder.state === 'recording') recorder.stop();
    },1600);
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve,reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  /* 摄像头开工失败时给出能照着做的原因，别再只说"检查权限" */
  function cameraErrorText(err) {
    const name = err && err.name ? err.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return IN_WECHAT
        ? '微信内置浏览器拒绝了摄像头：点右上角「…」→「在浏览器打开」再试。'
        : '摄像头权限被拒绝。请在地址栏的网站设置里允许「相机」，iPhone 还要到 设置 → Safari → 相机 里放行，然后重试。';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return '没有找到可用的摄像头。';
    if (name === 'NotReadableError' || name === 'AbortError') return '摄像头被其他应用占用，先关掉相机/视频通话类应用再重试。';
    return '摄像头无法开启（' + (name || '未知错误') + '）。请检查权限，或改用系统浏览器打开。';
  }

  async function startCamera() {
    if (!state.consent) { text('camera-status', '你选择了不授权画面分析，摄像头打不开。点「重新选择画面授权」后可以改。'); return; }
    if (!wsReady()) { text('camera-status', '还没连上房间，等上方显示"已连接到真实面试房间"再开摄像头。'); return; }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      text('camera-status', IN_WECHAT
        ? '微信内置浏览器不能调用摄像头：点右上角「…」→「在浏览器打开」再试。'
        : '当前浏览器不支持摄像头（需要 https 地址，或在本机 localhost 打开）。');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({video:{width:{ideal:640},height:{ideal:480},frameRate:{ideal:5}},audio:false});
      if (!wsReady()) { stream.getTracks().forEach((track) => track.stop()); return; }
      state.cameraStream = stream;
      const video = document.getElementById('camera-preview');
      video.srcObject = stream;
      video.classList.add('active');
      show('video-placeholder', false);
      await video.play();
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 240;
      const context = canvas.getContext('2d');
      state.frameTimer = setInterval(() => {
        if (!wsReady() || !state.cameraStream || !context || video.readyState < 2) return;
        try {
          // 手机竖屏给的是纵向画面，直接拉伸会把人脸拉扁：按 cover 居中裁剪再画
          const vw = video.videoWidth || 320;
          const vh = video.videoHeight || 240;
          const scale = Math.max(320 / vw, 240 / vh);
          const sw = 320 / scale;
          const sh = 240 / scale;
          context.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, 320, 240);
          send({type:'frame',img:canvas.toDataURL('image/jpeg',.55)});
        } catch (_) { /* No invented frame on capture failure. */ }
      }, isMobile() ? 2600 : 2000);
      text('camera-status','摄像头已开启，画面按房间协议发送；你可随时停止。');
      text('camera-button','停止摄像头');
      // 一场面试几十分钟，手机上尽量别让屏幕自动熄灭
      try { if (navigator.wakeLock) state.wakeLock = await navigator.wakeLock.request('screen'); } catch (_) { state.wakeLock = null; }
    } catch (err) { stopCamera(); text('camera-status', cameraErrorText(err)); }
  }

  async function recordClip() {
    const request = state.recordRequest;
    if (!request || !state.consent || !wsReady()) return;
    if (!state.cameraStream) { text('record-status','请先开启摄像头，或选择跳过。'); return; }
    if (typeof MediaRecorder === 'undefined') { text('record-status','当前浏览器不支持片段录制，可选择跳过。'); return; }
    const mime = ['video/webm;codecs=vp8','video/webm','video/mp4'].find((type) => MediaRecorder.isTypeSupported(type));
    if (!mime) { text('record-status','当前浏览器不支持可发送的视频格式。'); return; }
    const seconds = Math.max(15,Math.min(30,Number(request.seconds) || 20));
    const chunks = [];
    let recorder;
    try { recorder = new MediaRecorder(state.cameraStream,{mimeType:mime,videoBitsPerSecond:800000}); }
    catch (_) { text('record-status','无法启动视频片段录制。'); return; }
    state.clipRecorder = recorder;
    document.getElementById('record-button').disabled = true;
    text('record-status','正在录制约 ' + seconds + ' 秒片段，离开或关闭摄像头会取消。');
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onerror = () => { text('record-status','片段录制失败，可选择跳过。'); };
    recorder.onstop = async () => {
      clearTimeout(state.clipTimer);
      state.clipTimer = null;
      if (state.clipRecorder !== recorder) return;
      state.clipRecorder = null;
      const button = document.getElementById('record-button');
      if (button) button.disabled = false;
      if (!wsReady() || !state.cameraStream || !chunks.length) { text('record-status','录制已取消或片段为空。'); return; }
      try {
        const dataUrl = await blobToDataUrl(new Blob(chunks,{type:mime.split(';')[0]}));
        if (!wsReady() || !state.cameraStream) return;
        send({type:'video_chunk',data:dataUrl.split(',')[1],ct:mime.split(';')[0]});
        state.recordRequest = null;
        show('record-request',false);
        text('camera-status','片段已发送核实；摄像头仍可随时停止。');
      } catch (_) { text('record-status','片段发送失败，可选择跳过。'); }
    };
    try {
      recorder.start();
      state.clipTimer = setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, seconds * 1000);
    } catch (_) {
      state.clipRecorder = null;
      document.getElementById('record-button').disabled = false;
      text('record-status','无法启动视频片段录制。');
    }
  }

  async function loadCandidateReport(code) {
    try {
      const response = await fetch('/api/rooms/' + encodeURIComponent(code) + '/candidate-report',{cache:'no-store'});
      if (!response.ok) throw new Error(await readError(response));
      const report = await response.json();
      if (report.role !== 'candidate') throw new Error('候选人报告尚未就绪。');
      state.report = report;
      renderReport(report);
    } catch (error) { renderJoin(error instanceof Error ? error.message : '候选人报告尚未就绪。'); }
  }

  function renderReport(report) {
    document.body.classList.remove('room-wide');
    clearRotateHint();
    const observations = Array.isArray(report.observations) ? report.observations : [];
    const transcript = Array.isArray(report.transcript) ? report.transcript : [];
    const summary = typeof report.summary === 'string' ? report.summary : '本场面试已结束。';
    app.innerHTML = '<div class="report-hero"><span class="eyebrow">只属于这场对话的复盘</span><h1>' + esc(report.title || '我的面试复盘') + '</h1><p>' + esc(summary) + '</p>'
      + '<div class="room-meta"><span class="pill orange">房间 ' + esc(state.room?.code || '') + '</span><span class="pill">对话 ' + esc(report.turns || 0) + ' 轮</span><span class="pill">时长 ' + timeLabel(report.duration) + '</span></div></div>'
      + '<div class="report-grid"><section class="card report-card"><h2>从回答里看见的改进点</h2>'
      + (observations.length ? observations.map((item) => '<div class="observation"><h3>' + esc(item.focus || '回答回看') + '</h3>' + (item.question ? '<small>对应提问：' + esc(item.question) + '</small>' : '') + (item.quote ? '<blockquote>“' + esc(item.quote) + '”</blockquote>' : '') + '<p>' + esc(item.suggestion || item.text || '') + '</p></div>').join('') : '<p class="empty-note">本场没有可核实的个人表达建议。可以查看对话纪要，选择一轮自己想重练的回答。</p>')
      + '</section><aside class="card report-card"><h2>本场对话纪要</h2><div class="report-transcript">'
      + (transcript.length ? transcript.map((item) => '<div><strong>' + (item.role === 'candidate' ? '我' : '面试官') + ' · ' + timeLabel(item.t) + '</strong><p>' + esc(item.text || '') + '</p></div>').join('') : '<p class="empty-note">本场没有可展示的纪要。</p>')
      + '</div></aside></div><p class="footnote">' + esc(report.disclaimer || '本报告不包含候选人评分或排名。') + '</p>'
      + '<div class="report-actions"><button id="copy-report" class="btn btn-primary" type="button">复制我的复盘</button><button id="report-home" class="btn btn-quiet" type="button">返回首页</button></div><p id="copy-status" class="device-status" role="status"></p>';
    document.getElementById('report-home').onclick = () => { state.room = null; state.report = null; updateUrl(''); renderJoin(); };
    document.getElementById('copy-report').onclick = async () => {
      const lines = [report.title || '我的面试复盘', summary, ...observations.map((item) => '回答：' + (item.quote || '') + '\n建议：' + (item.suggestion || item.text || '')), report.disclaimer || ''];
      try { await navigator.clipboard.writeText(lines.join('\n\n')); text('copy-status','复盘文字已复制。'); }
      catch (_) { text('copy-status','复制失败，请检查浏览器剪贴板权限。'); }
    };
  }

  window.addEventListener('beforeunload', disconnect);
  renderJoin();
})();
