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
    app.innerHTML = '<section class="recruit-submitted"><span class="recruit-done" aria-hidden="true">✓</span><span class="eyebrow">申请已创建</span><h1>简历已提交</h1><p>你的资料已进入招聘流程，后续通知将在这里更新。</p><div class="recruit-submitted-meta"><span>目标岗位</span><strong>' + esc(application.jobTitle) + '</strong><span>当前状态</span><strong>' + esc(statusLabel(application.status)) + '</strong></div><a class="btn btn-primary" href="applications.html">查看申请进度</a></section>';
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

  if (page === 'account') renderAccount();
  else if (page === 'apply') renderApply();
  else if (page === 'applications') renderApplications();
})();
