/* =========================================================
   corgi 面试前端 - app
   hash router, vanilla JS, zero deps
   ========================================================= */
'use strict';

/* ---------- utilities ---------- */
const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtTs = (sec) => {
  sec = Math.max(0, Math.floor(sec));
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return m + ':' + s;
};
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} }
};
const timers = [];
function later(fn, ms) { const id = setTimeout(fn, ms); timers.push(id); return id; }
function every(fn, ms) { const id = setInterval(fn, ms); timers.push(id); return id; }
function clearTimers() { timers.forEach(t => { clearTimeout(t); clearInterval(t); }); timers.length = 0; }

function toast(msg) {
  const old = $('.toast'); if (old) old.remove();
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = msg;
  document.body.appendChild(el);
  later(() => el.remove(), 2200);
}

/* ---------- icons (inline svg) ---------- */
const I = {};
const svg = (p) => '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
I.dog = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 5.2A3 3 0 1 0 5 6"/><path d="M14 5.2A3 3 0 1 1 19 6"/><path d="M12 9.5c4 0 7 2.4 7 5.5-1.5 1.7-4.2 2.5-7 2.5s-5.5-.8-7-2.5c0-3.1 3-5.5 7-5.5Z"/><path d="M9 13h.01M15 13h.01"/><path d="M12 15c-1 0-1.6.6-1.8 1.4 0 0 1 .5 1.8.5s1.8-.5 1.8-.5c-.2-.8-.8-1.4-1.8-1.4Z"/></svg>';
I.brief = svg('<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>');
I.user = svg('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>');
I.mic = svg('<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>');
I.micOff = svg('<path d="M9 9v1a3 3 0 0 0 4.6 2.6M15 11V6a3 3 0 0 0-5.5-1.6"/><path d="M5 11a7 7 0 0 0 10.6 5.9M12 18v3M3 3l18 18"/>');
I.video = svg('<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m22 8-6 4 6 4V8Z"/>');
I.videoOff = svg('<path d="M2 6h9M6 6l3-1M2 18h5M16 6v12a2 2 0 0 1-2 2H6M22 8l-6 4 6 4V8ZM3 3l18 18"/>');
I.phone = svg('<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z"/>');
I.link = svg('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>');
I.copy = svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>');
I.arrow = svg('<path d="M5 12h14M13 6l6 6-6 6"/>');
I.check = svg('<path d="M20 6 9 17l-5-5"/>');
I.x = svg('<path d="M18 6 6 18M6 6l12 12"/>');
I.spark = svg('<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>');
I.eye = svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>');
I.lock = svg('<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>');
I.hist = svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 3"/>');
I.clock = svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>');
I.chev = svg('<path d="m9 18 6-6-6-6"/>');
I.play = svg('<path d="m8 5 11 7-11 7V5Z"/>');
I.bulb = svg('<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-4 10.5c.8.7 1 1.6 1 2.5h6c0-.9.2-1.8 1-2.5A6 6 0 0 0 12 3Z"/>');
I.timer = svg('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/>');

function corgiBrand() {
  return '<a class="brand" href="#/">' + I.dog + '<span>corgi</span></a>';
}

function navHtml(active) {
  const role = getRole();
  const right = role
    ? '<button class="btn btn-ghost btn-sm" id="switchRole">切换身份</button>'
    : '';
  const links = [
    ['#/candidate', '面试者', active === 'candidate'],
    ['#/interviewer', '面试官', active === 'interviewer'],
    ['#/interviewer/analysis', '面试者分析', active === 'analysis']
  ];
  return '<div class="nav"><div class="wrap nav-in">' + corgiBrand() +
    '<nav class="nav-links">' + links.map(l => '<a class="' + (l[2] ? 'active' : '') + '" href="' + l[0] + '">' + l[1] + '</a>').join('') + '</nav>' +
    '<div class="nav-right">' + right + '</div></div></div>';
}

/* ---------- identity ---------- */
function getRole() { return LS.get('corgi_role', null); }
function setRole(r) { LS.set('corgi_role', r); }

/* ---------- sessions (mock store) ---------- */
const SEED_SESSIONS = [
  { id: 'S24111301', role: 'interviewer', title: '前端工程师', date: '2026-11-10 15:40', duration: '27:32', followUps: 3, adoptRate: 0.67, deleted: false },
  { id: 'S24111202', role: 'interviewer', title: '产品经理', date: '2026-11-08 10:15', duration: '22:05', followUps: 3, adoptRate: 0.33, deleted: false },
  { id: 'S24110503', role: 'candidate', title: '模拟面试 · 后端工程师', date: '2026-11-05 20:02', duration: '18:44', followUps: 3, adoptRate: 1.0, deleted: false },
  { id: 'S24103104', role: 'interviewer', title: '算法工程师', date: '2026-10-31 14:22', duration: '31:10', followUps: 3, adoptRate: 0.67, deleted: true }
];
function getSessions() {
  let s = LS.get('corgi_sessions', null);
  if (!s) { s = SEED_SESSIONS; LS.set('corgi_sessions', s); }
  return s;
}
function saveSession(x) {
  const s = getSessions(); s.unshift(x); LS.set('corgi_sessions', s); return x;
}
function getSession(id) { return getSessions().find(s => s.id === id) || null; }
function markDeleted(id) {
  const s = getSessions().map(x => x.id === id ? Object.assign({}, x, { deleted: true }) : x);
  LS.set('corgi_sessions', s);
  return getSession(id);
}

/* ---------- report content (deterministic by id) ---------- */
function hashInt(str) { let h = 0; for (let i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) >>> 0; } return h; }
const POINT_SETS = [
  [
    { t: '04:12', line: '追问候选人经历中“从 0 到 1”的真实角色', ev: '候选人表述“我们做了X系统”时，人称一直是“我们”，未说明个人贡献边界，追问后确认其只负责联调与部分接口，并非主导。' },
    { t: '11:38', line: '追问“QPS 从 800 到 12000”这一量级是怎么验证的', ev: '候选人给出优化倍数与压测数字，但无法复述压测模型与误差范围，数字口径前后不一致。' },
    { t: '19:24', line: '追问冲突案例中候选人的具体动作与结果', ev: '候选人两次用“团队一起解决”收尾，第二次追问后给出一项可复核的排期动作，可信度中等。' }
  ],
  [
    { t: '03:45', line: '追问“北极星指标”与业务目标的对应关系', ev: '候选人对指标定义清晰，但被问到“如何拆分到季度”时停顿 6 秒并回避具体数字。' },
    { t: '12:02', line: '追问一次失败实验结果的处理方式', ev: '候选人只讲“复盘”不讲改动作，追问“实验下线后做了什么”后给出改判据重跑，证据具体。' },
    { t: '21:47', line: '追问跨部门推进时的真实卡点', ev: '候选人描述顺畅，追问“谁投了反对票、你如何回应”后承认存在资源冲突未解决。' }
  ],
  [
    { t: '05:20', line: '追问性能问题定位与其本人贡献', ev: '候选人先答“我们调优了慢查询”，追问后确认其本人独立完成索引分析，证据为一张执行计划截图。' },
    { t: '13:11', line: '追问简历中“日均百万请求”的口径', ev: '追问峰值口径后，候选人口述 95 分位与均值，数字一致，可信。' },
    { t: '26:03', line: '追问离职原因与期望的过渡安排', ev: '候选人回答模糊，追问“上一个团队最不可接受的决策”后情绪明显波动，信号强。' }
  ]
];
function reportData(id, role) {
  const h = hashInt(String(id));
  const set = POINT_SETS[h % POINT_SETS.length];
  const s = getSession(id) || { title: '前端工程师', duration: '24:18', adoptRate: 0.67 };
  return {
    conclusion: (role === 'candidate'
      ? '整体表达自然，项目叙述偏“团队化”，需练习把个人贡献拆到具体动作与证据。'
      : '候选人对业务有整体感，但在功劳归属与关键数字口径上偏差明显，需重点核验。'),
    points: set,
    adoptRate: s.adoptRate,
    duration: s.duration,
    title: s.title,
    date: s.date,
    deleted: !!s.deleted
  };
}

/* ---------- router ---------- */
const routes = {};
function render() {
  clearTimers();
  const segs = (location.hash || '#/').replace(/^#\/?/, '').split('/').filter(Boolean);
  let hit = null;
  for (const [pattern, d] of Object.entries(routes)) {
    const names = pattern.replace(/^\//, '').split('/').filter(Boolean);
    if (names.length !== segs.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < names.length; i++) {
      const n = names[i];
      if (n.startsWith(':')) params[n.slice(1)] = decodeURIComponent(segs[i] || '');
      else if (n !== segs[i]) { ok = false; break; }
    }
    if (ok) { hit = { d, params }; break; }
  }
  const key = hit ? hit.d.key : '404';
  document.body.setAttribute('data-page', key);
  $('#app').innerHTML = hit ? hit.d.render(hit.params) : page404();
  window.scrollTo(0, 0);
  if (hit && hit.d.mount) hit.d.mount(hit.params);
}


/* =========================================================
   pages: home / candidate / practice / interviewer home
   ========================================================= */

/* ---------- home ---------- */
routes['/'] = {
  key: 'home',
  render() {
    return navHtml('home') +
      '<div class="hero-fancy hero-fixed">' +
      '<img class="hs-sky" src="images/hero-cloud-sky.webp" alt="">' +
      '<img class="hs-corgi" src="images/hero-corgi.avif" alt="Corgi mascot">' +
      '<img class="hs-hand" src="images/hero-hand.avif" alt="">' +
      '<div class="hero-fancy-bg"></div>' +
      '<div class="wrap hero-center fade-in"><section class="hero">' +
      '<span class="eyebrow">' + I.dog + ' AI 面试搭档</span>' +
      '<h1>一场面试，<span class="accent">两种视角</span>。<br>机器看信号，你来看人。</h1>' +
      '<p class="lead">候选人只看到一场普通的视频面试。面试官看到实时信号带与追问点提示卡。</p>' +
      '<div class="hero-actions">' +
      '<a class="btn btn-primary btn-lg" href="#/interviewer">' + I.brief + ' 我是面试官</a>' +
      '<a class="btn btn-outline btn-lg" href="#/candidate">' + I.user + ' 我是面试者</a>' +
      '</div>' +
      '</section></div>' +
      '</div>';
  },
  mount() {
    const sw = $('#switchRole'); if (sw) sw.addEventListener('click', () => { LS.del('corgi_role'); location.hash = '#/'; render(); });
  }
};
/* ---------- candidate home ---------- */
routes['/candidate'] = {
  key: 'candidate',
  render() {
    return navHtml('candidate') +
      '<main class="wrap page page-narrow fade-in">' +
      '<h1 style="font-size:34px;">面试者</h1>' +
      '<p class="panel-sub" style="margin-top:6px;">加入面试官发起的真实面试，或开始一场 AI 模拟面试。</p>' +
      '<div class="card card-pad mt-24">' +
      '<div class="panel-title">加入面试</div>' +
      '<div class="panel-sub mt-8">输入面试官发给你的 6 位房间号。</div>' +
      '<div class="mt-16"><label class="field-label" for="roomInput">房间号</label>' +
      '<input id="roomInput" class="input-lg" maxlength="6" placeholder="例如 C7K2P9" autocomplete="off" spellcheck="false">' +
      '<div class="form-error" id="roomErr"></div></div>' +
      '<button class="btn btn-primary btn-lg" id="joinBtn" style="width:100%;">' + I.arrow + ' 加入房间</button>' +
      '</div>' +
      '<div class="card card-pad mt-16">' +
      '<div class="row-between"><div><div class="panel-title">模拟面试</div>' +
      '<div class="panel-sub mt-8">AI 语音提问 + 字幕，支持打断，每轮给出建议与亮点。</div></div>' +
      '<button class="btn btn-ink" id="practiceBtn">开始模拟面试</button></div>' +
      '</div>' +
      '</main>' + footerHtml();
  },
  mount() {
    const input = $('#roomInput');
    const err = $('#roomErr');
    const join = () => {
      const v = (input.value || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(v)) { err.textContent = '房间号无效：请输入 6 位字母或数字。'; return; }
      err.textContent = '';
      location.hash = '#/candidate/room/' + v;
    };
    $('#joinBtn').addEventListener('click', join);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') join(); });
    $('#practiceBtn').addEventListener('click', () => { location.hash = '#/candidate/practice'; });
    const sw = $('#switchRole'); if (sw) sw.addEventListener('click', () => { LS.del('corgi_role'); location.hash = '#/'; render(); });
  }
};

/* ---------- candidate real interview ---------- */
routes['/candidate/room/:id'] = {
  key: 'candidateRoom',
  render(p) {
    return navHtml('candidate') +
      '<main class="wrap page page-narrow fade-in">' +
      '<div class="row-between"><div><h1 style="font-size:28px;">面试间</h1>' +
      '<p class="panel-sub mt-8">房间 ' + esc(p.id) + '</p></div><span class="chip peach">候选人视角 · 普通视频面试</span></div>' +
      '<div class="card card-pad mt-24" id="scene"></div>' +
      '</main>' + footerHtml();
  },
  mount(p) {
    const scene = $('#scene');
    const audioOnly = false;
    showConsent(scene, p.id, audioOnly);
    const sw = $('#switchRole'); if (sw) sw.addEventListener('click', () => { LS.del('corgi_role'); location.hash = '#/'; render(); });
  }
};

function showConsent(scene, roomId, audioOnly) {
  scene.innerHTML =
    '<div class="stack">' +
    '<div class="panel-title">开始前，先征得你的同意</div>' +
    '<div class="panel-sub">这是真实面试。我们会使用你的摄像头、麦克风与屏幕信号。</div>' +
    '<div class="consent-list">' +
    '<div class="consent-item"><span class="ico">' + I.video + '</span><div><b>采集什么</b><span>视频画面、声音、屏幕共享与设备信号，仅在本场面试期间。</span></div></div>' +
    '<div class="consent-item"><span class="ico">' + I.spark + '</span><div><b>用来做什么</b><span>生成实时字幕、工时记录与面试报告，仅提供给本场面试双方。</span></div></div>' +
    '<div class="consent-item"><span class="ico">' + I.lock + '</span><div><b>随时可停</b><span>你可以在任意时刻点击“结束”退出，数据可申请删除。</span></div></div>' +
    '</div>' +
    '<div class="row" style="justify-content:flex-end;flex-wrap:wrap;">' +
    '<button class="btn btn-ghost" id="voiceOnlyBtn">' + I.mic + ' 只用语音</button>' +
    '<button class="btn btn-ink" id="agreeBtn">' + I.check + ' 同意并继续</button>' +
    '</div></div>';
  $('#agreeBtn').addEventListener('click', () => LS.set('corgi_consent', true) && showDeviceCheck(scene, roomId, false));
  $('#voiceOnlyBtn').addEventListener('click', () => showDeviceCheck(scene, roomId, true));
}

function showDeviceCheck(scene, roomId, audioOnly) {
  const checks = [
    { lab: '人脸检测', ok: !audioOnly, val: audioOnly ? '语音模式' : '已就位' },
    { lab: '光照', ok: true, val: '良好' },
    { lab: '信号质量', ok: true, val: '强' }
  ];
  scene.innerHTML =
    '<div class="stack">' +
    '<div class="panel-title">设备自检</div>' +
    '<div class="panel-sub">' + (audioOnly ? '语音模式：只使用麦克风，不打开摄像头。' : '确认画面、光照与网络后再进入。') + '</div>' +
    '<div class="check-row mt-16">' + checks.map(c =>
      '<div class="check-item"><div class="dot ' + (c.ok ? 'ok' : 'warn') + '"></div><div class="val">' + c.val + '</div><div class="lab">' + c.lab + '</div></div>').join('') + '</div>' +
    '<div class="row" style="justify-content:flex-end;">' +
    '<button class="btn btn-ghost" id="backConsent">上一步</button>' +
    '<button class="btn btn-primary" id="enterBtn">' + I.video + ' 进入面试</button>' +
    '</div></div>';
  $('#backConsent').addEventListener('click', () => showConsent(scene, roomId, audioOnly));
  $('#enterBtn').addEventListener('click', () => showCandidateLive(scene, audioOnly));
}

function showCandidateLive(scene, audioOnly) {
  let muted = false, camOff = audioOnly;
  let sec = 0;
  const intercom = ['面试官已进入面试间。', '面试官：先请你做 2 分钟自我介绍。', '面试官：可以讲一个你最有代表性的项目。'];
  let capi = 1;
  scene.innerHTML =
    '<div class="stage">' +
    '<div class="vid-fill"><div><div class="avatar">吴</div><div class="place-name">面试官 · 吴</div></div></div>' +
    '<div class="status-float"><span class="pulse"></span><span id="statusTxt">等待面试官进入…</span></div>' +
    '<div class="pip" id="pip">' + (camOff ? '<div class="place-name" style="margin:0;">摄像头已关</div>' : '<div class="avatar">我</div>') + '</div>' +
    '</div>' +
    '<div class="caption-bar mt-16"><span class="who">字幕</span><span id="capTxt">正在等待面试官…</span></div>' +
    '<div class="controls">' +
    '<div class="ctl-col"><button class="ctl ' + (muted ? 'off' : '') + '" id="muteBtn">' + (muted ? I.micOff : I.mic) + '</button><span class="tiny muted">' + (muted ? '已静音' : '静音') + '</span></div>' +
    '<div class="ctl-col"><button class="ctl ' + (camOff ? 'off' : '') + '" id="camBtn">' + (camOff ? I.videoOff : I.video) + '</button><span class="tiny muted">' + (camOff ? '已关' : '摄像头') + '</span></div>' +
    '<div class="ctl-col"><button class="ctl end" id="endBtn">' + I.phone + ' 结束</button></div>' +
    '</div>' +
    '<p class="tiny muted" style="text-align:center;margin-top:10px;">本场只见普通视频面试：没有信号带，也没有提示卡。</p>';

  later(() => { $('#statusTxt').textContent = '面试进行中'; }, 3000);
  every(() => { $('#capTxt').textContent = intercom[capi % intercom.length]; capi++; }, 7000);

  $('#muteBtn').addEventListener('click', () => {
    muted = !muted;
    const b = $('#muteBtn'); b.classList.toggle('off', muted); b.innerHTML = muted ? I.micOff : I.mic;
    b.nextElementSibling.textContent = muted ? '已静音' : '静音';
  });
  $('#camBtn').addEventListener('click', () => {
    camOff = !camOff;
    const b = $('#camBtn'); b.classList.toggle('off', camOff); b.innerHTML = camOff ? I.videoOff : I.video;
    b.nextElementSibling.textContent = camOff ? '已关' : '摄像头';
    $('#pip').innerHTML = camOff ? '<div class="place-name" style="margin:0;">摄像头已关</div>' : '<div class="avatar">我</div>';
  });
  $('#endBtn').addEventListener('click', () => {
    saveSession({ id: 'C' + Date.now().toString().slice(-8), role: 'candidate', title: '真实面试 · 前端工程师', date: nowStr(), duration: fmtTs(sec), followUps: 3, adoptRate: 0.67, deleted: false });
    location.hash = '#/candidate';
  });
}

/* ---------- practice ---------- */
const PRACTICE = [
  { q: '请做一个两分钟的中文自我介绍。', tip: '建议：给出一条“结果 + 数字”的证据，而不是罗列职责。', hi: '亮点：开场直接定位目标岗位，结构清晰。' },
  { q: '讲一个你从 0 到 1 主导的项目，你具体做了什么？', tip: '建议：把“我们团队”换成“我负责”，说清个人贡献边界。', hi: '亮点：主动补充了上线后的数据与复盘。' },
  { q: '遇到跨部门冲突时，你是怎么处理的？', tip: '建议：补充冲突结果与你的具体动作，少用“一起解决”。', hi: '亮点：能分辨事实与情绪，语气自然。' }
];

routes['/candidate/practice'] = {
  key: 'practice',
  render() {
    return navHtml('candidate') +
      '<main class="wrap page page-narrow fade-in">' +
      '<div class="row-between"><div><h1 style="font-size:28px;">AI 模拟面试</h1>' +
      '<p class="panel-sub mt-8">AI 语音提问，带字幕，随时打断。共 ' + PRACTICE.length + ' 轮。</p></div>' +
      '<span class="chip peach">模拟 · 不保存为真实面试</span></div>' +
      '<div class="card card-pad mt-24" id="practiceScene"></div>' +
      '</main>' + footerHtml();
  },
  mount() {
    const scene = $('#practiceScene');
    startPractice(scene, 0);
    const sw = $('#switchRole'); if (sw) sw.addEventListener('click', () => { LS.del('corgi_role'); location.hash = '#/'; render(); });
  }
};

function startPractice(scene, round) {
  let speaking = true, idx = 0, tween = null;
  const question = PRACTICE[round].q;
  const draw = () => {
    if (speaking) {
      $('#capTxt').textContent = question.slice(0, idx);
      if (idx <= question.length) { idx++; tween = later(draw, 45); }
      else speaking = false;
    }
  };
  scene.innerHTML =
    '<div class="round-track">' + PRACTICE.map((_, i) => '<span class="seg ' + (i < round ? 'done' : '') + '"></span>').join('') + '</div>' +
    '<div class="mt-24"><div class="ai-orb speaking" id="orb">' + I.mic + '</div></div>' +
    '<div class="caption-bar mt-24"><span class="who">AI 提问</span><span id="capTxt"></span></div>' +
    '<div class="row mt-16" style="justify-content:center;">' +
    '<button class="btn btn-ink" id="talkBtn">' + I.mic + ' 我答完了</button>' +
    '<button class="btn btn-outline" id="interruptBtn">打断 AI</button>' +
    '</div>' +
    '<p class="tiny muted" style="text-align:center;margin-top:12px;">点击“打断 AI”可随时停下 AI 的提问。</p>';

  draw();
  $('#interruptBtn').addEventListener('click', () => {
    speaking = false; if (tween) clearTimeout(tween);
    $('#orb').className = 'ai-orb listening';
    $('#capTxt').textContent = question;
    toast('AI 已停下，换你回答');
    later(() => { $('#orb').className = 'ai-orb'; }, 1200);
  });
  $('#talkBtn').addEventListener('click', () => {
    speaking = false; if (tween) clearTimeout(tween);
    showRoundFeedback(scene, round);
  });
}

function showRoundFeedback(scene, round) {
  const item = PRACTICE[round];
  const last = round === PRACTICE.length - 1;
  scene.innerHTML =
    '<div class="round-track">' + PRACTICE.map((_, i) => '<span class="seg ' + (i <= round ? 'done' : '') + '"></span>').join('') + '</div>' +
    '<div class="mt-24 panel-title">第 ' + (round + 1) + ' 轮反馈</div>' +
    '<div class="stack mt-16">' +
    '<div class="fb-card">' + I.bulb + ' <b>建议</b><div class="small mt-8">' + item.tip + '</div></div>' +
    '<div class="fb-card bad">' + I.spark + ' <b>亮点</b><div class="small mt-8">' + item.hi + '</div></div>' +
    '</div>' +
    '<div class="row mt-16" style="justify-content:flex-end;">' +
    '<button class="btn btn-ghost" id="quitBtn">退出</button>' +
    '<button class="btn btn-primary" id="nextBtn">' + (last ? '查看报告' : '下一题') + '</button>' +
    '</div>';
  $('#nextBtn').addEventListener('click', () => {
    if (last) {
      const s = saveSession({ id: 'P' + Date.now().toString().slice(-8), role: 'candidate', title: '模拟面试 · 后端工程师', date: nowStr(), duration: '18:44', followUps: 3, adoptRate: 1.0, deleted: false });
      location.hash = '#/report/' + s.id;
    } else startPractice(scene, round + 1);
  });
  $('#quitBtn').addEventListener('click', () => { location.hash = '#/candidate'; });
}

/* =========================================================
   pages: interviewer / analysis / report
   ========================================================= */

const CODES = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() { let c = ''; for (let i = 0; i < 6; i++) c += CODES[Math.floor(Math.random() * CODES.length)]; return c; }
function nowStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/* ---------- interviewer home ---------- */
routes['/interviewer'] = {
  key: 'interviewer',
  render() {
    return navHtml('interviewer') +
      '<main class="wrap page page-narrow fade-in">' +
      '<h1 style="font-size:34px;">面试官</h1>' +
      '<p class="panel-sub" style="margin-top:6px;">创建面试房间，实时看候选人的隐藏信号。</p>' +
      '<div class="card card-pad mt-24" id="createCard">' +
      '<div class="panel-title">创建房间</div><div class="panel-sub mt-8">生成 6 位房间号，把链接发给面试者。</div>' +
      '<button class="btn btn-primary btn-lg mt-16" id="createBtn">' + I.spark + ' 创建房间</button>' +
      '</div>' +
      '<a class="list-row mt-16" href="#/interviewer/analysis" style="text-decoration:none;color:inherit;">' +
      '<span class="role-icon dark" style="width:42px;height:42px;">' + I.hist + '</span>' +
      '<div class="grow"><div style="font-weight:700;">查看面试者分析</div><div class="tiny muted">历史场次、追问点、采纳率</div></div>' + I.chev + '</a>' +
      '</main>' + footerHtml();
  },
  mount() {
    $('#createBtn').addEventListener('click', () => {
      const code = genCode();
      LS.set('corgi_room', { code, created: nowStr() });
      location.hash = '#/interviewer/room/' + code;
    });
    const sw = $('#switchRole'); if (sw) sw.addEventListener('click', () => { LS.del('corgi_role'); location.hash = '#/'; render(); });
  }
};

/* ---------- interviewer live ---------- */
const CANDIDATE_LINES = [
  '好的，那我先做自我介绍……',
  '我之前在上一家公司主要负责增长侧的后端……',
  '这个项目我们从零开始搭，核心指标是日活……',
  'QPS 的话，我们后来压到一万二左右……',
  '遇到冲突，我们一般先对齐目标再一起解决。',
  '最后上线后的留存提升了大概十个百分点。'
];
const CUES = [
  { text: '追问“我们”是谁', why: '候选人用人称“我们”带过关键贡献，需要确认其个人角色与边界。' },
  { text: '追问数字口径', why: '“一万二 QPS”与简历口径不一致，需确认峰值、均值与压测条件。' },
  { text: '追问冲突结果', why: '两次回答都在“一起解决”处结束，缺少候选人的具体动作与结果。' },
  { text: '追问项目角色', why: '叙述以团队为视角，未说明候选人从 0 到 1 的实际贡献。' }
];

routes['/interviewer/room/:id'] = {
  key: 'interviewerRoom',
  render(p) {
    return navHtml('interviewer') +
      '<main class="wrap page fade-in">' +
      '<div class="row-between"><div><h1 style="font-size:28px;">面试中</h1>' +
      '<p class="panel-sub mt-8">房间 ' + esc(p.id) + ' · <span id="timer">00:00</span></p></div>' +
      '<div class="row"><span class="chip peach" id="adoptChip">采纳 0</span><span class="chip gray" id="ignoreChip">忽略 0</span>' +
      '<button class="btn btn-danger" id="endIntBtn">' + I.phone + ' 结束面试</button></div></div>' +
      '<div class="grid-2 mt-16" style="align-items:start;">' +
      '<div class="stack">' +
      '<div class="stage" id="intStage"><div class="vid-fill"><div><div class="avatar">李</div><div class="place-name">候选人 · 李想</div></div></div>' +
      '<div class="status-float"><span class="pulse"></span><span id="intStatus">等待候选人进入…</span></div></div>' +
      '<div class="caption-bar"><span class="who">实时字幕</span><span id="intCap">等待候选人进入…</span></div>' +
      '<p class="tiny muted">隐私提示：本场信号与提示卡仅同步给当场面官本人，不写入候选人可见画面。</p>' +
      '</div>' +
      '<div class="stack">' +
      '<div class="signal-band"><div class="signal-head"><b>候选人情信号（实时）</b><span class="tiny muted">无数字 · 仅面官可见</span></div>' +
      '<div class="signal-lanes">' +
      lane('语速', 'l1', '40') + lane('停顿', 'l2', '45') + lane('表情', 'l3', '35') + lane('眼神', 'l4', '30') +
      '</div></div>' +
      '<div class="cue-wrap" id="cueWrap"></div>' +
      '</div></div>' +
      '</main>' + footerHtml();
  },
  mount(p) {
    let sec = 0, capi = 0, cuei = 0, adopt = 0, ignore = 0;
    every(() => { sec++; $('#timer').textContent = fmtTs(sec); }, 1000);
    every(() => {
      $('#intCap').textContent = CANDIDATE_LINES[capi % CANDIDATE_LINES.length]; capi++;
    }, 5000);
    every(() => {
      $$('#intStage .signal-lane i').forEach((bar, i) => {
        const move = b => Math.max(12, Math.min(100, b + Math.round((Math.random() - 0.5) * 40)));
        const cur = parseInt(bar.style.width || bar.getAttribute('data-w'), 10);
        bar.style.width = move(cur) + '%'; bar.setAttribute('data-w', move(cur));
      });
    }, 2600);
    later(() => { $('#intStatus').textContent = '候选人已进入'; }, 2500);
    const cue = () => {
      const item = CUES[cuei % CUES.length]; cuei++;
      $('#cueWrap').innerHTML =
        '<div class="cue" id="cueFull"><div class="cue-text">' + I.bulb + ' ' + esc(item.text) + ' <span class="tiny muted">(≤10 字)</span></div>' +
        '<div style="margin-top:6px;"><button class="btn btn-sm btn-soft" id="whyBtn">为什么</button></div>' +
        '<div class="cue-actions"><button class="btn btn-sm btn-primary" id="useBtn">用掉</button>' +
        '<button class="btn btn-sm btn-ghost" id="ignoreCueBtn">忽略</button></div></div>';
      $('#whyBtn').addEventListener('click', () => toggleWhy(item));
      $('#useBtn').addEventListener('click', () => { adopt++; $('#adoptChip').textContent = '采纳 ' + adopt; mini(); });
      $('#ignoreCueBtn').addEventListener('click', () => { ignore++; $('#ignoreChip').textContent = '忽略 ' + ignore; mini(); });
      const mini = () => {
        $('#cueWrap').innerHTML = '<div class="cue mini" id="cueMini">' + I.bulb + '<span>' + esc(item.text) + '</span>' + I.chev + '</div>';
        $('#cueMini').addEventListener('click', () => { $('#cueWrap').innerHTML = cueFullHtml(item); wireFull(item, adopt, ignore); });
      };
      later(mini, 3000);
    };
    later(cue, 3200);
    $('#endIntBtn').addEventListener('click', () => {
      const s = saveSession({ id: 'R' + Date.now().toString().slice(-8), role: 'interviewer', title: '前端工程师', date: nowStr(), duration: fmtTs(sec), followUps: 3, adoptRate: denyZero(adopt + ignore, adopt), deleted: false });
      location.hash = '#/report/' + s.id;
    });
    const sw = $('#switchRole'); if (sw) sw.addEventListener('click', () => { LS.del('corgi_role'); location.hash = '#/'; render(); });
  }
};
function denyZero(total, n) { return total === 0 ? 0 : Number((n / total).toFixed(2)); }
function lane(lab, cls, w) {
  return '<div class="signal-lane"><span class="lab">' + lab + '</span><div class="bar"><i class="' + cls + '" data-w="' + w + '" style="width:' + w + '%"></i></div></div>';
}

function toggleWhy(item) {
  const full = $('#cueFull'); if (!full) return;
  const has = $('#whyBox');
  if (has) { has.remove(); return; }
  const d = document.createElement('div'); d.id = 'whyBox'; d.className = 'cue-why';
  d.textContent = '为什么提这个？' + item.why;
  full.querySelector('.cue-actions').before(d);
}
function cueFullHtml(item) {
  return '<div class="cue" id="cueFull"><div class="cue-text">' + I.bulb + ' ' + esc(item.text) + ' <span class="tiny muted">(≤10 字)</span></div>' +
    '<div style="margin-top:6px;"><button class="btn btn-sm btn-soft" id="whyBtn">为什么</button></div>' +
    '<div class="cue-actions"><button class="btn btn-sm btn-primary" id="useBtn">用掉</button>' +
    '<button class="btn btn-sm btn-ghost" id="ignoreCueBtn">忽略</button></div></div>';
}
function wireFull(item, adopt, ignore) {
  $('#whyBtn').addEventListener('click', () => toggleWhy(item));
  $('#useBtn').addEventListener('click', () => { adopt++; $('#adoptChip').textContent = '采纳 ' + adopt; $('#cueWrap').innerHTML = ''; });
  $('#ignoreCueBtn').addEventListener('click', () => { ignore++; $('#ignoreChip').textContent = '忽略 ' + ignore; $('#cueWrap').innerHTML = ''; });
}

/* ---------- analysis ---------- */
routes['/interviewer/analysis'] = {
  key: 'analysis',
  render() {
    const s = getSessions();
    const body = s.length === 0
      ? '<div class="empty">' + I.hist + '<div class="big">还没有面试记录</div><div>创建房间完成第一场面试后，分析会出现在这里。</div></div>'
      : s.map(row =>
        '<a class="list-row" href="#/report/' + esc(row.id) + '" style="text-decoration:none;color:inherit;">' +
        '<div class="kv" style="min-width:120px;"><span class="k">时间</span><span class="v" style="font-size:14px;">' + esc(row.date) + '</span></div>' +
        '<div class="grow kv"><span class="k">职位</span><span class="v">' + esc(row.title) + (row.deleted ? ' <span class="chip red" style="margin-left:6px;">已删除</span>' : '') + '</span></div>' +
        '<div class="kv"><span class="k">追问点</span><span class="v">' + row.followUps + '</span></div>' +
        '<div class="kv"><span class="k">采纳率</span><span class="v">' + Math.round(row.adoptRate * 100) + '%</span></div>' + I.chev + '</a>').join('');
    return navHtml('analysis') +
      '<main class="wrap page page-narrow fade-in">' +
      '<div class="row-between"><div><h1 style="font-size:30px;">面试者分析</h1><p class="panel-sub mt-8">历史场次的追问点与采纳情况。</p></div>' +
      '<a class="btn btn-ink" href="#/interviewer">' + I.spark + ' 新建面试</a></div>' +
      '<div class="stack mt-24">' + body + '</div>' +
      '</main>' + footerHtml();
  },
  mount() {
    const sw = $('#switchRole'); if (sw) sw.addEventListener('click', () => { LS.del('corgi_role'); location.hash = '#/'; render(); });
  }
};

/* ---------- report ---------- */
routes['/report/:id'] = {
  key: 'report',
  render(p) {
    const mode = getRole() === 'candidate' ? 'candidate' : 'interviewer';
    return navHtml('report') +
      '<main class="wrap page page-narrow fade-in">' +
      '<div class="row-between"><div><h1 style="font-size:30px;">面试报告</h1>' +
      '<p class="panel-sub mt-8" id="repMeta"></p></div>' +
      '<div class="seg-toggle" id="seg"><button data-m="interviewer">面试官版</button><button data-m="candidate">候选人版</button></div></div>' +
      '<div class="mt-24" id="repBody"></div>' +
      '</main>' + footerHtml();
  },
  mount(p) {
    let mode = getRole() === 'candidate' ? 'candidate' : 'interviewer';
    const seg = $('#seg');
    $$('button', seg).forEach(b => b.addEventListener('click', () => {
      mode = b.dataset.m;
      $$('button', seg).forEach(x => x.classList.toggle('on', x === b));
      draw(mode);
    }));
    const draw = m => {
      $$('button', seg).forEach(x => x.classList.toggle('on', x.dataset.m === m));
      const d = reportData(p.id, m);
      $('#repMeta').textContent = d.title + ' · ' + (d.date || '') + ' · 时长 ' + d.duration;
      const points = d.points.map((pt, i) =>
        '<div class="point-card"><div class="row-between"><span class="chip peach">追问点 ' + (i + 1) + '</span>' +
        '<span class="point-ts" data-t="' + pt.t + '">' + I.play + ' ' + pt.t + '</span></div>' +
        '<div style="font-weight:700;font-size:17px;margin-top:12px;">' + esc(pt.line) + '</div>' +
        '<div class="evidence mt-12">' + I.eye + ' <b>证据</b> · ' + esc(pt.ev) + '</div></div>').join('');
      const conclusion = m === 'candidate'
        ? '你整体表达自然，节奏稳定；建议在“功劳归属”处多把“我们”换成“我负责”，并给每个结论配一条证据。'
        : d.conclusion;
      const delNote = d.deleted
        ? '<span class="chip red">' + I.x + ' 已删除 · 数据将在 7 天后清除</span>'
        : '<span class="chip gray">删除状态：未删除</span>';
      $('#repBody').innerHTML =
        '<div class="conclusion">一句话结论<br><span style="font-weight:400;font-size:17px;">' + esc(conclusion) + '</span></div>' +
        '<div class="grid-3 mt-16">' +
        '<div class="stat-box"><div class="num">' + d.points.length + '</div><div class="lab">追问点</div></div>' +
        '<div class="stat-box"><div class="num">' + Math.round(d.adoptRate * 100) + '%</div><div class="lab">提示采纳率</div></div>' +
        '<div class="stat-box"><div class="num">' + d.duration + '</div><div class="lab">面试时长</div></div></div>' +
        '<div class="stack mt-16">' + points + '</div>' +
        '<div class="card card-pad mt-16" id="replayCard" style="display:none;"><div class="row-between"><b>回看 20 秒</b><span class="tiny muted" id="replayT"></span></div>' +
        '<div class="replay mt-12"><div class="r-track"><i id="replayBar"></i></div><div class="tiny muted" style="margin-top:8px;">模拟回放该时间点前后 20 秒的问答。</div></div></div>' +
        '<div class="card card-pad mt-16" style="display:flex;flex-direction:column;gap:10px;">' +
        '<div class="row-between"><b>合规与数据</b>' + delNote + '</div>' +
        '<div class="small muted">本报告基于面试音视频与设备信号生成，仅提供给面试双方本人。候选人可随时申请删除，删除后 7 天内彻底清除。</div>' +
        '<div class="row" style="justify-content:flex-end;gap:10px;margin-top:4px;">' +
        '<button class="btn btn-ghost btn-sm" id="delBtn">' + I.x + ' 删除本场数据</button>' +
        '<button class="btn btn-ink btn-sm" id="copyBtn">' + I.copy + ' 复制文本</button></div></div>';
      $$('.point-ts').forEach(ts => ts.addEventListener('click', () => replay(ts.dataset.t)));
      $('#copyBtn').addEventListener('click', () => {
        const text = reportText(p.id, m, d);
        if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(() => toast('已复制到剪贴板'), () => toast('复制失败')); }
        else toast('复制失败：浏览器不支持');
      });
      $('#delBtn').addEventListener('click', () => {
        markDeleted(p.id); toast('已提交删除申请，7 天后彻底清除'); render();
      });
    };
    draw(mode);
    const sw = $('#switchRole'); if (sw) sw.addEventListener('click', () => { LS.del('corgi_role'); location.hash = '#/'; render(); });
    function replay(t) {
      const card = $('#replayCard'); card.style.display = '';
      $('#replayT').textContent = t + ' 起 · 20 秒';
      const bar = $('#replayBar'); bar.style.width = '0%';
      let w = 0;
      const rw = every(() => { w += 5; bar.style.width = Math.min(100, w) + '%'; if (w >= 100) { clearInterval(rw); } }, 1000);
    }
  }
};

function reportText(id, mode, d) {
  const head = '【' + d.title + '面试报告】\n时长 ' + d.duration + ' · 追问点 ' + d.points.length + ' · 提示采纳率 ' + Math.round(d.adoptRate * 100) + '%\n\n';
  const one = '一句话结论：' + (mode === 'candidate'
    ? '你整体表达自然，节奏稳定；建议把“我们”换成“我负责”，并给每个结论配一条证据。' : d.conclusion) + '\n\n';
  const pts = d.points.map((p, i) => '追问点 ' + (i + 1) + '（' + p.t + '）：' + p.line + '\n证据：' + p.ev).join('\n\n');
  const tail = mode === 'candidate'
    ? '\n\n—— 本报告仅供你本人练习使用，可随时删除。'
    : '\n\n—— 本报告由 AI 辅助生成，请结合你的专业判断使用。';
  return head + one + pts + tail;
}

/* ---------- 404 & footer & boot ---------- */
function page404() {
  return navHtml('404') + '<main class="wrap page page-narrow"><div class="empty">' + I.x + '<div class="big">页面不存在</div><div><a href="#/">回到首页</a></div></div></main>' + footerHtml();
}
function footerHtml() {
  return '<footer class="footer"><div class="wrap row-between"><div>corgi 面试前端 · 学习 corgi.insure 视觉风格的作品。</div>' +
    '<div>本页面仅为前端演示，所有人物与数据均为模拟。</div></div></footer>';
}
window.addEventListener('hashchange', render);
window.addEventListener('DOMContentLoaded', render);

