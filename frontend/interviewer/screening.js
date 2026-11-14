/* TTC company recruitment workspace. Interview pages remain in app.js. */
(function () {
  'use strict';
  const app = document.getElementById('screen-app');
  const core = window.TTCWorkspace;
  const authKey = 'ttc.recruitment.hr.auth';
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const byId = (id) => document.getElementById(id);
  let entries = [];
  let jobs = [];
  let sourceCounts = {total:0,candidatePortal:0,hrImport:0};
  let listView = 'cards';
  let listPage = 1;
  const pageSize = 6;
  let demoMode = false;
  let detailPoll = null;
  let verificationPoll = null;
  let detailProgressState = null;
  let detailProgressAbort = null;
  let attachmentPreviewUrl = null;

  function auth() {
    try {
      const value = JSON.parse(localStorage.getItem(authKey) || 'null');
      return value && typeof value.token === 'string' && value.user?.role === 'hr' ? value : null;
    } catch (_) { return null; }
  }
  function saveAuth(value) { localStorage.setItem(authKey, JSON.stringify(value)); }
  function showError(id, message) { const node = byId(id); if (node) { node.textContent = message || ''; node.classList.toggle('screen-hidden', !message); } }
  async function readError(response) {
    try {
      const data = await response.json();
      const message = typeof data.detail === 'string' ? data.detail : typeof data.error === 'string' ? data.error : '';
      if (message && message !== 'Not Found') return message.slice(0, 220);
    } catch (_) { /* Keep generic message. */ }
    if (response.status === 401) return '登录已失效，请重新登录。';
    if (response.status === 403) return '当前账号没有该企业的访问权限。';
    if (response.status === 404) return '请求的记录或功能尚不存在，请刷新页面或联系管理员。';
    return '请求未完成，请稍后重试。';
  }
  async function api(path, options, signed) {
    const headers = new Headers(options?.headers || {});
    if (signed !== false) {
      const current = auth();
      if (!current) throw new Error('请先登录企业账户。');
      headers.set('Authorization', 'Bearer ' + current.token);
    }
    if (options?.body && !(options.body instanceof FormData)) headers.set('Content-Type','application/json');
    let response;
    try { response = await fetch(path,{...options,headers,cache:'no-store'}); }
    catch (_) { throw new Error('无法连接招聘服务，请检查网络。'); }
    if (!response.ok) throw new Error(await readError(response));
    return response.status === 204 ? null : response.json();
  }
  async function readSse(response, onEvent) {
    if (!response.body) throw new Error('服务未返回实时数据流。');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const consume = () => {
      buffer = buffer.replace(/\r\n/g, '\n');
      let split;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, split); buffer = buffer.slice(split + 2);
        let kind = 'message', data = '';
        block.split('\n').forEach((line) => {
          if (line.startsWith('event:')) kind = line.slice(6).trim();
          if (line.startsWith('data:')) data += line.slice(5).trim();
        });
        if (data) onEvent(kind, JSON.parse(data));
      }
    };
    try {
      while (true) {
        const {value, done} = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, {stream:true}); consume();
      }
      buffer += decoder.decode(); consume();
    } finally { reader.releaseLock(); }
  }
  function dateLabel(value) {
    const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
    return isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
  }
  function dateISO(value) {
    const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
    if (isNaN(date.getTime())) return '';
    const part = (number) => String(number).padStart(2,'0');
    return date.getFullYear() + '-' + part(date.getMonth() + 1) + '-' + part(date.getDate());
  }
  function statusLabel(value) { return ({submitted:'已提交',parsing:'解析中',screening:'初筛中',hr_review:'待 HR 审核',ai_interview_invited:'已邀 AI 辅助初面',ai_interview_in_progress:'AI 辅助初面中',ai_interview_completed:'AI 辅助初面完成',hr_interview_invited:'已邀企业复试',closed:'已结束',failed:'处理异常'})[value] || '待处理'; }
  function recommendationLabel(value) { return ({invite:'建议邀请 AI 辅助初面',invite_interview:'建议邀请 AI 辅助初面',invite_ai_interview:'建议邀请 AI 辅助初面',manual_review:'建议 HR 审核',insufficient_evidence:'匹配证据不足'})[value] || '待初筛'; }
  function processLabel(value) { return ({queued:'排队中',parsing:'解析中',parsed:'解析完成',screening:'初筛中',completed:'已完成',failed:'处理失败',skipped:'已跳过'})[value] || value || '待处理'; }
  function sourceLabel(value) { return value === 'hr_import' ? '企业录入' : '个人投递'; }
  function safeUrl(value) { try { const url = new URL(value); return ['https:','http:'].includes(url.protocol) ? url.href : ''; } catch (_) { return ''; } }
  function listStrings(values, empty) { return Array.isArray(values) && values.length ? '<ul>' + values.map((item) => '<li>' + esc(typeof item === 'string' ? item : item?.text || item?.requirement || JSON.stringify(item)) + '</li>').join('') + '</ul>' : '<p class="screen-empty-copy">' + esc(empty || '尚无资料') + '</p>'; }
  function reviewStatus(value) {
    const decision = value?.decision || value?.status || value;
    return ({invite:'已邀请',verify:'待进一步核验',hold:'暂缓',pending:'待审核'})[decision] || '待审核';
  }
  function scoreOf(item) { const value = item.matchScore ?? item.score ?? item.jobMatchScore ?? item.screening?.jobMatch?.score ?? item.screening?.report?.jobMatch?.score; return typeof value === 'number' && value >= 0 && value <= 100 ? Math.round(value) + '/100' : '证据不足'; }
  function listScoreOf(item) {
    if (typeof item.weightedScore === 'number') return item.weightedScore.toFixed(1) + ' / 100';
    if (item.profileVersion) return '待补充多维评分';
    return typeof item.matchScore === 'number' ? '旧版 ' + Math.round(item.matchScore) + ' / 100' : '待补充评估';
  }
  function reportOf(item) { return item.screening?.report || item.screening || null; }
  function updateAccount() {
    const view = new URLSearchParams(location.search).get('view');
    const active = view === 'architect' || view === 'talent' ? '' : 'resumes';
    core.mountNav(active);
    const first = document.querySelector('#workspace-nav .nav-links a');
    if (first) first.insertAdjacentHTML('afterend',
      '<a href="screening.html?view=architect"' + (view === 'architect' ? ' class="active" aria-current="page"' : '') + '>招聘需求顾问</a>'
      + '<a href="screening.html?view=talent"' + (view === 'talent' ? ' class="active" aria-current="page"' : '') + '>人才库</a>');
  }
  function renderAuth() {
    updateAccount();
    let mode = 'login';
    const draw = () => {
      app.innerHTML = '<div class="screen-auth-layout"><div class="screen-auth-copy"><span class="eyebrow">简历初筛工作台</span><h1>让每一次审核，<br>都有清楚依据。</h1><p>查看岗位匹配证据、核实重点和 AI 辅助初面建议；最终招聘决定由企业人员作出。</p></div><section class="card screen-auth-card"><div class="screen-tabs"><button id="screen-login" type="button" class="' + (mode === 'login' ? 'active' : '') + '">登录</button><button id="screen-register" type="button" class="' + (mode === 'register' ? 'active' : '') + '">创建企业账户</button></div><h2>' + (mode === 'login' ? '登录工作台' : '创建企业账户') + '</h2><form id="screen-auth-form">'
        + (mode === 'register' ? '<label for="screen-name">姓名</label><input id="screen-name" class="input" maxlength="80" autocomplete="name" required placeholder="招聘人员姓名"><label for="screen-company">企业名称</label><input id="screen-company" class="input" maxlength="120" required placeholder="企业名称">' : '')
        + '<label for="screen-email">邮箱</label><input id="screen-email" class="input" type="email" autocomplete="email" required placeholder="name@company.com"><label for="screen-password">密码</label><input id="screen-password" class="input" type="password" autocomplete="' + (mode === 'login' ? 'current-password' : 'new-password') + '" minlength="10" required placeholder="至少 10 位">'
        + (mode === 'register' ? '<label for="screen-code">企业注册授权码</label><input id="screen-code" class="input" type="password" required autocomplete="off" placeholder="由平台管理员提供"><p class="screen-hint">授权码用于限制企业账户注册；请勿发送给候选人。</p>' : '')
        + '<p id="screen-auth-error" class="screen-error screen-hidden" role="alert"></p><button id="screen-auth-submit" type="submit" class="btn btn-primary">' + (mode === 'login' ? '登录工作台' : '创建账户') + '</button></form></section></div>';
      byId('screen-login').onclick = () => { mode = 'login'; draw(); };
      byId('screen-register').onclick = () => { mode = 'register'; draw(); };
      byId('screen-auth-form').onsubmit = async (event) => {
        event.preventDefault();
        const button = byId('screen-auth-submit');
        button.disabled = true; button.textContent = '正在处理…'; showError('screen-auth-error','');
        try {
          const payload = {email:byId('screen-email').value.trim(),password:byId('screen-password').value};
          if (mode === 'register') Object.assign(payload,{name:byId('screen-name').value.trim(),role:'hr',companyName:byId('screen-company').value.trim(),hrRegistrationCode:byId('screen-code').value});
          const result = await api('/api/auth/' + mode,{method:'POST',body:JSON.stringify(payload)},false);
          if (!result || typeof result.token !== 'string' || result.user?.role !== 'hr') throw new Error('请使用企业招聘人员账户登录。');
          saveAuth(result); renderWorkspace();
        } catch (error) { showError('screen-auth-error',error.message || '无法完成登录。'); }
        finally { button.disabled = false; button.textContent = mode === 'login' ? '登录工作台' : '创建账户'; }
      };
    };
    draw();
  }
  function renderWorkspace() {
    updateAccount();
    const params = new URLSearchParams(location.search);
    const id = params.get('id');
    const view = params.get('view');
    const activeView = id || view === 'review' ? 'screening' : (view === 'architect' || view === 'talent' ? view : 'screening');
    document.title = (view === 'review' ? '入围候选人审核' : activeView === 'architect' ? '招聘需求顾问' : activeView === 'talent' ? '人才库' : '简历初筛') + ' · 天镜';
    document.querySelectorAll('[data-screen-nav]').forEach((link) => {
      const selected = link.dataset.screenNav === activeView;
      link.classList.toggle('active', selected);
      if (selected) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current');
    });
    if (id) renderDetail(id);
    else if (view === 'architect') renderArchitect(params);
    else if (view === 'talent') renderTalent();
    else if (view === 'review' && params.get('batchId')) renderReview(params.get('batchId'));
    else renderList();
  }

  function profileHtml(profile, version) {
    if (!profile || typeof profile !== 'object') return '<p class="screen-empty-copy">对话达到足够信息后，招聘标准会显示在这里。</p>';
    const pick = (...names) => names.map((name) => profile[name]).find((value) => value !== undefined && value !== null);
    const plain = (value) => {
      if (typeof value === 'string' || typeof value === 'number') return String(value);
      if (Array.isArray(value)) return value.map(plain).filter(Boolean).join('；');
      if (value && typeof value === 'object') return Object.entries(value).map(([key, entry]) => key + '：' + plain(entry)).join('；');
      return '';
    };
    const sections = [
      ['招聘场景',({campus:'校园招聘',social:'社会招聘',mixed:'校招与社招'})[pick('recruitmentType','recruitment_type','hiringType','hiring_type')] || pick('recruitmentType','recruitment_type','hiringType','hiring_type')],
      ['招聘需求',pick('summary')],
      ['业务背景',pick('businessContext','business_context')],
      ['核心职责',pick('responsibilities','coreResponsibilities','core_responsibilities')],
      ['入职成果',pick('expectedOutcomes','expected_outcomes')],
      ['必备能力',pick('requiredCapabilities','required_capabilities','mustHaveCapabilities','must_have_capabilities','coreCapabilities','core_capabilities')],
      ['可培养能力',pick('trainableCapabilities','trainable_capabilities')],
      ['加分能力',pick('bonusCapabilities','bonus_capabilities')],
      ['必要条件',pick('hardConstraints','hard_constraints')],
      ['替代经验',pick('alternativeExperience','alternative_experience')],
      ['建议权重',pick('weights','capabilityWeights','capability_weights')],
      ['简历证据',pick('resumeEvidence','resume_evidence')],
      ['公开核查',pick('publicVerificationTargets','public_verification_targets','onlineVerification','online_verification')],
      ['面试验证',pick('interviewVerification','interview_verification')],
      ['待确认',pick('unresolvedConditions','unresolved_conditions')]
    ].filter(([,value]) => plain(value));
    return '<div class="screen-profile-title"><strong>' + esc(plain(pick('jobName','title','jobTitle','job_title','name')) || '岗位招聘标准') + '</strong>' + (version ? '<span class="screen-state">第 ' + esc(version) + ' 版</span>' : '') + '</div>'
      + (sections.length ? '<dl class="screen-criteria-list">' + sections.map(([label,value]) => '<div><dt>' + esc(label) + '</dt><dd>' + esc(plain(value)) + '</dd></div>').join('') + '</dl>' : '<p class="screen-empty-copy">标准已生成；请在对话中继续补充岗位职责和可验证的能力要求。</p>');
  }

  async function renderArchitect(params) {
    const initialJobId = params.get('jobId') || '';
    const initialSessionId = params.get('sessionId') || '';
    let session = null;
    let selectedJobId = initialJobId;
    let savedProfile = null;
    app.innerHTML = '<div class="screen-heading"><div><span class="eyebrow">企业端 · 招聘流程</span><h1>招聘需求顾问</h1><p>直接说你想解决的业务问题，顾问会只追问影响筛选结论的关键条件。</p></div><a class="btn btn-ghost" href="screening.html">返回简历初筛</a></div>'
      + '<div class="screen-architect-grid"><section class="card screen-architect-chat" aria-label="招聘需求对话"><div class="screen-architect-top"><div><h2>需求对话</h2><p>请用自己的话描述岗位；不必先写完整 JD。</p></div><label for="architect-job">关联已有岗位<select id="architect-job" class="input"><option value="">新招聘任务</option></select></label></div><div id="architect-messages" class="screen-architect-messages" role="log" aria-live="polite"></div><form id="architect-form" class="screen-architect-compose"><label for="architect-message">发消息给招聘顾问</label><textarea id="architect-message" class="input" rows="3" maxlength="4000" required placeholder="例如：我想招一个能独立推进市场活动、能和销售团队配合的人"></textarea><div class="screen-architect-compose-foot"><span>Enter 发送，Shift + Enter 换行</span><button id="architect-send" type="submit" class="btn btn-primary">发送消息</button></div><p id="architect-error" class="screen-error screen-hidden" role="alert"></p></form></section><aside class="card screen-architect-profile" aria-label="招聘标准"><div class="screen-panel-heading"><h2>招聘标准</h2><span id="architect-stage" class="screen-state">待澄清</span></div><p id="architect-profile-context" class="screen-panel-lead">AI 的建议须经 HR 确认后才用于简历匹配。</p><div id="architect-profile-body"></div><div id="architect-profile-actions" class="screen-form-actions"></div></aside></div>';
    const layout = app.querySelector('.screen-architect-grid');
    const profileDialog = document.createElement('dialog');
    profileDialog.className = 'screen-profile-dialog screen-architect-profile-dialog';
    profileDialog.innerHTML = '<div class="screen-form-actions"><button id="architect-profile-close" type="button" class="btn btn-ghost btn-sm">关闭标准</button></div>';
    const profilePanel = layout.querySelector('.screen-architect-profile');
    profilePanel.classList.remove('card');
    profileDialog.append(profilePanel);
    layout.after(profileDialog);
    const toolbar = document.createElement('div');
    toolbar.className = 'screen-architect-toolbar';
    toolbar.innerHTML = '<button type="button" id="architect-history-toggle" class="btn btn-ghost">历史招聘需求</button><div><button type="button" id="architect-new" class="btn btn-ghost">创建新会话</button> <button type="button" id="architect-profile-open" class="btn btn-primary">查看招聘标准</button></div>';
    const historyPanel = document.createElement('section');
    historyPanel.className = 'screen-architect-history screen-hidden';
    historyPanel.id = 'architect-history';
    layout.before(toolbar, historyPanel);
    byId('architect-profile-open').onclick = () => profileDialog.showModal();
    byId('architect-profile-close').onclick = () => profileDialog.close();
    profileDialog.addEventListener('click', (event) => { if (event.target === profileDialog) profileDialog.close(); });
    byId('architect-history-toggle').onclick = () => historyPanel.classList.toggle('screen-hidden');
    byId('architect-new').onclick = () => location.assign('screening.html?view=architect' + (selectedJobId ? '&jobId=' + encodeURIComponent(selectedJobId) : ''));
    const jobSelect = byId('architect-job');
    const messageInput = byId('architect-message');
    const messagesNode = byId('architect-messages');
    let pendingMessage = null;
    let streamingText = '';
    let waitingForReply = false;
    const draw = () => {
      const messages = Array.isArray(session?.messages) ? [...session.messages] : [];
      if (pendingMessage && !messages.some((entry) => entry.id === pendingMessage.id)) messages.push(pendingMessage);
      messagesNode.innerHTML = (messages.length ? messages.map((entry) => '<article class="screen-chat-turn ' + (entry.role === 'user' ? 'screen-chat-user' : 'screen-chat-assistant') + '" data-status="' + esc(entry.deliveryStatus || '') + '"><span>' + (entry.role === 'user' ? '你' : '招聘顾问') + (entry.deliveryStatus === 'failed' ? ' · 发送失败' : '') + '</span><p>' + esc(entry.content || '') + '</p>' + (entry.role === 'user' && entry.deliveryStatus === 'failed' ? '<button type="button" class="btn btn-ghost btn-sm screen-chat-retry" data-retry-message="' + esc(entry.id || 'local') + '">重试发送</button>' : '') + '</article>').join('') : '<p class="screen-architect-empty">先说说你要招什么人、希望他解决什么问题。对话内容会保存在企业工作台。</p>') + (waitingForReply ? '<article class="screen-chat-turn screen-chat-assistant"><span>招聘顾问 · ' + (streamingText ? '正在回复' : '正在思考') + '</span><p>' + esc(streamingText || '正在分析岗位要求…') + '</p></article>' : '');
      messagesNode.querySelectorAll('[data-retry-message]').forEach((button) => { button.onclick = () => { const entry = messages.find((value) => (value.id || 'local') === button.dataset.retryMessage); if (entry) sendArchitectMessage(entry.content, entry.id === 'local' ? null : entry.id); }; });
      messagesNode.scrollTop = messagesNode.scrollHeight;
      const confirmed = session?.confirmedProfile || savedProfile?.profile;
      const draft = session?.stage === 'draft' ? session.draftProfile : null;
      const profile = draft || confirmed;
      const version = session?.version || savedProfile?.version;
      byId('architect-stage').textContent = session?.stage === 'confirmed' || (!session && confirmed) ? '已确认' : draft ? '待确认' : confirmed ? '修订中' : '待澄清';
      byId('architect-profile-open').textContent = draft ? '查看并确认招聘标准' : '查看招聘标准';
      byId('architect-profile-body').innerHTML = profileHtml(profile, version);
      const actions = byId('architect-profile-actions');
      actions.innerHTML = draft && session?.stage === 'draft' ? '<button id="architect-confirm" type="button" class="btn btn-primary">确认并保存标准</button>' : confirmed ? '<span class="screen-success">已保存，可继续在对话中提出修改。</span>' : '';
      byId('architect-profile-context').textContent = draft ? '请核对 AI 的建议。不准确的条件可直接在对话中修改，确认后才用于简历匹配。' : confirmed ? '已确认的标准有版本记录；后续修改会形成新版。' : 'AI 的建议须经 HR 确认后才用于简历匹配。';
      if (byId('architect-confirm')) byId('architect-confirm').onclick = confirmProfile;
    };
    const updateAddress = () => {
      const url = new URL(location.href);
      if (session?.id) url.searchParams.set('sessionId',session.id);
      if (session?.jobId) url.searchParams.set('jobId',session.jobId);
      history.replaceState(null,'',url.pathname + url.search);
    };
    const loadSavedProfile = async () => {
      savedProfile = null;
      if (!selectedJobId) { draw(); return; }
      try { savedProfile = await api('/api/hr/jobs/' + encodeURIComponent(selectedJobId) + '/profile'); }
      catch (_) { /* An unconfirmed job has no saved profile yet. */ }
      draw();
    };
    const refreshJobOptions = async () => {
      const result = await api('/api/hr/jobs');
      const availableJobs = Array.isArray(result.items) ? result.items : [];
      jobSelect.innerHTML = '<option value="">新招聘任务</option>' + availableJobs.map((job) => '<option value="' + esc(job.id) + '">' + esc(job.title) + '</option>').join('');
      jobSelect.value = selectedJobId;
    };
    const loadHistory = async () => {
      try {
        const result = await api('/api/hr/architect/sessions?limit=50&offset=0');
        const items = Array.isArray(result.items) ? result.items : [];
        historyPanel.innerHTML = items.length ? items.map((entry) => '<a href="screening.html?view=architect&sessionId=' + encodeURIComponent(entry.id) + '"><strong>' + esc(entry.jobTitle || '新招聘需求') + '</strong> · 第 ' + esc(entry.version || 0) + ' 版 · ' + esc(dateLabel(entry.updatedAt)) + '<br>' + esc(entry.preview || '尚无对话') + '</a>').join('') : '<p class="screen-empty-copy">暂无历史会话。开始聊天后会自动保存。</p>';
      } catch (error) { historyPanel.textContent = error.message || '无法读取历史会话。'; }
    };
    const confirmProfile = async () => {
      const button = byId('architect-confirm');
      if (!button || !session?.draftProfile) return;
      button.disabled = true; button.textContent = '正在保存…'; showError('architect-error','');
      try {
        session = await api('/api/hr/architect/sessions/' + encodeURIComponent(session.id) + '/confirm',{method:'POST',body:JSON.stringify({})});
        selectedJobId = session.jobId || selectedJobId;
        if (selectedJobId) { await refreshJobOptions(); await loadSavedProfile(); }
        updateAddress(); draw();
      } catch (error) { showError('architect-error',error.message || '无法确认标准。'); button.disabled = false; button.textContent = '确认并保存标准'; }
    };
    jobSelect.onchange = () => {
      const url = new URL(location.href);
      url.searchParams.delete('sessionId');
      if (jobSelect.value) url.searchParams.set('jobId',jobSelect.value); else url.searchParams.delete('jobId');
      location.assign(url.pathname + url.search);
    };
    messageInput.onkeydown = (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); byId('architect-form').requestSubmit(); } };
    const sendArchitectMessage = async (message, retryMessageId = null) => {
      if (waitingForReply) return;
      const button = byId('architect-send');
      button.disabled = true; button.textContent = '顾问回复中…'; showError('architect-error','');
      waitingForReply = true; streamingText = '';
      if (retryMessageId && session?.messages) {
        const existing = session.messages.find((entry) => entry.id === retryMessageId);
        if (existing) existing.deliveryStatus = 'pending';
      }
      draw();
      try {
        if (!session) {
          session = await api('/api/hr/architect/sessions',{method:'POST',body:JSON.stringify(selectedJobId ? {jobId:selectedJobId} : {})});
          updateAddress();
        }
        const response = await fetch('/api/hr/architect/sessions/' + encodeURIComponent(session.id) + '/messages/stream', {
          method:'POST', headers:{Authorization:'Bearer ' + auth().token,'Content-Type':'application/json'},
          body:JSON.stringify(retryMessageId ? {message,retryMessageId} : {message}), cache:'no-store'
        });
        if (!response.ok) throw new Error(await readError(response));
        let finalSession = null;
        await readSse(response,(kind,data) => {
          if (kind === 'started' && pendingMessage) pendingMessage.id = data.messageId || pendingMessage.id;
          if (kind === 'delta') { streamingText += data.text || ''; draw(); }
          if (kind === 'completed') finalSession = data.session;
          if (kind === 'error') throw new Error(data.message || '顾问回复失败。');
        });
        if (!finalSession) throw new Error('顾问回复中断，请重试。');
        session = finalSession; pendingMessage = null; waitingForReply = false; streamingText = '';
        selectedJobId = session.jobId || selectedJobId;
        updateAddress(); draw(); await loadHistory();
        if (selectedJobId) { await refreshJobOptions(); await loadSavedProfile(); }
      } catch (error) {
        if (session?.id) {
          try {
            session = await api('/api/hr/architect/sessions/' + encodeURIComponent(session.id));
            if (pendingMessage && session.messages?.some((entry) => entry.id === pendingMessage.id)) pendingMessage = null;
          } catch (_) { /* The unsent message remains visible for retry. */ }
        }
        if (pendingMessage) pendingMessage.deliveryStatus = 'failed';
        waitingForReply = false; streamingText = ''; draw();
        showError('architect-error',error.message || '顾问暂时不可用，可点击原消息重试。');
      } finally { button.disabled = false; button.textContent = '发送消息'; messageInput.focus(); }
    };
    byId('architect-form').onsubmit = (event) => {
      event.preventDefault();
      const message = messageInput.value.trim();
      if (!message || waitingForReply) return;
      messageInput.value = '';
      pendingMessage = {id:'local',role:'user',content:message,deliveryStatus:'pending'};
      draw(); sendArchitectMessage(message);
    };
    try { await refreshJobOptions(); }
    catch (error) { showError('architect-error',error.message || '无法读取岗位列表。'); }
    if (initialSessionId) {
      try { session = await api('/api/hr/architect/sessions/' + encodeURIComponent(initialSessionId)); selectedJobId = session.jobId || selectedJobId; jobSelect.value = selectedJobId; updateAddress(); }
      catch (error) { showError('architect-error',error.message || '无法恢复对话。'); }
    }
    await loadSavedProfile(); await loadHistory(); draw();
  }

  async function renderTalent() {
    app.innerHTML = '<div class="screen-heading"><div><span class="eyebrow">企业端 · 招聘流程</span><h1>人才库</h1><p>保留暂不匹配的人才，按新岗位重新评估；历史岗位结论分别留存。</p></div><a href="screening.html" class="btn btn-ghost">返回简历初筛</a></div>'
      + '<form id="talent-search-form" class="screen-talent-filters"><label for="talent-query">搜索候选人<input id="talent-query" class="input" type="search" maxlength="120" placeholder="姓名或岗位关键词"></label><label for="talent-status">人才库状态<select id="talent-status" class="input"><option value="active">在库候选人</option><option value="archived">已归档</option><option value="all">全部</option></select></label><button class="btn btn-primary" type="submit">搜索</button></form><p id="talent-error" class="screen-error screen-hidden" role="alert"></p><p id="talent-notice" class="screen-success screen-hidden" role="status"></p><div id="talent-results" class="screen-talent-results"><p class="screen-empty-copy">正在读取人才库…</p></div>';
    let availableJobs = [];
    try {
      const result = await api('/api/hr/jobs');
      availableJobs = Array.isArray(result.items) ? result.items : [];
    } catch (error) { showError('talent-error',error.message || '无法读取岗位，重新匹配暂不可用。'); }
    const draw = (items) => {
      const target = byId('talent-results');
      if (!Array.isArray(items) || !items.length) { target.innerHTML = '<div class="card screen-talent-empty">当前条件下没有候选人。可在简历详情中暂缓申请后再查看。</div>'; return; }
      target.innerHTML = items.map((item, index) => {
        const id = item.candidateId || item.id;
        const name = item.name || item.candidateName || '候选人';
        const status = item.status || 'active';
        const details = item.summary || item.candidateSummary || item.education || '';
        const assessments = Array.isArray(item.assessments) ? item.assessments : [];
        const applicationId = item.applicationId || item.latestApplicationId;
        return '<article class="card screen-talent-card" data-talent-card="' + index + '"><div class="screen-talent-card-head"><div><h2>' + esc(name) + '</h2><p>' + esc(details) + '</p></div><span class="screen-state">' + esc(status === 'archived' ? '已归档' : '在人才库') + '</span></div>'
          + (assessments.length ? '<div class="screen-talent-assessments">' + assessments.map((assessment) => '<span>' + esc(assessment.jobTitle || '岗位') + ' · 标准第 ' + esc(assessment.profileVersion || '—') + ' 版 · ' + esc(assessment.matchScore == null ? '待评估' : assessment.matchScore + '/100') + '</span>').join('') + '</div>' : '<p class="screen-empty-copy">暂无跨岗位评估记录。</p>')
          + '<div class="screen-talent-actions"><label>新目标岗位<select class="input" data-talent-job><option value="">请选择岗位</option>' + availableJobs.map((job) => '<option value="' + esc(job.id) + '">' + esc(job.title) + '</option>').join('') + '</select></label><button class="btn btn-primary btn-sm" data-talent-rematch="' + esc(id) + '" type="button"' + (!availableJobs.length || status === 'archived' ? ' disabled' : '') + '>重新匹配</button>' + (applicationId ? '<a class="btn btn-ghost btn-sm" href="screening.html?id=' + encodeURIComponent(applicationId) + '">查看详情</a>' : '') + '<button class="btn btn-ghost btn-sm" data-talent-status="' + esc(id) + '" data-next-status="' + (status === 'archived' ? 'active' : 'archived') + '" type="button">' + (status === 'archived' ? '重新入库' : '移入归档') + '</button><button class="btn btn-ghost btn-sm" data-talent-delete="' + esc(id) + '" type="button">移出人才库</button></div></article>';
      }).join('');
      target.querySelectorAll('[data-talent-rematch]').forEach((button) => {
        button.onclick = async () => {
          const jobId = button.closest('[data-talent-card]').querySelector('[data-talent-job]').value;
          if (!jobId) { showError('talent-error','请先选择重新匹配的目标岗位。'); return; }
          button.disabled = true; button.textContent = '分析中…'; showError('talent-error','');
          try {
            await api('/api/hr/talent/' + encodeURIComponent(button.dataset.talentRematch) + '/rematch',{method:'POST',body:JSON.stringify({jobId})});
            byId('talent-notice').textContent = '已提交重新匹配；结果完成后会显示在人才库。';
            byId('talent-notice').classList.remove('screen-hidden');
            await load();
          } catch (error) { showError('talent-error',error.message || '重新匹配失败。'); }
          finally { button.disabled = false; button.textContent = '重新匹配'; }
        };
      });
      target.querySelectorAll('[data-talent-delete]').forEach((button) => {
        button.onclick = async () => {
          if (!window.confirm('确定将这名候选人移出人才库？原申请和简历仍会保留。')) return;
          button.disabled = true; showError('talent-error','');
          try {
            await api('/api/hr/talent/' + encodeURIComponent(button.dataset.talentDelete),{method:'DELETE'});
            byId('talent-notice').textContent = '已移出人才库。';
            byId('talent-notice').classList.remove('screen-hidden');
            await load();
          } catch (error) { showError('talent-error',error.message || '删除失败。'); button.disabled = false; }
        };
      });
      target.querySelectorAll('[data-talent-status]').forEach((button) => {
        button.onclick = async () => {
          button.disabled = true; showError('talent-error','');
          const nextStatus = button.dataset.nextStatus;
          try {
            await api('/api/hr/talent/' + encodeURIComponent(button.dataset.talentStatus),{method:'PATCH',body:JSON.stringify({status:nextStatus})});
            byId('talent-notice').textContent = nextStatus === 'archived' ? '已移入归档。' : '已重新加入人才库。';
            byId('talent-notice').classList.remove('screen-hidden');
            await load();
          } catch (error) { showError('talent-error',error.message || '更新状态失败。'); button.disabled = false; }
        };
      });
    };
    const load = async () => {
      const query = byId('talent-query').value.trim();
      const status = byId('talent-status').value;
      const params = new URLSearchParams();
      if (query) params.set('query',query);
      if (status) params.set('status',status);
      try {
        const result = await api('/api/hr/talent' + (params.size ? '?' + params : ''));
        showError('talent-error',''); draw(Array.isArray(result?.items) ? result.items : []);
      } catch (error) { showError('talent-error',error.message || '无法读取人才库。'); byId('talent-results').innerHTML = ''; }
    };
    byId('talent-search-form').onsubmit = (event) => { event.preventDefault(); load(); };
    byId('talent-status').onchange = load;
    await load();
  }

  function renderList() {
    app.innerHTML = '<div class="screen-heading"><div><span class="eyebrow">企业端 · 招聘流程</span><h1>简历初筛</h1><p>批量拖入 PDF 或一人一包的 ZIP，自动识别简历并关联佐证材料。</p></div><div class="screen-heading-actions"><button id="screen-new-import" class="btn btn-primary" type="button">批量导入简历</button><a href="screening.html?view=architect" class="btn btn-ghost">与 AI 明确需求</a><button id="screen-new-job" class="btn btn-ghost" type="button">发布岗位</button></div></div>'
      + '<form id="screen-job-form" class="card screen-job-form screen-hidden"><h2>发布招聘岗位</h2><p>岗位说明将作为简历初筛和后续面试的依据。</p><label for="new-job-title">岗位名称</label><input id="new-job-title" class="input" required maxlength="120" placeholder="例如：后端开发工程师"><label for="new-job-description">岗位职责与必备要求</label><textarea id="new-job-description" class="input" required minlength="30" maxlength="8000" rows="6" placeholder="写明职责、必备技能和经验要求，至少 30 字"></textarea><p id="screen-job-error" class="screen-error screen-hidden" role="alert"></p><div class="screen-form-actions"><button class="btn btn-primary" type="submit" id="screen-job-submit">发布岗位</button><button class="btn btn-ghost" type="button" id="screen-job-cancel">取消</button></div></form>'
      + '<dialog id="screen-import-dialog" class="screen-import-dialog" aria-labelledby="screen-import-title"><div class="screen-import-heading"><div><h2 id="screen-import-title">批量导入简历</h2><p>选择一个目标岗位，再上传 PDF 或一人一包的 ZIP。</p></div><button id="screen-import-close" type="button" class="btn btn-ghost btn-sm" aria-label="关闭导入弹窗">关闭</button></div><form id="screen-import-form" class="screen-job-form"><p>每个 ZIP 对应一人，内含一份 PDF 简历及 PDF/JPG/PNG 佐证材料。</p><label for="import-job">目标岗位</label><select id="import-job" class="input" required><option value="">请选择岗位</option></select><button id="screen-dropzone" class="screen-dropzone" type="button"><strong>拖放 PDF / ZIP 到这里</strong><span>或点击选择文件 · 最多 30 个</span><small>PDF 每份最多 8 MB；ZIP 每包最多 32 MB、只放一人的材料</small></button><input id="import-files" type="file" accept=".pdf,.zip,application/pdf,application/zip" multiple class="screen-hidden" aria-label="选择 PDF 或 ZIP 文件"><ul id="import-files-list" class="screen-selected-files" aria-live="polite"></ul><label class="screen-check"><input id="import-permission" type="checkbox" required><span>我确认企业已获得将这些简历用于当前岗位招聘评估的授权。</span></label><p id="screen-import-error" class="screen-error screen-hidden" role="alert" tabindex="-1"></p><div class="screen-form-actions"><button class="btn btn-primary" type="submit" id="screen-import-submit">写入并开始识别</button><button class="btn btn-ghost" type="button" id="screen-import-cancel">清空</button></div></form></dialog>'
      + '<p id="screen-import-success" class="screen-success screen-hidden" role="status"></p><section class="screen-source-stats" aria-label="简历来源统计"><div class="card"><span>简历总数</span><strong id="source-total">0</strong></div><div class="card"><span>个人端投递</span><strong id="source-candidate">0</strong></div><div class="card"><span>企业端录入</span><strong id="source-hr">0</strong></div></section>'
      + '<section class="screen-filters" aria-label="筛选申请"><label>岗位<select id="filter-job"><option value="">全部岗位</option></select></label><label>简历来源<select id="filter-source"><option value="">全部来源</option><option value="candidate_portal">个人投递</option><option value="hr_import">企业录入</option></select></label><label>申请状态<select id="filter-status"><option value="">全部状态</option><option value="hr_review">待 HR 审核</option><option value="ai_interview_invited">已邀 AI 辅助初面</option><option value="ai_interview_completed">AI 辅助初面完成</option><option value="failed">处理异常</option></select></label><label>审核重点<select id="filter-review"><option value="">全部</option><option value="manual">需要人工复核</option><option value="pending">待审核</option></select></label><label>录入时间<input id="filter-date" type="date"></label></section>'
      + '<p id="screen-list-error" class="screen-error screen-hidden" role="alert"></p><div class="screen-view-switch" role="group" aria-label="候选人展示方式"><span>展示方式</span><button type="button" data-list-view="cards" aria-pressed="true">卡片</button><button type="button" data-list-view="table" aria-pressed="false">表格</button></div><div id="screen-cards" class="screen-candidate-cards"><p class="screen-empty-copy">正在读取申请…</p></div><div id="screen-table-wrap" class="screen-table-wrap screen-hidden"><table class="screen-table"><thead><tr><th>候选人 / 岗位</th><th>来源</th><th>录入时间</th><th>申请进度</th><th>处理状态</th><th>匹配指标</th><th>初筛建议</th><th>HR 审核</th><th></th></tr></thead><tbody id="screen-rows"><tr><td colspan="9">正在读取申请…</td></tr></tbody></table></div>';
    const form = byId('screen-job-form');
    const importForm = byId('screen-import-form');
    const listActions = document.createElement('section');
    listActions.className = 'screen-list-actions';
    listActions.innerHTML = '<div><h2>全部候选人</h2><p>所有简历先分析并保留；只有你启动筛选后，才生成本轮入围名单。</p></div><button id="screen-batch-setup" class="btn btn-primary" type="button">设置保留比例 / 开始本轮筛选</button>';
    byId('screen-list-error').before(listActions);
    const pager = document.createElement('nav');
    pager.id = 'screen-pagination'; pager.className = 'screen-pagination';
    pager.setAttribute('aria-label','候选人分页');
    byId('screen-table-wrap').after(pager);
    const importDialog = byId('screen-import-dialog');
    const uploadProgress = document.createElement('div');
    uploadProgress.className = 'screen-upload-progress screen-hidden';
    uploadProgress.setAttribute('role','status');
    uploadProgress.innerHTML = '<span>上传进度 <strong id="screen-upload-percent">0%</strong></span><progress id="screen-upload-bar" max="100" value="0"></progress>';
    importForm.querySelector('.screen-form-actions').before(uploadProgress);
    let selectedFiles = [];
    const renderSelectedFiles = () => {
      byId('import-files-list').innerHTML = selectedFiles.map((file,index) => '<li><span><strong>' + esc(file.name) + '</strong><small>' + (file.size / 1048576).toFixed(1) + ' MB</small></span><button type="button" data-remove-file="' + index + '" aria-label="移除 ' + esc(file.name) + '">移除</button></li>').join('');
      byId('import-files-list').querySelectorAll('[data-remove-file]').forEach((button) => {
        button.onclick = () => { selectedFiles.splice(Number(button.dataset.removeFile),1); renderSelectedFiles(); };
      });
    };
    const addFiles = (incoming) => {
      const errors = [];
      for (const file of Array.from(incoming || [])) {
        const limit = /\.zip$/i.test(file.name) ? 32 * 1048576 : 8 * 1048576;
        if (!/\.(pdf|zip)$/i.test(file.name)) errors.push(file.name + '：仅支持 PDF 或 ZIP');
        else if (file.size > limit) errors.push(file.name + '：文件超出大小限制');
        else if (selectedFiles.some((item) => item.name === file.name)) errors.push(file.name + '：已有同名文件，请改名后再选');
        else if (selectedFiles.length >= 30 || selectedFiles.reduce((sum,item) => sum + item.size,0) + file.size > 96 * 1048576) errors.push('一次最多 30 个文件、总量不超过 96 MB');
        else selectedFiles.push(file);
      }
      renderSelectedFiles();
      showError('screen-import-error', errors.join('；'));
    };
    byId('screen-new-job').onclick = () => { form.classList.remove('screen-hidden'); byId('new-job-title').focus(); };
    byId('screen-job-cancel').onclick = () => form.classList.add('screen-hidden');
    byId('screen-new-import').onclick = () => { importDialog.showModal(); byId('import-job').focus(); };
    byId('screen-import-close').onclick = () => importDialog.close();
    byId('screen-import-cancel').onclick = () => { importForm.reset(); selectedFiles = []; renderSelectedFiles(); showError('screen-import-error',''); };
    byId('screen-dropzone').onclick = () => byId('import-files').click();
    byId('import-files').onchange = (event) => { addFiles(event.target.files); event.target.value = ''; };
    ['dragenter','dragover'].forEach((name) => { byId('screen-dropzone').addEventListener(name,(event) => { event.preventDefault(); byId('screen-dropzone').classList.add('is-dragging'); }); });
    ['dragleave','drop'].forEach((name) => { byId('screen-dropzone').addEventListener(name,(event) => { event.preventDefault(); byId('screen-dropzone').classList.remove('is-dragging'); if (name === 'drop') addFiles(event.dataTransfer.files); }); });
    importForm.onsubmit = async (event) => {
      event.preventDefault();
      showError('screen-import-error','');
      if (!selectedFiles.length) {
        showError('screen-import-error','请先拖入或选择简历文件。');
        byId('screen-import-error').focus();
        return;
      }
      const button = byId('screen-import-submit'); button.disabled = true; button.textContent = '正在写入…';
      const body = new FormData();
      body.append('jobId',byId('import-job').value);
      body.append('permissionConfirmed',String(byId('import-permission').checked));
      selectedFiles.forEach((file) => body.append('files',file));
      try {
        uploadProgress.classList.remove('screen-hidden');
        byId('screen-upload-bar').value = 0; byId('screen-upload-percent').textContent = '0%';
        const result = await new Promise((resolve,reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST','/api/hr/resumes/batch');
          xhr.setRequestHeader('Authorization','Bearer ' + auth().token);
          xhr.upload.onprogress = (progress) => {
            if (!progress.lengthComputable) return;
            const percent = Math.min(100, Math.round(progress.loaded / progress.total * 100));
            byId('screen-upload-bar').value = percent; byId('screen-upload-percent').textContent = percent + '%';
          };
          xhr.onload = () => {
            let data; try { data = JSON.parse(xhr.responseText); } catch (_) { data = null; }
            if (xhr.status >= 200 && xhr.status < 300) resolve(data || {});
            else reject(new Error(typeof data?.detail === 'string' ? data.detail : '上传未完成，请重试。'));
          };
          xhr.onerror = () => reject(new Error('连接中断，文件仍保留在弹窗中，可重试上传。'));
          xhr.send(body);
        });
        const accepted = Array.isArray(result.items) ? result.items : [];
        const failures = Array.isArray(result.errors) ? result.errors : [];
        const completedNames = new Set(accepted.map((item) => item.file));
        selectedFiles = selectedFiles.filter((file) => !completedNames.has(file.name));
        renderSelectedFiles();
        const notice = byId('screen-import-success');
        if (accepted.length) {
          notice.innerHTML = '已录入 ' + accepted.length + ' 份简历，正在后台识别。<a href="screening.html?id=' + encodeURIComponent(accepted[0].application.id) + '">查看第一份 →</a>';
          notice.classList.remove('screen-hidden');
          await loadList();
        }
        if (failures.length) {
          showError('screen-import-error',failures.map((item) => item.file + '：' + item.message).join('；'));
          byId('screen-import-error').focus();
        } else if (accepted.length) { importForm.reset(); importDialog.close(); }
      } catch (error) { showError('screen-import-error',error.message || '写入失败。'); byId('screen-import-error').focus(); }
      finally { button.disabled = false; button.textContent = '写入并开始识别'; uploadProgress.classList.add('screen-hidden'); }
    };
    form.onsubmit = async (event) => {
      event.preventDefault();
      const button = byId('screen-job-submit'); button.disabled = true; button.textContent = '正在发布…'; showError('screen-job-error','');
      try {
        await api('/api/hr/jobs',{method:'POST',body:JSON.stringify({title:byId('new-job-title').value.trim(),description:byId('new-job-description').value.trim()})});
        form.reset(); form.classList.add('screen-hidden'); await loadJobs(); await loadList();
      } catch (error) { showError('screen-job-error',error.message || '发布失败。'); }
      finally { button.disabled = false; button.textContent = '发布岗位'; }
    };
    ['filter-job','filter-source','filter-status','filter-review','filter-date'].forEach((id) => { byId(id).onchange = () => { listPage = 1; drawRows(); }; });
    byId('screen-batch-setup').onclick = () => openBatchSetup();
    app.querySelectorAll('[data-list-view]').forEach((button) => { button.onclick = () => { listView = button.dataset.listView; setListView(listView); }; });
    setListView(listView);
    loadJobs(); loadList();
    setInterval(() => { if (document.visibilityState === 'visible' && byId('screen-rows')) loadList(); }, 15000);
  }
  async function loadJobs() {
    try {
      const result = await api('/api/hr/jobs');
      jobs = Array.isArray(result.items) ? result.items : [];
      const importJob = byId('import-job');
      if (importJob) {
        const selected = importJob.value;
        importJob.innerHTML = '<option value="">请选择岗位</option>' + jobs.map((job) => '<option value="' + esc(job.id) + '">' + esc(job.title) + '</option>').join('');
        importJob.value = selected || (jobs.length === 1 ? jobs[0].id : '');
      }
      const select = byId('filter-job');
      if (select) {
        const value = select.value;
        const titles = [...new Set(entries.map((item) => item.jobTitle).filter(Boolean))];
        select.innerHTML = '<option value="">全部岗位</option>' + titles.map((title) => '<option value="' + esc(title) + '">' + esc(title) + '</option>').join('');
        select.value = value;
      }
    } catch (_) { /* List can still display applications. */ }
  }
  async function loadList() {
    try {
      const result = await api('/api/hr/applications');
      entries = Array.isArray(result.items) ? result.items : [];
      sourceCounts = result.counts || {total:0,candidatePortal:0,hrImport:0};
      byId('source-total').textContent = sourceCounts.total || 0;
      byId('source-candidate').textContent = sourceCounts.candidatePortal || 0;
      byId('source-hr').textContent = sourceCounts.hrImport || 0;
      const select = byId('filter-job');
      if (select) {
        const value = select.value;
        const titles = [...new Set(entries.map((item) => item.jobTitle).filter(Boolean))];
        select.innerHTML = '<option value="">全部岗位</option>' + titles.map((title) => '<option value="' + esc(title) + '">' + esc(title) + '</option>').join('');
        select.value = value;
      }
      showError('screen-list-error',''); drawRows();
    } catch (error) { showError('screen-list-error',error.message || '无法读取申请。'); }
  }
  function previewText(value) {
    if (typeof value === 'string') return value.trim();
    if (!value || typeof value !== 'object') return '';
    return [value.school, value.major, value.degree, value.title, value.name, value.summary,
      value.description, value.role, value.result].filter((part) => typeof part === 'string' && part.trim()).join(' · ');
  }
  function candidateCardHtml(item, options = {}) {
    const preview = item.candidatePreview || {};
    const profile = item.candidateProfile || {};
    const education = previewText(preview.education?.[0] || profile.education?.[0]) || '教育背景待确认';
    const rawSkills = Array.isArray(preview.skills) ? preview.skills : Array.isArray(profile.skills) ? profile.skills : [];
    const skills = rawSkills.map(previewText).filter(Boolean).slice(0,4);
    const project = previewText(preview.projects?.[0] || preview.workExperience?.[0] || profile.workExperience?.[0]);
    const award = previewText(preview.achievements?.[0] || preview.awards?.[0] || preview.certifications?.[0]);
    const dimensions = Array.isArray(options.scoreDetails?.dimensionScores) ? options.scoreDetails.dimensionScores : [];
    const scoreText = typeof options.score === 'number' ? options.score.toFixed(1) + ' / 100' : listScoreOf(item);
    const rank = options.rank ? ' · 第 ' + options.rank + ' 名' : '';
    return '<article class="card screen-candidate-card' + (options.large ? ' screen-candidate-card-large' : '') + '">' +
      '<div class="screen-candidate-card-head"><div><h2>' + esc(item.candidateName || '姓名待确认') + '</h2><p>' + esc(item.jobTitle || '目标岗位') + '</p></div></div>' +
      '<p class="screen-candidate-education">' + esc(education) + '</p>' +
      (skills.length ? '<div class="screen-candidate-skills">' + skills.map((skill) => '<span>' + esc(skill) + '</span>').join('') + '</div>' : '') +
      '<div class="screen-candidate-highlights">' +
      '<div><span>项目与实习经历</span><p>' + esc(project || '待从简历中提取项目与经历') + '</p></div>' +
      '<div><span>竞赛与成果</span><p>' + esc(award || '暂无可展示的奖项记录') + '</p></div>' +
      '<div><span>公开核查</span><p>' + esc(verificationLabel(item.verificationStatus)) + '</p></div></div>' +
      (dimensions.length ? '<div class="screen-dimension-chips">' + dimensions.slice(0,4).map((entry) => '<span>' + esc(entry.name) + ' ' + esc(typeof entry.score === 'number' ? Math.round(entry.score) : '待核实') + '</span>').join('') + '</div>' : '') +
      '<div class="screen-candidate-card-foot"><div><strong>' + esc(scoreText + rank) + '</strong><small>' + esc(sourceLabel(item.source)) + (item.resumeVersion > 1 ? ' · 第 ' + esc(item.resumeVersion) + ' 版简历' : '') + ' · ' + esc(statusLabel(item.status)) + ' · ' + esc(dateLabel(item.createdAt)) + '</small></div><a class="screen-detail-link" href="screening.html?id=' + encodeURIComponent(item.id) + (options.batchId ? '&returnBatch=' + encodeURIComponent(options.batchId) : '') + '">查看完整报告 →</a></div></article>';
  }
  function drawRows() {
    const body = byId('screen-rows');
    if (!body) return;
    const job = byId('filter-job').value, source = byId('filter-source').value,
      status = byId('filter-status').value, review = byId('filter-review').value, date = byId('filter-date').value;
    const shown = entries.filter((item) => (!job || item.jobTitle === job) && (!source || item.source === source)
      && (!status || item.status === status) && (!date || dateISO(item.createdAt) === date)
      && (!review || (review === 'manual' ? ['manual_review','insufficient_evidence'].includes(item.recommendation)
        || item.reviewStatus === 'verify' : !item.reviewStatus)));
    const pages = Math.max(1, Math.ceil(shown.length / pageSize));
    listPage = Math.min(Math.max(1,listPage),pages);
    const pageItems = shown.slice((listPage - 1) * pageSize, listPage * pageSize);
    body.innerHTML = pageItems.length ? pageItems.map((item) => '<tr><td><strong>' + esc(item.candidateName || '姓名待确认') + '</strong><small>' + esc(item.jobTitle || '目标岗位') + '</small></td><td>' + esc(sourceLabel(item.source)) + '</td><td>' + esc(dateLabel(item.createdAt)) + '</td><td>' + esc(statusLabel(item.status)) + '</td><td>' + esc(processLabel(item.resumeStatus)) + ' / ' + esc(processLabel(item.screeningStatus)) + '</td><td>' + esc(listScoreOf(item)) + '</td><td>' + esc(recommendationLabel(item.recommendation)) + '</td><td>' + esc(reviewStatus(item.reviewStatus)) + '</td><td><a class="screen-detail-link" href="screening.html?id=' + encodeURIComponent(item.id) + '">查看详情 →</a></td></tr>').join('') : '<tr><td colspan="9" class="screen-no-rows">没有符合条件的申请。</td></tr>';
    byId('screen-cards').innerHTML = pageItems.length ? pageItems.map((item) => candidateCardHtml(item)).join('') : '<div class="card screen-talent-empty">没有符合条件的申请。</div>';
    const pager = byId('screen-pagination');
    pager.innerHTML = '<span>第 ' + listPage + ' 页 / 共 ' + pages + ' 页 · ' + shown.length + ' 份简历</span><div><button type="button" data-page="' + (listPage - 1) + '" ' + (listPage === 1 ? 'disabled' : '') + '>上一页</button>' +
      Array.from({length:pages},(_,index) => '<button type="button" data-page="' + (index + 1) + '" ' + (index + 1 === listPage ? 'aria-current="page"' : '') + '>' + (index + 1) + '</button>').join('') +
      '<button type="button" data-page="' + (listPage + 1) + '" ' + (listPage === pages ? 'disabled' : '') + '>下一页</button></div>';
    pager.querySelectorAll('button[data-page]').forEach((button) => { button.onclick = () => { listPage = Number(button.dataset.page); drawRows(); byId('screen-cards').scrollIntoView({block:'start'}); }; });
  }
  function setListView(mode) {
    const cards = byId('screen-cards');
    const table = byId('screen-table-wrap');
    if (!cards || !table) return;
    cards.classList.toggle('screen-hidden',mode !== 'cards');
    table.classList.toggle('screen-hidden',mode !== 'table');
    app.querySelectorAll('[data-list-view]').forEach((button) => { button.setAttribute('aria-pressed',String(button.dataset.listView === mode)); });
  }

  async function openBatchSetup() {
    const jobResult = await api('/api/hr/jobs');
    const available = Array.isArray(jobResult.items) ? jobResult.items : [];
    if (!available.length) { showError('screen-list-error','请先发布岗位，再设置保留比例。'); return; }
    const dialog = document.createElement('dialog');
    dialog.className = 'screen-batch-dialog';
    dialog.innerHTML = '<div class="screen-import-heading"><div><h2>设置保留比例</h2><p>比例决定进入人工审核的人数，不代表自动淘汰或录用。</p></div><button type="button" id="batch-close" class="btn btn-ghost btn-sm">关闭</button></div>' +
      '<form id="batch-form"><label for="batch-job">目标岗位</label><select id="batch-job" class="input" required>' + available.map((job) => '<option value="' + esc(job.id) + '">' + esc(job.title) + '</option>').join('') + '</select>' +
      '<label for="batch-percent">进入人工审核的比例</label><div class="screen-batch-percent"><input id="batch-percent" class="input" type="number" min="1" max="100" value="30" required><span>%</span></div>' +
      '<div class="screen-batch-presets" role="group" aria-label="常用比例">' + [10,20,30,50,70,100].map((value) => '<button type="button" data-percent="' + value + '">' + value + '%</button>').join('') + '</div>' +
      '<div id="batch-preview" class="screen-batch-preview" aria-live="polite">正在读取岗位评分…</div><p id="batch-error" class="screen-error screen-hidden" role="alert"></p><div class="screen-form-actions"><button id="batch-create" type="submit" class="btn btn-primary">生成本轮入围名单</button></div></form>' +
      '<section class="screen-batch-history"><h3>历史筛选批次</h3><div id="batch-history">读取中…</div></section>';
    document.body.append(dialog);
    let queueTimer = null;
    let queueRunning = false;
    dialog.addEventListener('close',() => { clearTimeout(queueTimer); dialog.remove(); },{once:true});
    dialog.querySelector('#batch-close').onclick = () => dialog.close();
    const filterTitle = byId('filter-job')?.value;
    const selectedJob = available.find((job) => job.title === filterTitle);
    if (selectedJob) dialog.querySelector('#batch-job').value = selectedJob.id;
    let requestNumber = 0;
    const updatePreview = async () => {
      const current = ++requestNumber;
      const jobId = dialog.querySelector('#batch-job').value;
      const percent = Number(dialog.querySelector('#batch-percent').value);
      if (!jobId || !Number.isFinite(percent) || percent < 1 || percent > 100) return;
      const node = dialog.querySelector('#batch-preview'); node.textContent = '正在计算可评分人数…';
      try {
        const preview = await api('/api/hr/screening-batches/preview?jobId=' + encodeURIComponent(jobId) + '&retentionPercent=' + percent);
        if (current !== requestNumber || !dialog.isConnected) return;
        const assessable = Number(preview.assessablePendingCount) || 0;
        const unavailable = Number(preview.unavailableCount) || 0;
        node.innerHTML = '<dl><div><dt>当前岗位简历</dt><dd>' + esc(preview.totalCount) + '</dd></div><div><dt>可参与排名</dt><dd>' + esc(preview.eligibleCount) + '</dd></div><div><dt>本轮入围</dt><dd>' + esc(preview.selectedCount) + '</dd></div><div><dt>待补充评估</dt><dd>' + esc(preview.pendingCount) + '</dd></div></dl>' +
          '<p>入围人数按可评分人数 × 比例向上取整。' + (preview.boundaryTie ? '入围边界存在同分，建议 HR 复核。' : '') + '</p>' +
          (unavailable ? '<p>' + esc(unavailable) + ' 份简历缺少可分析原文，请在候选人详情重新解析原始简历；不会将其作为低分淘汰。</p>' : '') +
          (assessable ? '<button id="batch-queue-assessments" type="button" class="btn btn-ghost btn-sm" ' + (queueRunning ? 'disabled' : '') + '>' + (queueRunning ? '正在补充多维评分…' : '补充历史简历的多维评分（' + esc(assessable) + ' 份）') + '</button><p id="batch-queue-status" role="status">待评估简历不会被当作低分淘汰。</p>' : '');
        dialog.querySelector('#batch-create').disabled = !preview.eligibleCount;
        const queueButton = dialog.querySelector('#batch-queue-assessments');
        if (queueButton) queueButton.onclick = async () => {
          queueRunning = true; queueButton.disabled = true; queueButton.textContent = '正在补充多维评分…';
          try {
            await api('/api/hr/jobs/' + encodeURIComponent(jobId) + '/assessments/queue',{method:'POST',body:'{}'});
            const pollQueue = async () => {
              if (!dialog.isConnected) return;
              try {
                const progress = await api('/api/hr/jobs/' + encodeURIComponent(jobId) + '/assessments/queue');
                const status = dialog.querySelector('#batch-queue-status');
                if (status) status.textContent = '排队 ' + esc(progress.queued || 0) + ' · 处理中 ' + esc(progress.processing || 0) + ' · 已完成 ' + esc(progress.completed || 0) + (progress.failed ? ' · 失败 ' + esc(progress.failed) : '');
                if (progress.queued || progress.processing) queueTimer = setTimeout(pollQueue,3000);
                else { queueRunning = false; await updatePreview(); }
              } catch (error) { queueRunning = false; showError('batch-error',error.message || '无法读取补评进度。'); await updatePreview(); }
            };
            pollQueue();
          } catch (error) { queueRunning = false; showError('batch-error',error.message || '无法启动补评。'); await updatePreview(); }
        };
      } catch (error) { if (current === requestNumber) { node.textContent = error.message || '无法计算名单。'; dialog.querySelector('#batch-create').disabled = true; } }
    };
    const loadHistory = async () => {
      try {
        const jobId = dialog.querySelector('#batch-job').value;
        const result = await api('/api/hr/screening-batches?jobId=' + encodeURIComponent(jobId));
        const history = dialog.querySelector('#batch-history');
        history.innerHTML = result.items?.length ? result.items.map((batch) => '<a href="screening.html?view=review&batchId=' + encodeURIComponent(batch.id) + '">第 ' + esc(dateLabel(batch.createdAt)) + ' 轮 · ' + esc(batch.retentionPercent) + '% · ' + esc(batch.reviewedCount || 0) + ' 人已审核 →</a>').join('') : '<p>这个岗位还没有筛选批次。</p>';
      } catch (error) { dialog.querySelector('#batch-history').textContent = error.message || '无法读取历史批次。'; }
    };
    dialog.querySelector('#batch-job').onchange = () => { updatePreview(); loadHistory(); };
    dialog.querySelector('#batch-percent').oninput = updatePreview;
    dialog.querySelectorAll('[data-percent]').forEach((button) => { button.onclick = () => { dialog.querySelector('#batch-percent').value = button.dataset.percent; updatePreview(); }; });
    dialog.querySelector('#batch-form').onsubmit = async (event) => {
      event.preventDefault();
      const button = dialog.querySelector('#batch-create'); button.disabled = true;
      try {
        const batch = await api('/api/hr/screening-batches',{method:'POST',body:JSON.stringify({jobId:dialog.querySelector('#batch-job').value,retentionPercent:Number(dialog.querySelector('#batch-percent').value)})});
        location.assign('screening.html?view=review&batchId=' + encodeURIComponent(batch.id));
      } catch (error) { const node = dialog.querySelector('#batch-error'); node.textContent = error.message || '无法创建筛选批次。'; node.classList.remove('screen-hidden'); button.disabled = false; }
    };
    dialog.showModal(); updatePreview(); loadHistory();
  }

  async function renderReview(batchId) {
    app.innerHTML = '<a class="screen-back" href="screening.html">← 返回全部候选人</a><div class="screen-heading"><div><h1>入围候选人审核</h1><p>右滑保留，左滑放入人才库；也可以使用下方按钮。</p></div></div><p id="screen-review-error" class="screen-error screen-hidden" role="alert"></p><div id="screen-review-workspace">正在读取筛选批次…</div>';
    try {
      const [batch, applications] = await Promise.all([
        api('/api/hr/screening-batches/' + encodeURIComponent(batchId)), api('/api/hr/applications')]);
      const byApplication = new Map((applications.items || []).map((item) => [item.id,item]));
      let busy = false;
      const deferredThisVisit = new Set();
      const draw = (value) => {
        const root = byId('screen-review-workspace'); if (!root) return;
        const selected = (value.items || []).filter((item) => item.selected);
        const current = selected.find((item) => !item.reviewDecision) || selected.find((item) => item.reviewDecision === 'defer' && !deferredThisVisit.has(item.applicationId));
        const reviewed = selected.filter((item) => ['keep','talent'].includes(item.reviewDecision)).length;
        const deferred = selected.filter((item) => item.reviewDecision === 'defer').length;
        root.innerHTML = '<div class="screen-review-meta"><strong>' + esc(value.jobTitle || '目标岗位') + '</strong><span>标准第 ' + esc(value.profileVersion || '—') + ' 版 · 入围 ' + esc(value.selectedCount || selected.length) + ' 人 · 已决定 ' + reviewed + ' 人 · 暂缓 ' + deferred + ' 人</span></div>' +
          (value.pendingCount ? '<p class="screen-review-pending">另有 ' + esc(value.pendingCount) + ' 人待补充评估，未被当作低分淘汰。</p>' : '') +
          (value.boundaryTie ? '<p class="screen-review-pending">入围边界同分，请结合完整报告复核。</p>' : '') +
           (current ? '<div class="screen-review-stage"><div id="screen-review-card" class="screen-review-card">' + candidateCardHtml(byApplication.get(current.applicationId) || {id:current.applicationId,jobTitle:value.jobTitle,candidateName:'姓名待确认'}, {large:true,score:current.score,scoreDetails:current.scoreDetails,rank:current.rank,batchId:value.id}) + '</div></div><div class="screen-review-actions"><button type="button" data-decision="talent" class="btn btn-ghost">放入人才库</button><button type="button" data-decision="defer" class="btn btn-ghost">暂缓审核</button><button type="button" data-decision="keep" class="btn btn-primary">保留 · 下一位</button></div>' : deferred ? '<div class="screen-review-complete"><h2>本轮仍有暂缓候选人</h2><p>已记录暂缓决定，可以稍后继续审核。</p><button id="screen-resume-deferred" type="button" class="btn btn-primary">继续审核暂缓项</button></div>' : '<div class="screen-review-complete"><h2>本轮入围候选人已审核完毕</h2><p>本轮决定已保存，可返回列表查看全部候选人或撤销上一项。</p></div>') +
           '<div class="screen-review-bottom"><span>本轮筛选快照固定；新简历不会改变当前顺序。</span><button id="screen-review-undo" type="button" class="btn btn-ghost" ' + (reviewed || deferred ? '' : 'disabled') + '>撤销上一步</button></div>';
        const resumeDeferred = root.querySelector('#screen-resume-deferred');
        if (resumeDeferred) resumeDeferred.onclick = () => { deferredThisVisit.clear(); draw(value); };
        const commit = async (decision) => {
          if (busy || !current) return;
          busy = true;
          root.querySelectorAll('button').forEach((button) => { button.disabled = true; });
          const card = byId('screen-review-card');
          if (card) card.classList.add(decision === 'keep' ? 'is-leaving-right' : 'is-leaving-left');
          try {
            const [updated] = await Promise.all([
              api('/api/hr/screening-batches/' + encodeURIComponent(value.id) + '/decisions',{method:'POST',body:JSON.stringify({applicationId:current.applicationId,decision})}),
              new Promise((resolve) => setTimeout(resolve,220))
            ]);
            if (decision === 'defer') deferredThisVisit.add(current.applicationId);
            else deferredThisVisit.delete(current.applicationId);
            draw(updated);
          } catch (error) { showError('screen-review-error',error.message || '审核决定未保存，请重试。'); if (card) card.classList.remove('is-leaving-left','is-leaving-right'); root.querySelectorAll('button').forEach((button) => { button.disabled = false; }); }
          finally { busy = false; }
        };
        root.querySelectorAll('[data-decision]').forEach((button) => { button.onclick = () => commit(button.dataset.decision); });
        root.querySelector('#screen-review-undo').onclick = async () => {
          if (busy) return;
          busy = true;
          try { deferredThisVisit.clear(); draw(await api('/api/hr/screening-batches/' + encodeURIComponent(value.id) + '/undo',{method:'POST',body:'{}'})); }
          catch (error) { showError('screen-review-error',error.message || '撤销失败，请重试。'); }
          finally { busy = false; }
        };
        const card = byId('screen-review-card');
        if (card) {
          let startX = 0, dragging = false;
          card.onpointerdown = (event) => { if (event.target.closest('a,button,input,textarea')) return; startX = event.clientX; dragging = true; card.setPointerCapture(event.pointerId); card.classList.add('is-dragging'); };
          card.onpointermove = (event) => { if (!dragging) return; const dx = event.clientX - startX; card.style.transform = 'translateX(' + dx + 'px) rotate(' + Math.max(-9,Math.min(9,dx/26)) + 'deg)'; card.dataset.direction = dx > 80 ? 'right' : dx < -80 ? 'left' : ''; };
          card.onpointerup = (event) => { if (!dragging) return; dragging = false; card.classList.remove('is-dragging'); const dx = event.clientX - startX; card.style.transform = ''; card.dataset.direction = ''; if (Math.abs(dx) >= 110) commit(dx > 0 ? 'keep' : 'talent'); };
          card.onpointercancel = () => { dragging = false; card.classList.remove('is-dragging'); card.style.transform = ''; card.dataset.direction = ''; };
        }
        document.onkeydown = (event) => { if (!current || event.altKey || event.ctrlKey || event.metaKey || ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) return; if (event.key === 'ArrowRight') { event.preventDefault(); commit('keep'); } else if (event.key === 'ArrowLeft') { event.preventDefault(); commit('talent'); } };
      };
      draw(batch);
    } catch (error) { showError('screen-review-error',error.message || '无法读取筛选批次。'); }
  }

  async function renderDetail(id) {
    const returnBatch = new URLSearchParams(location.search).get('returnBatch');
    const returnUrl = returnBatch ? 'screening.html?view=review&batchId=' + encodeURIComponent(returnBatch) : 'screening.html';
    app.innerHTML = '<a class="screen-back" href="' + returnUrl + '">← 返回' + (returnBatch ? '本轮审核' : '初筛列表') + '</a><p id="screen-detail-error" class="screen-error screen-hidden" role="alert"></p><div id="screen-detail"><p class="muted">正在读取候选人资料…</p></div>';
    try { const item = await api('/api/hr/applications/' + encodeURIComponent(id)); drawDetail(item); startDetailProgress(id); }
    catch (error) { showError('screen-detail-error',error.message || '无法读取详情。'); }
  }
  function drawDetailProgress() {
    const root = byId('screen-progress');
    if (!root) return;
    const state = detailProgressState;
    const stageNames = {resume_parse:'PDF 简历解析',ocr:'扫描件识别',structured_resume:'结构化履历',screening:'AI 初筛',verification:'公开信息核查',assessment:'能力与岗位评估',report:'综合报告'};
    const stages = Array.isArray(state?.stages) ? state.stages : [];
    const events = Array.isArray(state?.events) ? state.events : [];
    const completed = stages.filter((entry) => entry.status === 'completed').length;
    root.innerHTML = '<div class="screen-panel-heading"><h2>分析进度</h2><span class="screen-state">' + (stages.length ? completed + ' / ' + stages.length + ' 个已记录阶段完成' : state?.loaded ? '历史记录' : '读取中') + '</span></div>'
      + '<p class="screen-panel-lead">以下状态和动态来自后台实际任务；刷新后可恢复历史记录。</p>'
      + (stages.length ? '<div class="screen-progress-rail" aria-label="分析阶段">' + stages.map((entry) => '<span data-status="' + esc(entry.status) + '" title="' + esc(stageNames[entry.stage] || entry.stage) + '"></span>').join('') + '</div>' + stages.map((entry) => '<div class="screen-progress-stage" data-status="' + esc(entry.status) + '"><div class="screen-progress-stage-head"><span>' + esc(stageNames[entry.stage] || entry.stage) + '</span><span>' + esc(processLabel(entry.status)) + '</span></div><p>' + esc(entry.message || '') + '</p></div>').join('') : '<p class="screen-empty-copy">' + (state?.loaded ? '此历史申请没有阶段日志，已有分析结果仍可正常查看。' : '正在恢复后台进度…') + '</p>')
      + (events.length ? '<details><summary>展开详细日志（' + events.length + ' 条）</summary><ol class="screen-progress-log">' + events.map((entry) => '<li>' + esc(dateLabel(entry.createdAt)) + ' · ' + esc(entry.message || '') + '</li>').join('') + '</ol></details>' : '');
  }
  async function startDetailProgress(id) {
    if (detailProgressAbort) detailProgressAbort.abort();
    const controller = new AbortController();
    detailProgressAbort = controller;
    detailProgressState = {id,loaded:false,stages:[],events:[],lastId:0};
    drawDetailProgress();
    try {
      const snapshot = await api('/api/hr/applications/' + encodeURIComponent(id) + '/progress', {signal:controller.signal});
      if (controller.signal.aborted) return;
      detailProgressState = {...snapshot,id,loaded:true,lastId:Math.max(0,...(snapshot.events || []).map((entry) => Number(entry.id) || 0))};
      drawDetailProgress();
    } catch (error) {
      if (controller.signal.aborted) return;
      detailProgressState.loaded = true; drawDetailProgress();
      showError('screen-detail-error',error.message || '无法恢复分析进度。');
    }
    const connect = async () => {
      if (controller.signal.aborted || !byId('screen-progress')) return;
      try {
        const response = await fetch('/api/hr/applications/' + encodeURIComponent(id) + '/progress/events?after=' + detailProgressState.lastId, {
          headers:{Authorization:'Bearer ' + auth().token},cache:'no-store',signal:controller.signal
        });
        if (!response.ok) throw new Error(await readError(response));
        await readSse(response,(kind,event) => {
          if (kind !== 'progress' || !event?.id || controller.signal.aborted) return;
          if (event.id <= detailProgressState.lastId) return;
          detailProgressState.lastId = event.id;
          detailProgressState.events.push(event);
          detailProgressState.events = detailProgressState.events.slice(-200);
          const index = detailProgressState.stages.findIndex((entry) => entry.stage === event.stage);
          const stage = {stage:event.stage,status:event.status,message:event.message,updatedAt:event.createdAt};
          if (index >= 0) detailProgressState.stages[index] = {...detailProgressState.stages[index],...stage};
          else detailProgressState.stages.push(stage);
          drawDetailProgress();
          if (event.stage === 'verification') loadVerification(id);
          if (event.status === 'completed' && ['resume_parse','screening','assessment','verification'].includes(event.stage)) {
            clearTimeout(detailPoll);
            detailPoll = setTimeout(async () => {
              if (!byId('screen-detail')) return;
              try { drawDetail(await api('/api/hr/applications/' + encodeURIComponent(id))); }
              catch (_) { /* The next stage event or refresh can restore this view. */ }
            }, 400);
          }
        });
      } catch (_) { /* Reconnect from the last persisted event ID. */ }
      if (!controller.signal.aborted && byId('screen-progress')) setTimeout(connect,2500);
    };
    connect();
  }
  function evidenceHtml(evidence, empty) {
    if (!Array.isArray(evidence) || !evidence.length) return '<p class="screen-empty-copy">' + esc(empty || '未进行外部核验，或没有可展示的外部证据。') + '</p>';
    return '<ul class="screen-evidence-list">' + evidence.map((entry) => {
      if (typeof entry === 'string') return '<li>' + esc(entry) + '</li>';
      const url = safeUrl(entry.url);
      return '<li><strong>' + esc(entry.source || entry.relatedClaim || entry.requirement || '证据') + '</strong>' + (url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">打开来源 ↗</a>' : '') + '<small>' + esc(entry.verificationStatus || '待核实') + (entry.checkedAt ? ' · 核验于 ' + esc(dateLabel(entry.checkedAt)) : '') + '</small>' + (entry.details || entry.excerpt || entry.sourceText ? '<p>' + esc(entry.details || entry.excerpt || entry.sourceText) + '</p>' : '') + '</li>';
    }).join('') + '</ul>';
  }
  function claimHtml(claims) {
    if (!Array.isArray(claims) || !claims.length) return '<p class="screen-empty-copy">暂无需要单独核验的声明。</p>';
    const labels = {unverified:'尚未核实',resume_supported:'简历内部有支撑',external_supported:'外部证据支持',conflict:'发现冲突'};
    return claims.map((claim) => '<article class="screen-claim"><strong>' + esc(claim.claim || '') + '</strong><span class="screen-state">' + esc(labels[claim.verificationStatus] || '待核实') + '</span>' + (claim.sourceText ? '<blockquote>' + esc(claim.sourceText) + '</blockquote>' : '') + (Array.isArray(claim.supportingEvidence) && claim.supportingEvidence.length ? evidenceHtml(claim.supportingEvidence) : '') + (claim.followUpQuestion ? '<p><b>建议追问：</b>' + esc(claim.followUpQuestion) + '</p>' : '') + '</article>').join('');
  }
  function substanceHtml(signals) {
    if (!Array.isArray(signals) || !signals.length) return '<p class="screen-empty-copy">模型未识别到可引用的具体信号；请结合原始简历核对关键经历。</p>';
    return signals.map((entry) => '<article class="screen-claim"><strong>' + esc(entry.signal || '待核实细节') + '</strong><blockquote>' + esc(entry.sourceText || '') + '</blockquote><p>' + esc(entry.reasoning || '') + '</p><p><b>核验问题：</b>' + esc(entry.followUpQuestion || '') + '</p></article>').join('');
  }
  function interviewAnalysisHtml(formal) {
    const report = formal.analysis;
    if (!report) return '<div class="screen-pending"><p>' + (formal.status === 'completed' ? '面试已完成，DeepSeek 正在分析问答证据。' : '面试进行中；完成全部题目后生成 AI 分析。') + '</p>' + (formal.analysisStatus === 'failed' ? '<small>' + esc(formal.analysisError || '模型分析失败。') + '</small><button type="button" id="screen-retry-interview" class="btn btn-ghost btn-sm">重新分析面试</button>' : '') + '</div>';
    const labels = {specific:'回答具体',partial:'部分具体',unclear:'证据不足'};
    return '<p class="screen-model-note">分析模型：' + esc(formal.analysisModel || 'DeepSeek') + '</p><p class="screen-panel-lead">' + esc(report.summary || '') + '</p><h3>逐题证据与推理</h3>'
      + (Array.isArray(report.answerEvidence) ? report.answerEvidence.map((entry) => '<article class="screen-claim"><strong>' + esc(labels[entry.assessment] || '待核实') + '</strong><blockquote>' + esc(entry.answerQuote || '') + '</blockquote><p>' + esc(entry.reasoning || '') + '</p><p><b>复试追问：</b>' + esc(entry.followUpQuestion || '') + '</p></article>').join('') : '')
      + '<h3>有依据的优势</h3>' + listStrings(report.strengths) + '<h3>证据缺口</h3>' + listStrings(report.gaps) + '<h3>建议复试追问</h3>' + listStrings(report.followUpQuestions) + '<h3>分析限制</h3>' + listStrings(report.limitations);
  }
  function structuredResumeHtml(resume) {
    const sections = [['教育经历',resume.education],['工作经历',resume.workExperience],['实习经历',resume.internships],['项目经历',resume.projects],['奖项与成果',resume.achievements || resume.awards],['证书',resume.certifications]];
    const body = sections.map(([label,items]) => {
      if (!Array.isArray(items) || !items.length) return '';
      return '<h3>' + label + '</h3><div class="screen-structured-list">' + items.map((entry) => '<div>' + esc(typeof entry === 'string' ? entry : Object.values(entry || {}).filter((value) => typeof value === 'string' && value).join(' · ')) + '</div>').join('') + '</div>';
    }).join('');
    const skills = Array.isArray(resume.skills) && resume.skills.length ? '<h3>技能</h3>' + listStrings(resume.skills) : '';
    const links = Array.isArray(resume.portfolioLinks) && resume.portfolioLinks.length ? '<h3>职业作品链接</h3><ul>' + resume.portfolioLinks.map((value) => { const url = safeUrl(value); return '<li>' + (url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(url) + '</a>' : esc(value)) + '</li>'; }).join('') + '</ul>' : '';
    const extra = Array.isArray(resume.additionalInformation) ? '<h3>其他补充信息</h3>' + listStrings(resume.additionalInformation) : '';
    return body + skills + links + extra;
  }
  function verificationLabel(value) {
    return ({VERIFIED:'已核实',PARTIALLY_VERIFIED:'部分核实',UNVERIFIED:'暂未核实',CONTRADICTED:'证据有明确矛盾',queued:'排队中',pending:'待处理',processing:'核查中',completed:'核查完成',partial:'部分完成',failed:'核查失败',skipped:'已跳过',not_started:'尚未开始'})[value] || '暂未核实';
  }
  function assessmentHtml(assessment) {
    if (!assessment) return '';
    if (assessment.status !== 'completed') return '<div class="screen-verification-assessment"><h2>能力还原与岗位匹配</h2><p class="screen-pending">' + (assessment.status === 'failed' ? '岗位评估未完成，请结合原始简历人工复核。' : '正在按已确认的招聘标准分析能力与岗位匹配。') + '</p>' + (assessment.error ? '<p class="screen-error">' + esc(assessment.error) + '</p>' : '') + (assessment.status === 'failed' ? '<div class="screen-form-actions"><button type="button" class="btn btn-ghost btn-sm" id="screen-retry-assessment">重试能力评估</button></div><p id="screen-assessment-error" class="screen-error screen-hidden" role="alert"></p>' : '') + '</div>';
    const capabilities = Array.isArray(assessment.capabilityProfile) ? assessment.capabilityProfile : [];
    const dimensions = Array.isArray(assessment.dimensionScores) ? assessment.dimensionScores : [];
    const weighted = typeof assessment.weightedScore === 'number' ? assessment.weightedScore : null;
    const recommendation = {advance:'建议推进',review:'建议人工复核',hold:'建议暂缓'}[assessment.recommendation] || '待人工判断';
    return '<div class="screen-verification-assessment"><h2>能力还原与岗位匹配</h2><p class="screen-model-note">' + esc(assessment.jobTitle || '目标岗位') + ' · 招聘标准第 ' + esc(assessment.profileVersion || '—') + ' 版 · ' + esc(processLabel(assessment.status)) + '</p>'
      + (assessment.error ? '<p class="screen-error">' + esc(assessment.error) + '</p>' : '')
      + (assessment.summary ? '<p>' + esc(assessment.summary) + '</p>' : '')
      + (weighted !== null ? '<div class="screen-decision"><span>多维综合评分</span><strong>' + esc(weighted.toFixed(1)) + '/100</strong><small>依据已确认标准的权重，须结合证据与人工复核</small></div>' : typeof assessment.matchScore === 'number' ? '<div class="screen-decision"><span>岗位匹配指标</span><strong>' + esc(Math.round(assessment.matchScore)) + '/100</strong><small>旧版指标；当前标准的多维评分尚未完成</small></div>' : '<p class="screen-empty-copy">证据不足或评估尚未完成，暂不显示匹配分。</p>')
      + (dimensions.length ? '<h4>评分维度与依据</h4><div class="screen-dimension-list">' + dimensions.map((entry) => '<article><div><strong>' + esc(entry.name) + '</strong><span>权重 ' + esc(entry.weight) + '% · ' + (typeof entry.score === 'number' ? esc(entry.score.toFixed(1)) + '/100' : '证据不足') + '</span></div><p>' + esc(entry.reason || entry.criteria || '待补充可追溯证据。') + '</p>' + (entry.sourceText ? '<blockquote>' + esc(entry.sourceText) + '</blockquote>' : '') + '</article>').join('') + '</div>' : '')
      + (assessment.scoreBasis ? '<p class="screen-score-basis">指标依据：' + esc(assessment.scoreBasis) + '</p>' : '')
      + '<h4>可证明的能力与原文对照</h4>' + (capabilities.length ? capabilities.map((item) => '<article class="screen-capability"><strong>' + esc(item.normalized || '待核实能力') + '</strong><blockquote>' + esc(item.sourceText || item.originalClaim || '') + '</blockquote>' + (item.originalClaim && item.originalClaim !== item.sourceText ? '<p>原简历表述：' + esc(item.originalClaim) + '</p>' : '') + (item.interviewQuestion ? '<p>面试追问：' + esc(item.interviewQuestion) + '</p>' : '') + '</article>').join('') : '<p class="screen-empty-copy">尚无可与简历原文对应的能力分析。</p>')
      + '<h4>已匹配的岗位要求</h4>' + listStrings(assessment.matchedRequirements,'暂无有证据支持的匹配项。')
      + '<h4>能力或证据缺口</h4>' + listStrings(assessment.gaps,'尚无明确缺口。')
      + '<h4>建议面试追问</h4>' + listStrings(assessment.interviewQuestions,'暂无补充问题。')
      + '<h4>处理建议</h4><p>' + esc(recommendation) + '</p>'
      + '<h4>分析限制</h4>' + listStrings(assessment.limitations,'请结合原始简历及面试人工判断。') + '</div>';
  }
  async function loadVerification(id) {
    const root = byId('screen-verification');
    if (!root) return;
    try {
      const result = await api('/api/hr/applications/' + encodeURIComponent(id) + '/verification');
      if (root !== byId('screen-verification')) return;
      const claims = Array.isArray(result.claims) ? result.claims : [];
      const assessment = result.assessment && typeof result.assessment === 'object' ? result.assessment : null;
      const canRetry = ['failed','partial','not_started'].includes(result.status);
      const assessmentRoot = byId('screen-assessment');
      if (assessmentRoot) assessmentRoot.innerHTML = assessment ? assessmentHtml(assessment) : '<div class="screen-panel-heading"><h2>能力还原与多维评分</h2><span class="screen-state">待评估</span></div><p class="screen-panel-lead">确认岗位招聘标准后，系统将按证据分析能力与评分维度。</p>';
      root.innerHTML = '<div class="screen-panel-heading"><h2>公开信息核查</h2><span class="screen-state">' + esc(verificationLabel(result.status)) + '</span></div><p class="screen-panel-lead">只根据实际检索到的公开资料判断。查不到记录不等于声明不实；重要矛盾需人工复核。' + (result.elapsedMs ? ' 本轮耗时 ' + esc((result.elapsedMs / 1000).toFixed(1)) + ' 秒。' : '') + '</p>'
        + (result.error ? '<p class="screen-error">' + esc(result.error) + '</p>' : '')
        + (claims.length ? claims.map((claim) => {
          const evidence = Array.isArray(claim.evidence) ? claim.evidence : [];
          return '<article class="screen-verification-claim"><div class="screen-verification-claim-head"><strong>' + esc(claim.claim || '待核查声明') + '</strong><span class="screen-state">' + esc(verificationLabel(claim.status)) + '</span></div><small>' + esc(claim.category || '经历声明') + (claim.pageNumber ? ' · 简历第 ' + esc(claim.pageNumber) + ' 页' : '') + ' · 搜索：' + esc(verificationLabel(claim.searchStatus || 'pending')) + ' · 分析：' + esc(verificationLabel(claim.analysisStatus || 'pending')) + '</small>' + (claim.sourceText ? '<blockquote>' + esc(claim.sourceText) + '</blockquote>' : '') + (claim.conclusion ? '<p>' + esc(claim.conclusion) + '</p>' : '')
            + (evidence.length ? '<ul class="screen-evidence-list">' + evidence.map((entry) => { const url = safeUrl(entry.url); return '<li><strong>' + esc(entry.title || entry.source || '公开资料') + '</strong>' + (url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">打开原始来源 ↗</a>' : '') + (entry.snippet ? '<p>' + esc(entry.snippet) + '</p>' : '') + '<small>' + esc(entry.source || '') + (entry.publishedAt ? ' · 发布于 ' + esc(dateLabel(entry.publishedAt)) : '') + (entry.retrievedAt ? ' · 检索于 ' + esc(dateLabel(entry.retrievedAt)) : '') + '</small></li>'; }).join('') + '</ul>' : '<p class="screen-empty-copy">暂无公开证据；请勿据此认定为不实。</p>')
            + (claim.followUpQuestion ? '<p><b>面试追问：</b>' + esc(claim.followUpQuestion) + '</p>' : '')
            + (claim.id && !['queued','processing'].includes(result.status) && !['queued','processing'].includes(claim.searchStatus) && !['queued','processing'].includes(claim.analysisStatus) && (claim.status !== 'VERIFIED' || claim.analysisStatus === 'failed') ? '<div class="screen-claim-actions">' + (evidence.length ? '<button type="button" class="btn btn-ghost btn-sm" data-claim-retry="' + esc(claim.id) + '" data-refresh-search="false">复核现有证据</button>' : '') + '<button type="button" class="btn btn-ghost btn-sm" data-claim-retry="' + esc(claim.id) + '" data-refresh-search="true">重新检索</button></div>' : '') + '</article>';
        }).join('') : '<div class="screen-pending">' + (result.status === 'failed' ? '本轮核查未完成，请重试或人工复核。' : '尚无可显示的核查声明；简历解析与核查完成后会更新。') + '</div>')
        + (canRetry ? '<div class="screen-form-actions"><button type="button" class="btn btn-ghost btn-sm" id="screen-retry-verification">' + (result.status === 'not_started' ? '开始公开核查' : '重新核查公开信息') + '</button></div>' : '');
      if (canRetry) byId('screen-retry-verification').onclick = async () => {
        const button = byId('screen-retry-verification'); button.disabled = true; button.textContent = '正在提交…';
        try { await api('/api/hr/applications/' + encodeURIComponent(id) + '/verification/retry',{method:'POST'}); root.innerHTML = '<div class="screen-pending">已提交核查，完成后请刷新详情页查看证据。</div>'; }
        catch (error) { showError('screen-detail-error',error.message || '提交核查失败。'); button.disabled = false; button.textContent = '重新核查公开信息'; }
      };
      root.querySelectorAll('[data-claim-retry]').forEach((button) => { button.onclick = async () => {
        button.disabled = true; showError('screen-detail-error','');
        try {
          await api('/api/hr/applications/' + encodeURIComponent(id) + '/verification/claims/' + encodeURIComponent(button.dataset.claimRetry) + '/retry',{
            method:'POST',body:JSON.stringify({refreshSearch:button.dataset.refreshSearch === 'true'})
          });
          await loadVerification(id);
        } catch (error) { showError('screen-detail-error',error.message || '单条声明复核失败。'); button.disabled = false; }
      }; });
      const retryAssessment = byId('screen-retry-assessment');
      if (retryAssessment) retryAssessment.onclick = async () => {
        retryAssessment.disabled = true; retryAssessment.textContent = '正在重试评估…';
        showError('screen-assessment-error','');
        try {
          await api('/api/hr/applications/' + encodeURIComponent(id) + '/assessment/retry',{method:'POST'});
          await loadVerification(id);
        } catch (error) {
          showError('screen-assessment-error',error.message || '能力评估重试失败。');
          retryAssessment.disabled = false; retryAssessment.textContent = '重试能力评估';
        }
      };
      const claimBusy = claims.some((claim) => ['queued','processing','pending'].includes(claim.searchStatus) || ['queued','processing','pending'].includes(claim.analysisStatus));
      if (['queued','processing'].includes(result.status) || claimBusy) {
        clearTimeout(verificationPoll);
        verificationPoll = setTimeout(() => loadVerification(id), 2500);
      }
    } catch (error) {
      if (root === byId('screen-verification')) root.innerHTML = '<div class="screen-panel-heading"><h2>公开信息核查</h2></div><p class="screen-error">' + esc(error.message || '无法读取核查记录。') + '</p>';
    }
  }
  function drawDetail(item) {
    if (attachmentPreviewUrl) { URL.revokeObjectURL(attachmentPreviewUrl); attachmentPreviewUrl = null; }
    const sourceReport = reportOf(item);
    const report = sourceReport ? {...sourceReport, externalEvidence: item.evidence || sourceReport.externalEvidence} : null;
    const profile = report?.candidateProfile || {};
    const resume = item.parsedResume || {};
    const match = report?.jobMatch || {};
    const recommendation = report?.screeningRecommendation || item.recommendation;
    const review = item.review || {};
    const interviewPath = typeof item.invitation?.interviewPath === 'string' && item.invitation.interviewPath.startsWith('/classic/?room=') ? item.invitation.interviewPath : '';
    const title = esc(item.jobTitle || '目标岗位');
    byId('screen-detail').innerHTML = '<div class="screen-detail-heading"><div><span class="eyebrow">候选人 · ' + esc(statusLabel(item.status)) + '</span><h1>' + esc(item.candidateName || '候选人') + '</h1><p>' + title + ' · ' + sourceLabel(item.source) + '于 ' + esc(dateLabel(item.createdAt)) + (item.resumeVersion > 1 ? ' · 第 ' + esc(item.resumeVersion) + ' 版简历' : '') + '</p></div><div class="screen-heading-actions"><button id="screen-download" type="button" class="btn btn-ghost">查看原始简历</button>' + (interviewPath ? '<a class="btn btn-primary" href="' + esc(interviewPath) + '">人工面试房间（AI 辅助）</a>' : '') + '<a class="btn btn-ghost" href="ai-results.html?id=' + encodeURIComponent(item.id) + '">AI 面试结果</a><a class="btn btn-ghost" href="human-results.html?id=' + encodeURIComponent(item.id) + '">真人面试结果</a><a class="btn btn-ghost" href="invites.html">邀请记录</a></div></div>'
      + '<div class="screen-detail-grid"><div class="screen-detail-column"><section class="card screen-panel"><div class="screen-panel-heading"><h2>候选人资料</h2><span>' + esc(processLabel(item.resumeStatus)) + '</span></div><div class="screen-resume-meta"><span>来源</span><strong>' + sourceLabel(item.source) + '</strong><span>姓名</span><strong>' + esc(item.candidateName || '姓名待确认') + '</strong><span>联系方式</span><strong>' + esc(item.candidateEmail || resume.contact?.email || '未提供') + '</strong>' + (item.uploadedBy ? '<span>企业录入人</span><strong>' + esc(item.uploadedBy) + '</strong>' : '') + '</div><p class="screen-panel-lead">以下分析引用简历中的具体内容；原始文件可在页面顶部下载核对。</p><details><summary>查看解析后的简历结构</summary>' + (structuredResumeHtml(resume) || '<p class="screen-empty-copy">尚无结构化简历内容。</p>') + '</details></section>'
      + '<section class="card screen-panel"><h2>HR 人工审核</h2><p class="screen-panel-lead">审核意见用于记录企业内部的核验要点与决策依据；AI 结论只供参考，最终由 HR 判断。</p>' + (item.source === 'hr_import' ? '<p class="screen-import-note">企业录入简历尚未关联候选人账号，可先审核；线上初面邀请暂不可用。</p>' : '') + '<p class="screen-review-current">当前状态：' + esc(reviewStatus(review)) + (review.notes ? ' · ' + esc(review.notes) : '') + '</p><label for="screen-review-notes">内部审核意见</label><textarea id="screen-review-notes" class="input" rows="4" maxlength="2000" placeholder="记录待核实的经历、追问结果及处理依据">' + esc(review.notes || '') + '</textarea><p id="screen-review-error" class="screen-error screen-hidden" role="alert"></p><div class="screen-review-actions">' + (item.source === 'hr_import' ? '' : '<button type="button" data-decision="invite" class="btn btn-primary">邀请 AI 辅助初面</button>') + '<button type="button" data-decision="verify" class="btn btn-ghost">进一步核验</button><button type="button" data-decision="hold" class="btn btn-ghost">暂缓申请</button></div></section></div>'
      + '<div class="screen-detail-column"><section class="card screen-panel"><div class="screen-panel-heading"><h2>AI 初筛报告</h2><span>' + esc(processLabel(item.screeningStatus)) + '</span></div>'
      + (report ? '<p class="screen-model-note">分析模型：' + esc(item.screeningMeta?.model || 'DeepSeek') + '</p><p class="screen-panel-lead">' + esc(report.candidateSummary || '报告未提供候选人概览。') + '</p><div class="screen-decision"><span>岗位匹配指标</span><strong>' + esc(scoreOf(item)) + '</strong><small>辅助指标；缺少证据时不评分</small></div><h3>经历内容与待核实点</h3>' + substanceHtml(report.substanceSignals) + '<h3>匹配的要求</h3>' + listStrings(match.matchedRequirements,'暂无有证据支持的匹配项。') + '<h3>岗位能力缺口</h3>' + listStrings(match.missingRequirements,'未发现明确缺口，或岗位资料不足。') + '<h3>匹配依据</h3>' + evidenceHtml(match.evidence) + '<h3>有证据的优势</h3>' + listStrings(report.strengths,'暂无可说明的优势。') + '<h3>需要核实的声明</h3>' + claimHtml(report.resumeClaims) + '<h3>其他核验重点</h3>' + listStrings(report.areasToVerify,'暂无补充事项。') + '<h3>面试问题</h3>' + listStrings(report.interviewQuestions,'初筛完成后生成。') + '<h3>初筛建议</h3><div class="screen-recommendation"><strong>' + esc(recommendationLabel(recommendation)) + '</strong>' + listStrings(report.recommendationReasons,'请结合完整报告人工判断。') + '</div><h3>外部证据</h3>' + evidenceHtml(report.externalEvidence) + '<h3>分析限制</h3>' + listStrings(report.limitations,'请结合原始简历人工核验。') : '<div class="screen-pending"><p>' + (item.screeningStatus === 'failed' ? '初筛处理失败，可重新运行。' : '初筛处理中，完成后自动显示分析。') + '</p>' + (item.screeningError ? '<small>' + esc(item.screeningError) + '</small>' : '') + (item.screeningStatus === 'failed' ? '<button type="button" id="screen-retry-screening" class="btn btn-ghost btn-sm">重新运行初筛</button>' : '') + '</div>')
      + '</section></div></div>';
    const verificationPanel = document.createElement('section');
    verificationPanel.className = 'card screen-panel';
    verificationPanel.id = 'screen-verification';
    verificationPanel.innerHTML = '<div class="screen-panel-heading"><h2>公开信息核查</h2><span class="screen-state">读取中</span></div>';
    byId('screen-detail').querySelectorAll('.screen-detail-column')[1].append(verificationPanel);
    clearTimeout(verificationPoll);
    loadVerification(item.id);
    if (item.resumeStatus === 'failed') {
      const panel = byId('screen-detail').querySelector('.screen-detail-column .screen-panel');
      const failure = document.createElement('div');
      failure.className = 'screen-pending';
      const reason = document.createElement('p');
      reason.textContent = item.resumeError || '简历识别失败，可重新识别。';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.id = 'screen-retry-resume';
      retry.className = 'btn btn-ghost btn-sm';
      retry.textContent = '重新识别简历';
      failure.append(reason, retry);
      panel.append(failure);
    }
    if (item.source === 'hr_import') {
      const education = profile.education?.length ? profile.education : (resume.education || []).slice(0,2);
      const work = profile.workExperience?.length ? profile.workExperience : (resume.workExperience || []).slice(0,2);
      const skills = profile.skills?.length ? profile.skills : (resume.skills || []).slice(0,8);
      const aiFilled = Boolean((item.candidateName && item.candidateName !== '姓名待确认') || profile.email || profile.phone || profile.education?.length || profile.workExperience?.length || profile.skills?.length);
      const profileSection = document.createElement('section');
      profileSection.className = 'card screen-panel screen-auto-profile';
      profileSection.innerHTML = '<div class="screen-panel-heading"><h2>简历信息条</h2><span class="screen-state">' + (aiFilled ? 'AI 已识别' : item.screeningStatus === 'failed' ? '待人工核对' : item.screeningStatus === 'completed' ? '基础解析完成' : '识别中') + '</span></div><p class="screen-panel-lead">AI 从简历原文摘录，缺失字段留空；请以原件核对。</p><div class="screen-profile-grid"><div><span>姓名</span><strong>' + esc(item.candidateName && item.candidateName !== '姓名待确认' ? item.candidateName : '未识别') + '</strong></div><div><span>邮箱</span><strong>' + esc(profile.email || resume.contact?.email || '未识别') + '</strong></div><div><span>电话</span><strong>' + esc(profile.phone || resume.contact?.phone || '未识别') + '</strong></div></div><h3>教育</h3>' + listStrings(education,'未识别到教育经历。') + '<h3>工作经历</h3>' + listStrings(work,'未识别到工作经历。') + '<h3>技能</h3>' + listStrings(skills,'未识别到技能。');
      const proofSection = document.createElement('section');
      proofSection.className = 'card screen-panel screen-proof-panel';
      const attachments = Array.isArray(item.attachments) ? item.attachments : [];
      proofSection.innerHTML = '<div class="screen-panel-heading"><h2>关联佐证材料</h2><span>' + attachments.length + ' 份</span></div><p class="screen-panel-lead">材料与此人简历绑定保存在本地数据库，仅供 HR 人工查看；尚未自动核验真实性。</p>' + (attachments.length ? '<ul class="screen-proof-list">' + attachments.map((entry) => '<li><span><strong>' + esc(entry.name) + '</strong><small>' + (entry.sizeBytes / 1048576).toFixed(1) + ' MB</small></span><button type="button" class="btn btn-ghost btn-sm" data-attachment="' + esc(entry.id) + '">查看</button></li>').join('') + '</ul>' : '<p class="screen-empty-copy">此记录没有佐证材料。</p>');
      const firstPanel = byId('screen-detail').querySelector('.screen-detail-column .screen-panel');
      firstPanel.after(profileSection, proofSection);
      if (attachments.length) {
        const dialog = document.createElement('dialog');
        dialog.className = 'screen-preview-dialog';
        dialog.innerHTML = '<div class="screen-preview-heading"><strong id="screen-preview-title"></strong><button type="button" class="btn btn-ghost btn-sm" id="screen-preview-close">关闭</button></div><div id="screen-preview-body" class="screen-preview-body"></div><a id="screen-preview-download" class="btn btn-ghost btn-sm">下载原件</a>';
        byId('screen-detail').append(dialog);
        dialog.querySelector('#screen-preview-close').onclick = () => dialog.close();
        dialog.addEventListener('close',() => { if (attachmentPreviewUrl) { URL.revokeObjectURL(attachmentPreviewUrl); attachmentPreviewUrl = null; } });
        proofSection.querySelectorAll('[data-attachment]').forEach((button) => {
          button.onclick = async () => {
            const entry = attachments.find((value) => value.id === button.dataset.attachment);
            if (!entry) return;
            button.disabled = true;
            try {
              const current = auth();
              const response = await fetch('/api/hr/applications/' + encodeURIComponent(item.id) + '/attachments/' + encodeURIComponent(entry.id),{headers:{Authorization:'Bearer ' + current.token},cache:'no-store'});
              if (!response.ok) throw new Error(await readError(response));
              attachmentPreviewUrl = URL.createObjectURL(await response.blob());
              const media = document.createElement(entry.contentType.startsWith('image/') ? 'img' : 'iframe');
              media.src = attachmentPreviewUrl; media.title = entry.name;
              dialog.querySelector('#screen-preview-body').replaceChildren(media);
              dialog.querySelector('#screen-preview-title').textContent = entry.name;
              const download = dialog.querySelector('#screen-preview-download');
              download.href = attachmentPreviewUrl; download.download = entry.name;
              dialog.showModal();
            } catch (error) { showError('screen-detail-error',error.message || '无法查看佐证材料。'); }
            finally { button.disabled = false; }
          };
        });
      }
    }
    if (Array.isArray(item.corrections) && item.corrections.length) {
      const section = document.createElement('section');
      section.className = 'screen-corrections';
      section.innerHTML = '<h3>候选人更正申请</h3><ul>' + item.corrections.map((correction) => '<li><small>' + esc(dateLabel(correction.createdAt)) + '</small><p>' + esc(correction.message) + '</p></li>').join('') + '</ul>';
      byId('screen-detail').querySelector('.screen-review-current').after(section);
    }
    if (item.formalInterview && typeof item.formalInterview === 'object') {
      const formal = item.formalInterview;
      const status = ({prepared:'已准备',in_progress:'进行中',completed:'已完成'})[formal.status] || '处理中';
      const answers = Array.isArray(formal.answers) ? formal.answers : [];
      const section = document.createElement('section');
      section.className = 'card screen-panel screen-formal-interview';
      section.innerHTML = '<div class="screen-panel-heading"><h2>岗位 AI 初面记录</h2><span class="screen-state">' + esc(status) + '</span></div>'
        + '<p class="screen-panel-lead">基于岗位、简历和候选人实际回答生成分析；原始问答保留供 HR 复核。</p>'
        + '<p class="screen-formal-times">开始：' + esc(dateLabel(formal.startedAt)) + (formal.completedAt ? ' · 完成：' + esc(dateLabel(formal.completedAt)) : '') + '</p>'
        + '<h3>AI 问答分析</h3>' + interviewAnalysisHtml(formal)
        + '<details><summary>查看原始问答（' + answers.length + ' 题）</summary>' + (answers.length ? '<ol class="screen-formal-answers">' + answers.map((entry, index) => '<li><strong>问题 ' + (index + 1) + '：' + esc(entry.prompt || '未提供题目') + '</strong><p>' + esc(entry.answer || '未记录回答') + '</p><small>' + esc(dateLabel(entry.createdAt)) + '</small></li>').join('') + '</ol>' : '<p class="screen-empty-copy">暂无可显示的问答记录。</p>') + '</details>';
      byId('screen-detail').querySelectorAll('.screen-detail-column')[1].append(section);
    }
    if (match.scoreBasis) {
      const basis = document.createElement('p');
      basis.className = 'screen-score-basis';
      basis.textContent = '指标依据：' + (typeof match.scoreBasis === 'string' ? match.scoreBasis : JSON.stringify(match.scoreBasis));
      byId('screen-detail').querySelector('.screen-decision')?.after(basis);
    }
    byId('screen-download').onclick = async () => {
      const button = byId('screen-download'); button.disabled = true; button.textContent = '正在读取…';
      try {
        const current = auth();
        const response = await fetch('/api/hr/applications/' + encodeURIComponent(item.id) + '/resume',{headers:{Authorization:'Bearer ' + current.token},cache:'no-store'});
        if (!response.ok) throw new Error(await readError(response));
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a'); link.href = url; link.download = item.fileName || 'resume'; document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url),60000);
      } catch (error) { showError('screen-detail-error',error.message || '无法读取原始简历。'); }
      finally { button.disabled = false; button.textContent = '查看原始简历'; }
    };
    byId('screen-detail').querySelectorAll('[data-decision]').forEach((button) => {
      if (button.dataset.decision === 'invite' && ['ai_interview_invited','ai_interview_in_progress','ai_interview_completed'].includes(item.status)) {
        button.disabled = true;
        button.textContent = 'AI 辅助初面已安排';
      }
      button.onclick = async () => {
        byId('screen-detail').querySelectorAll('[data-decision]').forEach((node) => { node.disabled = true; });
        showError('screen-review-error','');
        try {
          const updated = await api('/api/hr/applications/' + encodeURIComponent(item.id) + '/review',{method:'POST',body:JSON.stringify({decision:button.dataset.decision,notes:byId('screen-review-notes').value.trim()})});
          drawDetail(updated);
        } catch (error) { showError('screen-review-error',error.message || '无法保存审核意见。'); byId('screen-detail').querySelectorAll('[data-decision]').forEach((node) => { node.disabled = false; }); }
      };
    });
    [['screen-retry-resume','/resume/retry'],['screen-retry-screening','/screening/retry'],['screen-retry-interview','/interview-analysis/retry']].forEach(([buttonId,path]) => {
      const button = byId(buttonId);
      if (!button) return;
      button.onclick = async () => {
        button.disabled = true;
        showError('screen-detail-error','');
        try {
          await api('/api/hr/applications/' + encodeURIComponent(item.id) + path,{method:'POST'});
          const refreshed = await api('/api/hr/applications/' + encodeURIComponent(item.id));
          drawDetail(refreshed);
        } catch (error) {
          showError('screen-detail-error',error.message || '重试失败。');
          button.disabled = false;
        }
      };
    });
    const grid = byId('screen-detail').querySelector('.screen-detail-grid');
    const columns = [...grid.querySelectorAll(':scope > .screen-detail-column')];
    const candidatePanel = columns[0].firstElementChild;
    const reviewPanel = [...columns[0].children].find((node) => node.querySelector('#screen-review-notes'));
    const reportPanel = columns[1].firstElementChild;
    const profileExtras = [...columns[0].children].filter((node) => node !== candidatePanel && node !== reviewPanel);
    const analysisExtras = [...columns[1].children].filter((node) => node !== reportPanel && node !== verificationPanel);
    const preview = item.candidatePreview || {};
    const education = previewText(preview.education?.[0] || profile.education?.[0] || resume.education?.[0]);
    const experience = previewText(preview.workExperience?.[0] || preview.projects?.[0] || resume.workExperience?.[0] || resume.projects?.[0]);
    const coreSkills = Array.isArray(preview.skills) ? preview.skills : Array.isArray(resume.skills) ? resume.skills : [];
    const overview = document.createElement('div');
    overview.className = 'screen-profile-grid';
    overview.innerHTML = '<div><span>学校 · 专业 · 学历</span><strong>' + esc(education || '待从简历中确认') + '</strong></div><div><span>主要经历</span><strong>' + esc(experience || '待从简历中确认') + '</strong></div><div><span>核心技能</span><strong>' + esc(coreSkills.slice(0,5).map(previewText).filter(Boolean).join(' · ') || '待从简历中确认') + '</strong></div>';
    const nameEdit = document.createElement('details');
    nameEdit.className = 'screen-name-edit';
    nameEdit.innerHTML = '<summary>更正候选人姓名</summary><form><label for="screen-candidate-name">核对原始简历后填写</label><div><input id="screen-candidate-name" class="input" required minlength="2" maxlength="80" value="' + esc(item.candidateName === '姓名待确认' ? '' : item.candidateName) + '" placeholder="候选人真实姓名"><button class="btn btn-ghost btn-sm" type="submit">保存更正</button></div><p class="screen-empty-copy">更正仅更新姓名，不覆盖原始简历与既有分析。</p></form>';
    nameEdit.querySelector('form').onsubmit = async (event) => {
      event.preventDefault();
      const button = nameEdit.querySelector('button'); button.disabled = true;
      showError('screen-detail-error','');
      try {
        await api('/api/hr/applications/' + encodeURIComponent(item.id) + '/candidate-name',{
          method:'PATCH',body:JSON.stringify({name:nameEdit.querySelector('input').value.trim()})
        });
        drawDetail(await api('/api/hr/applications/' + encodeURIComponent(item.id)));
      } catch (error) { showError('screen-detail-error',error.message || '姓名更正失败。'); button.disabled = false; }
    };
    candidatePanel.querySelector('.screen-resume-meta').after(overview,nameEdit);
    const resumeDetails = candidatePanel.querySelector('details:not(.screen-name-edit)');
    const structuredPanel = document.createElement('section');
    structuredPanel.className = 'card screen-panel'; structuredPanel.id = 'screen-structured';
    structuredPanel.innerHTML = '<div class="screen-panel-heading"><h2>完整结构化履历</h2><span>可按章节核对</span></div>' + (structuredResumeHtml(resume) || '<p class="screen-empty-copy">尚无结构化简历内容。</p>');
    resumeDetails?.remove();
    candidatePanel.id = 'screen-overview';
    reportPanel.id = 'screen-analysis';
    reviewPanel.id = 'screen-hr-review';
    const progressPanel = document.createElement('section');
    progressPanel.className = 'card screen-panel'; progressPanel.id = 'screen-progress';
    const assessmentPanel = document.createElement('section');
    assessmentPanel.className = 'card screen-panel'; assessmentPanel.id = 'screen-assessment';
    assessmentPanel.innerHTML = '<div class="screen-panel-heading"><h2>能力还原与多维评分</h2><span class="screen-state">读取中</span></div>';
    grid.replaceChildren(candidatePanel, ...profileExtras, progressPanel, reportPanel, assessmentPanel, verificationPanel, structuredPanel, ...analysisExtras, reviewPanel);
    const toc = document.createElement('nav');
    toc.className = 'screen-detail-toc'; toc.setAttribute('aria-label','报告章节');
    toc.innerHTML = '<a href="#screen-overview">候选人概况</a><a href="#screen-progress">分析进度</a><a href="#screen-analysis">AI 初筛</a><a href="#screen-assessment">能力与多维评分</a><a href="#screen-verification">公开核查</a><a href="#screen-structured">完整履历</a><a href="#screen-hr-review">HR 审核</a>';
    grid.before(toc);
    drawDetailProgress();
    clearTimeout(detailPoll);
    const formal = item.formalInterview;
    if (['queued','processing','screening'].includes(item.screeningStatus)
        || (formal && (formal.status === 'in_progress'
          || (formal.status === 'completed' && ['pending','queued','processing'].includes(formal.analysisStatus))))) {
      detailPoll = setTimeout(async () => {
        if (!byId('screen-detail')) return;
        try { drawDetail(await api('/api/hr/applications/' + encodeURIComponent(item.id))); }
        catch (error) { showError('screen-detail-error',error.message || '更新状态失败。'); }
      }, 12000);
    }
  }

  (async () => {
    const current = await core.initPage('resumes');
    if (current) renderWorkspace(); else renderAuth();
  })();
})();
