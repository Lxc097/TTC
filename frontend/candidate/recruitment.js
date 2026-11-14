/* TTC candidate recruitment surfaces. Keep the room and report flow in app.js. */
(function () {
  'use strict';

  const app = document.getElementById('app');
  const page = document.body.dataset.recruitmentPage;
  const authKey = 'ttc.recruitment.candidate.auth';
  const maxResumeBytes = 8 * 1024 * 1024;
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const byId = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);

  function auth() {
    try {
      const value = JSON.parse(localStorage.getItem(authKey) || 'null');
      return value && typeof value.token === 'string' && value.user?.role === 'candidate' ? value : null;
    } catch (_) { return null; }
  }

  function saveAuth(value) { localStorage.setItem(authKey, JSON.stringify(value)); }
  function clearAuth() { localStorage.removeItem(authKey); }
  function accountLink(next) { return 'account.html?next=' + encodeURIComponent(next || 'applications.html'); }
  function showError(id, message) {
    const node = byId(id);
    if (node) { node.textContent = message || ''; node.classList.toggle('hidden', !message); }
  }
  async function readError(response) {
    try {
      const value = await response.json();
      const message = typeof value.detail === 'string' ? value.detail : typeof value.error === 'string' ? value.error : '';
      if (message) return message.slice(0, 220);
    } catch (_) { /* Keep the public error generic. */ }
    if (response.status === 401) return '登录已失效，请重新登录。';
    if (response.status === 403) return '当前账号没有访问权限。';
    if (response.status === 413) return '简历超过大小限制。';
    return '请求未完成，请稍后重试。';
  }
  async function api(path, options, signed) {
    const headers = new Headers(options?.headers || {});
    if (signed !== false) {
      const account = auth();
      if (!account) throw new Error('请先登录候选人账户。');
      headers.set('Authorization', 'Bearer ' + account.token);
    }
    let response;
    try { response = await fetch(path, {...options, headers, cache:'no-store'}); }
    catch (_) { throw new Error('无法连接招聘服务，请检查网络后重试。'); }
    if (!response.ok) throw new Error(await readError(response));
    return response.json();
  }
  function dateLabel(value) {
    const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
    return isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', {year:'numeric',month:'2-digit',day:'2-digit'});
  }
  function statusLabel(status) {
    return ({submitted:'已提交',parsing:'正在解析',screening:'正在处理',hr_review:'等待后续通知',ai_interview_invited:'已收到初面邀请',ai_interview_in_progress:'初面进行中',ai_interview_completed:'初面已完成',hr_interview_invited:'企业复试邀请',closed:'申请已结束',failed:'处理遇到问题'})[status] || '正在处理';
  }
  function safeApplication(value) {
    // Candidate state deliberately accepts only the public DTO fields.
    const path = value.invitation?.interviewPath;
    const interviewPath = typeof path === 'string' && /^\/(?:ai-interview|personal)\/\?application=[a-zA-Z0-9-]+$/.test(path) ? path : '';
    return {id:String(value.id || ''),jobTitle:String(value.jobTitle || ''),companyName:String(value.companyName || ''),status:String(value.status || ''),createdAt:value.createdAt,interviewPath,invited:value.status === 'ai_interview_invited' || value.status === 'ai_interview_in_progress'};
  }
  function invitationAction(item) {
    if (!item.invited || !item.interviewPath) return '';
    const formal = item.interviewPath.startsWith('/ai-interview/');
    return '<a class="btn btn-primary" href="' + esc(item.interviewPath) + '">' + (formal ? '进入岗位 AI 初面' : '进入企业面试房间') + '</a>';
  }
  function guest(copy, next) {
    app.innerHTML = '<section class="recruit-guest"><span class="eyebrow">候选人账户</span><h1>' + esc(copy) + '</h1><p>登录后可投递简历、查看进度与接收面试邀请。</p><a class="btn btn-primary" href="' + accountLink(next) + '">登录或创建账户</a></section>';
  }

  async function renderAccount() {
    const current = auth();
    if (current) {
      app.innerHTML = '<section class="recruit-guest"><span class="eyebrow">候选人账户</span><h1>欢迎回来，' + esc(current.user.name) + '</h1><p>' + esc(current.user.email) + '</p><div class="recruit-actions"><a class="btn btn-primary" href="applications.html">查看我的申请</a><button id="recruit-logout" class="btn btn-quiet" type="button">退出登录</button></div></section>';
      byId('recruit-logout').onclick = () => { clearAuth(); renderAccount(); };
      return;
    }
    let mode = 'login';
    const next = ['apply.html','applications.html'].includes(params.get('next')) ? params.get('next') : 'applications.html';
    let demoMode = false;
    try { demoMode = Boolean((await api('/api/auth/demo-mode', {}, false)).enabled); } catch (_) { /* Use normal form. */ }
    if (demoMode) {
      app.innerHTML = '<div class="recruit-account-layout"><div class="recruit-account-intro"><span class="eyebrow">TTC · 本机演示</span><h1>输入测试账号，直接体验投递。</h1><p>同一测试账号可再次查看自己的申请；当前不校验密码。</p></div><section class="card recruit-account-card"><h2>测试登录</h2><form id="account-form"><div class="field"><label for="account-email">测试账号</label><input id="account-email" type="text" required placeholder="任意昵称或邮箱"></div><div class="field"><label for="account-password">测试密码</label><input id="account-password" type="password" required placeholder="任意内容"></div><p id="account-error" class="inline-error hidden" role="alert"></p><button id="account-submit" class="btn btn-primary btn-block" type="submit">进入个人端</button></form></section></div>';
      byId('account-form').onsubmit = async (event) => {
        event.preventDefault();
        const button = byId('account-submit'); button.disabled = true;
        showError('account-error', '');
        try {
          const result = await api('/api/auth/login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:byId('account-email').value.trim(),password:byId('account-password').value})}, false);
          if (result.user?.role !== 'candidate' || !result.token) throw new Error('测试登录未完成。');
          saveAuth(result); location.replace(next);
        } catch (error) { showError('account-error', error.message || '无法登录。'); button.disabled = false; }
      };
      return;
    }
    const draw = () => {
      app.innerHTML = '<div class="recruit-account-layout"><div class="recruit-account-intro"><span class="eyebrow">TTC · 候选人端</span><h1>从一次真实的投递开始。</h1><p>一个账户管理简历投递、申请进度和初面邀请。</p></div><section class="card recruit-account-card">'
        + '<div class="recruit-tabs"><button id="account-login" type="button" class="' + (mode === 'login' ? 'active' : '') + '">登录</button><button id="account-register" type="button" class="' + (mode === 'register' ? 'active' : '') + '">创建账户</button></div>'
        + '<h2>' + (mode === 'login' ? '欢迎回来' : '创建候选人账户') + '</h2><form id="account-form">'
        + (mode === 'register' ? '<div class="field"><label for="account-name">姓名</label><input id="account-name" autocomplete="name" maxlength="80" required placeholder="你的姓名"></div>' : '')
        + '<div class="field"><label for="account-email">邮箱</label><input id="account-email" type="email" autocomplete="email" required placeholder="name@example.com"></div>'
        + '<div class="field"><label for="account-password">密码</label><input id="account-password" type="password" autocomplete="' + (mode === 'login' ? 'current-password' : 'new-password') + '" minlength="10" required placeholder="至少 10 位"></div>'
        + '<p id="account-error" class="inline-error hidden" role="alert"></p><button id="account-submit" class="btn btn-primary btn-block" type="submit">' + (mode === 'login' ? '登录' : '创建账户') + '</button></form></section></div>';
      byId('account-login').onclick = () => { mode = 'login'; draw(); };
      byId('account-register').onclick = () => { mode = 'register'; draw(); };
      byId('account-form').onsubmit = async (event) => {
        event.preventDefault();
        const button = byId('account-submit');
        button.disabled = true;
        button.textContent = '正在处理…';
        showError('account-error','');
        try {
          const payload = {email:byId('account-email').value.trim(),password:byId('account-password').value};
          if (mode === 'register') { payload.name = byId('account-name').value.trim(); payload.role = 'candidate'; }
          const result = await api('/api/auth/' + mode, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}, false);
          if (!result || typeof result.token !== 'string' || result.user?.role !== 'candidate') throw new Error('请使用候选人账户登录。');
          saveAuth(result);
          location.replace(next);
        } catch (error) { showError('account-error', error.message || '无法完成登录。'); }
        finally { button.disabled = false; button.textContent = mode === 'login' ? '登录' : '创建账户'; }
      };
    };
    draw();
  }

  function renderApply() {
    const current = auth();
    if (!current) { guest('投递你的下一次机会', 'apply.html'); return; }
    let jobs = [];
    let selected = null;
    let resume = null;
    app.innerHTML = '<div class="recruit-intro"><span class="eyebrow">简历投递</span><h1>投递你的下一次机会</h1><p>上传简历，让你的经历成为下一步面试的起点。</p></div>'
      + '<form id="apply-form" class="recruit-apply-form"><section class="recruit-section"><div class="recruit-section-head"><span>目标岗位</span><small>选择企业发布的岗位，自动绑定岗位要求</small></div><label class="sr-only" for="job-search">搜索岗位</label><input id="job-search" class="recruit-input" placeholder="输入岗位名称或企业，查找目标岗位" autocomplete="off"><div id="job-results" class="recruit-job-results"><p class="muted">正在读取岗位…</p></div><div id="job-detail" class="recruit-job-detail hidden"></div></section>'
      + '<section class="recruit-section"><div class="recruit-section-head"><span>上传简历</span><small>PDF / DOCX · 不超过 8 MB</small></div><input id="resume-input" type="file" class="sr-only" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"><button id="resume-zone" type="button" class="recruit-dropzone"><span class="recruit-upload-icon" aria-hidden="true">↑</span><strong>拖拽文件到这里，或点击选择</strong><small>仅上传本人简历</small></button><div id="resume-selected" class="recruit-file hidden"></div></section>'
      + '<section class="recruit-submit"><p class="recruit-signed">投递账户：' + esc(current.user.name) + ' · ' + esc(current.user.email) + '</p><label class="recruit-check"><input id="consent" type="checkbox"><span>我同意将简历和初筛资料用于所投递岗位的招聘评估，并按授权提供给对应企业。</span></label><label class="recruit-check"><input id="verify-links" type="checkbox"><span>我授权核验简历中主动提供的公开职业作品链接；不勾选时不进行外部链接核验。</span></label><p id="apply-error" class="inline-error hidden" role="alert"></p><div class="recruit-submit-bottom"><div id="upload-progress" class="recruit-progress hidden" role="status"><span>正在上传简历…</span><progress id="upload-bar" max="100" value="0"></progress></div><button id="apply-submit" type="submit" class="btn btn-primary">提交简历 <span aria-hidden="true">→</span></button></div></section></form>';

    const renderJobs = () => {
      const query = byId('job-search').value.trim().toLowerCase();
      const shown = jobs.filter((job) => (job.title + ' ' + (job.companyName || '')).toLowerCase().includes(query));
      byId('job-results').innerHTML = shown.length ? shown.map((job) => '<button type="button" class="recruit-job-row' + (selected?.id === job.id ? ' selected' : '') + '" data-job="' + esc(job.id) + '"><span><strong>' + esc(job.title) + '</strong><small>' + esc(job.companyName || '招聘企业') + '</small></span><span aria-hidden="true">' + (selected?.id === job.id ? '已选择 ✓' : '选择 →') + '</span></button>').join('') : '<p class="muted">没有匹配的已发布岗位。请调整关键词。</p>';
      byId('job-results').querySelectorAll('[data-job]').forEach((button) => {
        button.onclick = () => {
          selected = jobs.find((job) => job.id === button.dataset.job) || null;
          byId('job-detail').classList.toggle('hidden', !selected);
          byId('job-detail').innerHTML = selected ? '<strong>岗位要求 · ' + esc(selected.title) + '</strong><p>' + esc(selected.description || '企业尚未补充岗位说明。') + '</p>' : '';
          renderJobs();
        };
      });
    };
    byId('job-search').oninput = renderJobs;
    api('/api/jobs', {}, false).then((value) => {
      jobs = Array.isArray(value.items) ? value.items : [];
      const jobId = params.get('jobId');
      if (jobId) {
        selected = jobs.find((job) => job.id === jobId) || null;
        if (selected) { byId('job-search').value = selected.title; byId('job-detail').classList.remove('hidden'); byId('job-detail').innerHTML = '<strong>岗位要求 · ' + esc(selected.title) + '</strong><p>' + esc(selected.description || '') + '</p>'; }
      }
      renderJobs();
    }).catch((error) => { byId('job-results').innerHTML = '<p class="inline-error">' + esc(error.message) + '</p>'; });

    const input = byId('resume-input');
    const zone = byId('resume-zone');
    const showResume = () => {
      byId('resume-selected').classList.toggle('hidden', !resume);
      if (resume) byId('resume-selected').innerHTML = '<span aria-hidden="true">▤</span><span><strong>' + esc(resume.name) + '</strong><small>' + Math.ceil(resume.size / 1024) + ' KB</small></span><button id="resume-remove" type="button" aria-label="移除简历">移除</button>';
      zone.classList.toggle('hidden', Boolean(resume));
      if (resume) byId('resume-remove').onclick = () => { resume = null; input.value = ''; showResume(); };
    };
    const chooseResume = (file) => {
      if (!file) return;
      const issue = !/\.(pdf|docx)$/i.test(file.name) ? '仅支持 PDF 或 DOCX 格式。' : file.size === 0 ? '文件为空，请重新选择。' : file.size > maxResumeBytes ? '简历不能超过 8 MB。' : '';
      if (issue) { showError('apply-error', issue); return; }
      resume = file;
      showError('apply-error', '');
      showResume();
    };
    zone.onclick = () => input.click();
    input.onchange = () => { chooseResume(input.files[0]); input.value = ''; };
    zone.ondragover = (event) => { event.preventDefault(); zone.classList.add('dragging'); };
    zone.ondragleave = () => zone.classList.remove('dragging');
    zone.ondrop = (event) => { event.preventDefault(); zone.classList.remove('dragging'); chooseResume(event.dataTransfer.files[0]); };
    byId('apply-form').onsubmit = (event) => {
      event.preventDefault();
      if (!selected) { showError('apply-error', '请选择企业已发布的目标岗位。'); return; }
      if (!resume) { showError('apply-error', '请上传 PDF 或 DOCX 简历。'); return; }
      if (!byId('consent').checked) { showError('apply-error', '请先确认招聘评估资料的使用说明。'); return; }
      showError('apply-error', '');
      const button = byId('apply-submit');
      button.disabled = true;
      button.textContent = '正在提交…';
      byId('upload-progress').classList.remove('hidden');
      const form = new FormData();
      form.append('resume', resume);
      form.append('jobId', selected.id);
      form.append('consent', 'true');
      form.append('verifyLinks', byId('verify-links').checked ? 'true' : 'false');
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/applications');
      xhr.timeout = 45000;
      xhr.setRequestHeader('Authorization', 'Bearer ' + current.token);
      xhr.upload.onprogress = (progress) => {
        if (progress.lengthComputable) byId('upload-bar').value = Math.round(progress.loaded / progress.total * 100);
      };
      xhr.onload = () => {
        if (xhr.status === 202 || xhr.status === 200 || xhr.status === 201) {
          let result;
          try { result = JSON.parse(xhr.responseText); } catch (_) { result = null; }
          const application = result?.application;
          if (application?.id) { renderSubmitted(safeApplication(application)); return; }
          showError('apply-error', '服务端未返回申请编号，请在“我的申请”核对结果。');
        } else {
          let message = '提交失败，请稍后重试。';
          try { const body = JSON.parse(xhr.responseText); if (typeof body.detail === 'string') message = body.detail; } catch (_) { /* Keep generic message. */ }
          showError('apply-error', message);
        }
        button.disabled = false; button.textContent = '提交简历 →'; byId('upload-progress').classList.add('hidden');
      };
      xhr.onerror = xhr.ontimeout = () => { showError('apply-error','网络中断或上传超时，请在“我的申请”核对后再试。'); button.disabled = false; button.textContent = '提交简历 →'; byId('upload-progress').classList.add('hidden'); };
      xhr.send(form);
    };
  }

  function renderSubmitted(application) {
    app.innerHTML = '<section class="recruit-submitted"><span class="recruit-done" aria-hidden="true">✓</span><span class="eyebrow">申请已创建</span><h1>简历已提交</h1><p>你的资料已进入招聘流程，后续通知将在这里更新。</p><div class="recruit-submitted-meta"><span>目标岗位</span><strong>' + esc(application.jobTitle) + '</strong><span>当前状态</span><strong>' + esc(statusLabel(application.status)) + '</strong></div><div class="recruit-actions"><a class="btn btn-primary" href="status.html">查看我的状态</a><a class="btn btn-quiet" href="applications.html">申请记录</a></div></section>';
  }

  function renderApplications() {
    if (!auth()) { guest('查看你的申请进度', 'applications.html'); return; }
    app.innerHTML = '<section class="recruit-list-head"><div><span class="eyebrow">个人端</span><h1>我的申请</h1><p>后续通知会在这里更新。请按邀请页面说明进入对应初面；未收到邀请时，不代表已进入下一轮。</p></div><a class="btn btn-primary" href="apply.html">投递简历</a></section><p id="application-error" class="inline-error hidden" role="alert"></p><div id="application-list"><p class="muted">正在读取申请…</p></div>';
    const refresh = async () => {
      if (byId('application-list')?.querySelector('.recruit-correction[open]')) return;
      try {
        const payload = await api('/api/applications/my');
        const items = (Array.isArray(payload.items) ? payload.items : []).map(safeApplication);
        const list = byId('application-list');
        if (!list) return;
        list.innerHTML = items.length ? items.map((item) => '<article class="recruit-application-row"><div class="recruit-application-main"><small>' + esc(item.companyName || '招聘岗位') + ' · ' + esc(dateLabel(item.createdAt)) + '</small><h2>' + esc(item.jobTitle || '目标岗位') + '</h2><details class="recruit-correction"><summary>信息有误？申请更正</summary><form data-correction="' + esc(item.id) + '"><label for="correction-' + esc(item.id) + '">说明需要更正的内容</label><textarea id="correction-' + esc(item.id) + '" minlength="10" maxlength="1000" required placeholder="例如：简历中某段任职时间有误，请以我提交的更新资料为准。"></textarea><button type="submit" class="btn btn-quiet">发送更正申请</button><p class="recruit-correction-status" role="status"></p></form></details></div><div class="recruit-application-action"><span class="pill' + (item.invited ? ' orange' : '') + '">' + esc(statusLabel(item.status)) + '</span>' + invitationAction(item) + '</div></article>').join('') : '<div class="recruit-list-empty"><h2>还没有申请记录</h2><p>选择一个已发布的岗位并上传简历，开始投递。</p><a href="apply.html" class="btn btn-primary">前往投递</a></div>';
        list.querySelectorAll('form[data-correction]').forEach((form) => {
          form.onsubmit = async (event) => {
            event.preventDefault();
            const button = form.querySelector('button');
            const status = form.querySelector('.recruit-correction-status');
            button.disabled = true; status.textContent = '正在发送…';
            try {
              await api('/api/applications/' + encodeURIComponent(form.dataset.correction) + '/corrections', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:form.querySelector('textarea').value.trim()})});
              status.textContent = '更正申请已提交，企业会在招聘流程中查看。';
              form.querySelector('textarea').value = '';
            } catch (error) { status.textContent = error.message || '发送失败，请稍后重试。'; }
            finally { button.disabled = false; }
          };
        });
        showError('application-error','');
      } catch (error) { showError('application-error', error.message || '无法读取申请进度。'); }
    };
    refresh();
    setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 15000);
  }

  /* ---------- 我的状态：只展示当前阶段 ---------- */
  const STAGE_TEXT = {
    applied: { label: '阶段 1', title: '发送简历', desc: '简历已进入企业审核。企业推进后，下一步安排会出现在这里。' },
    ai_interview: { label: '阶段 2', title: 'AI 面试', desc: '企业已发出 AI 初面邀请，请在截止时间前完成。' },
    human_interview: { label: '阶段 3', title: '真人面试', desc: '企业已安排真人面试，请按约定时间参加。' },
    ended: { label: '已结束', title: '流程结束', desc: '本次招聘流程已经结束。' },
  };

  function modeText(mode) {
    return ({ video: '线上视频', onsite: '线下面试', phone: '电话面试' })[mode] || '待确认';
  }
  function deadlineText(epoch) {
    const date = new Date(Number(epoch) * 1000);
    if (isNaN(date.getTime())) return '—';
    const days = Math.ceil((date.getTime() - Date.now()) / 86400000);
    return dateLabel(epoch) + (days > 0 ? '（' + days + ' 天后截止）' : '（已过期）');
  }
  function metaRow(label, value) {
    return '<div><span>' + esc(label) + '</span><strong>' + esc(value || '—') + '</strong></div>';
  }
  function stageKey(item) { return STAGE_TEXT[item.stage] ? item.stage : 'applied'; }
  function processText(item) {
    if (item.status === 'failed' || item.resumeStatus === 'failed') return '处理遇到问题';
    if (['queued', 'parsing'].includes(item.resumeStatus)) return '解析中';
    if (['queued', 'screening'].includes(item.screeningStatus)) return '初筛中';
    if (item.screeningStatus === 'completed') return '已完成初筛，等待企业审核';
    return '处理中';
  }

  async function renderStatus() {
    if (!auth()) { guest('查看你的招聘阶段', 'status.html'); return; }
    app.innerHTML = '<section class="recruit-list-head"><div><span class="eyebrow">个人端</span><h1>我的状态</h1><p>这里只看当前阶段与下一步；后续安排由企业推进后更新。</p></div><a class="btn btn-ghost" href="applications.html">申请记录</a></section>'
      + '<p id="status-error" class="inline-error hidden" role="alert"></p><div id="status-panel"><p class="muted">正在读取状态…</p></div>';
    await refreshStatus();
    setInterval(() => {
      if (document.visibilityState === 'visible' && byId('status-panel') && !byId('status-upload-form')) refreshStatus(true);
    }, 20000);
  }

  async function refreshStatus(silent) {
    const panel = byId('status-panel');
    if (!panel) return;
    try {
      const payload = await api('/api/applications/my');
      const items = (Array.isArray(payload.items) ? payload.items : []).slice();
      if (!items.length) { await drawStatusUpload(panel); return; }
      items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      const wanted = params.get('app');
      const current = items.find((item) => item.id === wanted) || items[0];
      try { localStorage.setItem('ttc.candidate.lastApp', current.id); } catch (_) { /* storage may be blocked */ }
      drawStatusPanel(panel, current, items);
      showError('status-error', '');
    } catch (error) {
      if (!silent) {
        showError('status-error', error.message || '无法读取申请状态。');
        panel.innerHTML = '<p class="muted">暂时无法读取状态，请稍后重试。</p>';
      }
    }
  }

  function drawStatusPanel(panel, current, items) {
    const stage = stageKey(current);
    const text = STAGE_TEXT[stage];
    const switcher = items.length > 1
      ? '<div class="status-switch" role="group" aria-label="切换申请">' + items.map((item) =>
        '<button type="button" data-app="' + esc(item.id) + '" class="status-pill' + (item.id === current.id ? ' on' : '') + '">'
        + esc(item.jobTitle || '申请') + '</button>').join('') + '</div>'
      : '';
    panel.innerHTML = switcher
      + '<section class="card status-card">'
      + '<header class="status-head"><span class="status-stage">' + esc(text.label) + '</span>'
      + '<div><h2>' + esc(text.title) + '</h2><p>' + esc(current.jobTitle || '目标岗位') + ' · ' + esc(current.companyName || '招聘企业') + '</p></div>'
      + '<span class="status-chip">' + esc(current.stageLabel || text.title) + '</span></header>'
      + '<p class="status-desc">' + esc(text.desc) + '</p>'
      + statusBody(stage, current)
      + '<div class="status-actions">' + statusActions(stage, current) + '</div>'
      + '</section>';
    panel.querySelectorAll('[data-app]').forEach((button) => {
      button.onclick = () => {
        const url = new URL(location.href);
        url.searchParams.set('app', button.dataset.app);
        params.set('app', button.dataset.app);
        history.replaceState(null, '', url);
        refreshStatus();
      };
    });
    panel.querySelectorAll('[data-enter-human]').forEach((button) => {
      button.onclick = async () => {
        button.disabled = true;
        const original = button.textContent;
        button.textContent = '正在进入…';
        showError('status-error', '');
        try {
          const result = await api('/api/applications/' + encodeURIComponent(current.id) + '/human-interview/enter', { method: 'POST' });
          if (result.interviewPath) { location.href = result.interviewPath; return; }
          button.disabled = false;
          button.textContent = original;
          showError('status-error', '本次为' + modeText(result.mode) + '：' + (result.location || '请按约定地点参加'));
        } catch (error) {
          button.disabled = false;
          button.textContent = original;
          showError('status-error', error.message || '暂时无法进入面试房间。');
        }
      };
    });
  }

  function statusBody(stage, item) {
    if (stage === 'applied') {
      const failed = item.status === 'failed' || item.resumeStatus === 'failed';
      return '<dl class="status-meta">'
        + metaRow('提交时间', dateLabel(item.createdAt))
        + metaRow('简历处理', processText(item))
        + metaRow('当前状态', statusLabel(item.status))
        + '</dl>'
        + (failed
          ? '<p class="status-note warn">简历处理遇到问题。你可以在申请记录里提交更正说明，或联系企业招聘人员。</p>'
          : '<p class="status-note">企业审核完成后，下一步安排会出现在这里。</p>');
    }
    if (stage === 'ai_interview') {
      const invitation = item.invitation || {};
      const state = invitation.state || 'pending';
      const stateMap = { pending: '待开始', accepted: '进行中', expired: '已过期', completed: '已完成' };
      return '<dl class="status-meta">'
        + metaRow('邀请时间', dateLabel(invitation.sentAt))
        + metaRow('截止时间', invitation.expiresAt ? deadlineText(invitation.expiresAt) : '—')
        + metaRow('邀请状态', stateMap[state] || '待开始')
        + '</dl>'
        + (state === 'expired' ? '<p class="status-note warn">邀请已过期。请联系企业招聘人员重新发送邀请。</p>' : '')
        + (state === 'completed' ? '<p class="status-note">AI 初面已完成，等待企业通知下一步安排。</p>' : '')
        + (state === 'pending' || state === 'accepted' ? '<p class="status-note">进入前请确认麦克风、摄像头可用，并选择安静的环境作答。</p>' : '')
        + (item.aiResult?.visible ? '<p class="status-note ok">企业已收到你的 AI 初面结果。</p>' : '');
    }
    if (stage === 'human_interview') {
      const interview = item.humanInterview || {};
      const stateMap = { pending: '待开始', accepted: '已接受', expired: '已过期', completed: '已完成', cancelled: '已取消' };
      return '<dl class="status-meta">'
        + metaRow('面试时间', dateLabel(interview.scheduledAt) + (interview.durationMinutes ? ' · ' + interview.durationMinutes + ' 分钟' : ''))
        + metaRow('面试官', interview.interviewerName)
        + metaRow('面试形式', modeText(interview.mode))
        + (interview.mode === 'video' ? metaRow('房间号', interview.roomCode || '进入时分配') : metaRow('地点 / 联系方式', interview.location))
        + metaRow('状态', stateMap[interview.state] || '待开始')
        + '</dl>'
        + (interview.state === 'expired' ? '<p class="status-note warn">面试安排已过期，请联系企业重新安排。</p>' : '')
        + (interview.state === 'completed' ? '<p class="status-note">真人面试已完成。' + (item.result?.visible ? '' : '结果由企业决定是否发送。') + '</p>' : '')
        + (interview.mode !== 'video' && ['pending', 'accepted'].includes(interview.state) ? '<p class="status-note">本次为' + modeText(interview.mode) + '，请按约定地点或联系方式参加。</p>' : '')
        + (item.result?.visible ? '<p class="status-note ok">企业已发送结论：' + esc(item.result.message) + '</p>' : '');
    }
    const result = item.result;
    return '<dl class="status-meta">' + metaRow('岗位', item.jobTitle) + metaRow('状态', '流程已结束') + '</dl>'
      + (result?.visible
        ? '<p class="status-result">' + esc(result.conclusion) + '</p><p class="status-note">' + esc(result.message) + '</p>'
        : '<p class="status-note">企业没有发送结论。感谢你的参与。</p>');
  }

  function statusActions(stage, item) {
    const records = '<a class="btn btn-ghost" href="applications.html">申请记录 / 更正</a>';
    if (stage === 'applied') {
      return records + '<a class="btn btn-primary" href="apply.html">继续投递其他岗位</a>';
    }
    if (stage === 'ai_interview') {
      const state = item.invitation?.state || 'pending';
      const canEnter = (state === 'pending' || state === 'accepted') && item.invitation?.interviewPath;
      return (canEnter ? '<a class="btn btn-primary" href="' + esc(item.invitation.interviewPath) + '">进入 AI 初面</a>' : '')
        + records + '<a class="btn btn-ghost" href="apply.html">继续投递其他岗位</a>';
    }
    if (stage === 'human_interview') {
      const enter = item.humanInterview?.enterable
        ? '<button type="button" class="btn btn-primary" data-enter-human>进入面试房间</button>' : '';
      return enter + records + '<a class="btn btn-ghost" href="apply.html">继续投递其他岗位</a>';
    }
    return '<a class="btn btn-primary" href="apply.html">继续投递其他岗位</a>' + records;
  }

  async function drawStatusUpload(panel) {
    let jobs = [];
    try { jobs = (await api('/api/jobs', {}, false)).items || []; } catch (_) { jobs = []; }
    panel.innerHTML = '<section class="card status-card status-card-upload">'
      + '<header class="status-head"><span class="status-stage">阶段 1</span>'
      + '<div><h2>发送简历</h2><p>还没有申请记录，选择岗位并上传简历开始。</p></div></header>'
      + '<form id="status-upload-form" class="status-upload">'
      + '<label class="status-field" for="status-job"><span>目标岗位</span><select id="status-job" class="recruit-input" required><option value="">请选择已发布的岗位</option>'
      + jobs.map((job) => '<option value="' + esc(job.id) + '">' + esc(job.title) + ' · ' + esc(job.companyName || '招聘企业') + '</option>').join('')
      + '</select></label>'
      + '<input id="status-resume" type="file" class="sr-only" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document">'
      + '<button id="status-zone" type="button" class="recruit-dropzone"><span class="recruit-upload-icon" aria-hidden="true">↑</span><strong>拖拽文件到这里，或点击选择</strong><small>PDF / DOCX · 不超过 8 MB</small></button>'
      + '<div id="status-file" class="recruit-file hidden"></div>'
      + '<label class="recruit-check"><input id="status-consent" type="checkbox"><span>我同意将简历和初筛资料用于所投递岗位的招聘评估，并按授权提供给对应企业。</span></label>'
      + '<p id="status-upload-error" class="inline-error hidden" role="alert"></p>'
      + '<div class="status-actions"><button id="status-submit" class="btn btn-primary" type="submit">提交简历</button>'
      + '<a class="btn btn-ghost" href="apply.html">去投递页看岗位详情</a></div></form></section>';

    let resume = null;
    const input = byId('status-resume');
    const zone = byId('status-zone');
    const showPicked = () => {
      byId('status-file').classList.toggle('hidden', !resume);
      if (resume) {
        byId('status-file').innerHTML = '<span aria-hidden="true">▤</span><span><strong>' + esc(resume.name) + '</strong><small>'
          + Math.ceil(resume.size / 1024) + ' KB</small></span><button id="status-remove" type="button" aria-label="移除简历">移除</button>';
        byId('status-remove').onclick = () => { resume = null; input.value = ''; showPicked(); };
      }
      zone.classList.toggle('hidden', Boolean(resume));
    };
    const choose = (file) => {
      if (!file) return;
      const issue = !/\.(pdf|docx)$/i.test(file.name) ? '仅支持 PDF 或 DOCX 格式。'
        : file.size === 0 ? '文件为空，请重新选择。'
        : file.size > maxResumeBytes ? '简历不能超过 8 MB。' : '';
      if (issue) { showError('status-upload-error', issue); return; }
      resume = file;
      showError('status-upload-error', '');
      showPicked();
    };
    zone.onclick = () => input.click();
    input.onchange = () => { choose(input.files[0]); input.value = ''; };
    zone.ondragover = (event) => { event.preventDefault(); zone.classList.add('dragging'); };
    zone.ondragleave = () => zone.classList.remove('dragging');
    zone.ondrop = (event) => { event.preventDefault(); zone.classList.remove('dragging'); choose(event.dataTransfer.files[0]); };

    byId('status-upload-form').onsubmit = async (event) => {
      event.preventDefault();
      const account = auth();
      if (!account) { showError('status-upload-error', '登录已失效，请重新登录后再提交。'); return; }
      if (!byId('status-job').value) { showError('status-upload-error', '请选择目标岗位。'); return; }
      if (!resume) { showError('status-upload-error', '请上传 PDF 或 DOCX 简历。'); return; }
      if (!byId('status-consent').checked) { showError('status-upload-error', '请先确认招聘评估资料的使用说明。'); return; }
      const button = byId('status-submit');
      button.disabled = true;
      button.textContent = '正在提交…';
      showError('status-upload-error', '');
      try {
        const body = new FormData();
        body.append('resume', resume);
        body.append('jobId', byId('status-job').value);
        body.append('consent', 'true');
        body.append('verifyLinks', 'false');
        const response = await fetch('/api/applications', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + account.token },
          body,
        });
        if (!response.ok) throw new Error(await readError(response));
        const result = await response.json();
        panel.innerHTML = '<section class="card status-card"><header class="status-head"><span class="status-stage">阶段 1</span>'
          + '<div><h2>简历已提交</h2><p>' + esc(result.application?.jobTitle || '目标岗位') + '</p></div></header>'
          + '<p class="status-desc">企业审核后会在这里更新下一步。</p>'
          + '<div class="status-actions"><a class="btn btn-primary" href="status.html">查看我的状态</a>'
          + '<a class="btn btn-ghost" href="applications.html">申请记录</a></div></section>';
      } catch (error) {
        showError('status-upload-error', error.message || '提交失败，请稍后重试。');
        button.disabled = false;
        button.textContent = '提交简历';
      }
    };
  }

  if (page === 'status') renderStatus();
  else if (page === 'account') renderAccount();
  else if (page === 'apply') renderApply();
  else if (page === 'applications') renderApplications();
})();
