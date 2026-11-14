/* TTC company recruitment workspace. Interview pages remain in app.js. */
(function () {
  'use strict';
  const app = document.getElementById('screen-app');
  const accountNode = document.getElementById('screen-account');
  const authKey = 'ttc.recruitment.hr.auth';
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const byId = (id) => document.getElementById(id);
  let entries = [];
  let jobs = [];
  let sourceCounts = {total:0,candidatePortal:0,hrImport:0};
  let demoMode = false;
  let detailPoll = null;

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
      if (message) return message.slice(0, 220);
    } catch (_) { /* Keep generic message. */ }
    if (response.status === 401) return '登录已失效，请重新登录。';
    if (response.status === 403) return '当前账号没有该企业的访问权限。';
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
    return response.json();
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
  function processLabel(value) { return ({queued:'排队中',parsing:'解析中',screening:'初筛中',completed:'已完成',failed:'处理失败',skipped:'已跳过'})[value] || value || '待处理'; }
  function sourceLabel(value) { return value === 'hr_import' ? '企业录入' : '个人投递'; }
  function safeUrl(value) { try { const url = new URL(value); return ['https:','http:'].includes(url.protocol) ? url.href : ''; } catch (_) { return ''; } }
  function listStrings(values, empty) { return Array.isArray(values) && values.length ? '<ul>' + values.map((item) => '<li>' + esc(typeof item === 'string' ? item : item?.text || item?.requirement || JSON.stringify(item)) + '</li>').join('') + '</ul>' : '<p class="screen-empty-copy">' + esc(empty || '尚无资料') + '</p>'; }
  function reviewStatus(value) {
    const decision = value?.decision || value?.status || value;
    return ({invite:'已邀请',verify:'待进一步核验',hold:'暂缓',pending:'待审核'})[decision] || '待审核';
  }
  function scoreOf(item) { const value = item.matchScore ?? item.score ?? item.jobMatchScore ?? item.screening?.jobMatch?.score ?? item.screening?.report?.jobMatch?.score; return typeof value === 'number' && value >= 0 && value <= 100 ? Math.round(value) + '/100' : '证据不足'; }
  function reportOf(item) { return item.screening?.report || item.screening || null; }
  function updateAccount() {
    const current = auth();
    accountNode.innerHTML = demoMode ? '<span class="screen-account-name">本机演示 · 企业端</span>' : current ? '<span class="screen-account-name">' + esc(current.user.name || '招聘人员') + '</span><button class="btn btn-ghost btn-sm" id="screen-logout" type="button">退出</button>' : '<span class="screen-account-name">企业账户</span>';
    if (current && !demoMode) byId('screen-logout').onclick = () => { localStorage.removeItem(authKey); history.replaceState(null,'','screening.html'); renderAuth(); };
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
    const id = new URLSearchParams(location.search).get('id');
    if (id) renderDetail(id);
    else renderList();
  }

  function renderList() {
    app.innerHTML = '<div class="screen-heading"><div><span class="eyebrow">企业端 · 招聘流程</span><h1>简历初筛</h1><p>个人投递与企业录入统一保存、统计，并按岗位进行可复核的初筛。</p></div><div class="screen-heading-actions"><button id="screen-new-import" class="btn btn-primary" type="button">录入 PDF 简历</button><button id="screen-new-job" class="btn btn-ghost" type="button">发布岗位</button></div></div>'
      + '<form id="screen-job-form" class="card screen-job-form screen-hidden"><h2>发布招聘岗位</h2><p>岗位说明将作为简历初筛和后续面试的依据。</p><label for="new-job-title">岗位名称</label><input id="new-job-title" class="input" required maxlength="120" placeholder="例如：后端开发工程师"><label for="new-job-description">岗位职责与必备要求</label><textarea id="new-job-description" class="input" required minlength="30" maxlength="8000" rows="6" placeholder="写明职责、必备技能和经验要求，至少 30 字"></textarea><p id="screen-job-error" class="screen-error screen-hidden" role="alert"></p><div class="screen-form-actions"><button class="btn btn-primary" type="submit" id="screen-job-submit">发布岗位</button><button class="btn btn-ghost" type="button" id="screen-job-cancel">取消</button></div></form>'
      + '<form id="screen-import-form" class="card screen-job-form screen-hidden"><h2>录入企业已有简历</h2><p>选择本企业岗位，上传 PDF 后写入本地数据库，并进入与个人投递相同的解析和初筛队列。</p><label for="import-job">目标岗位</label><select id="import-job" class="input" required><option value="">请选择岗位</option></select><label for="import-name">候选人姓名（可选）</label><input id="import-name" class="input" maxlength="100" placeholder="不填则暂用文件名"><label for="import-resume">PDF 简历（最大 8 MB）</label><input id="import-resume" class="input" type="file" accept=".pdf,application/pdf" required><label class="screen-check"><input id="import-permission" type="checkbox" required><span>我确认企业已获得将此简历用于当前岗位招聘评估的授权。</span></label><p id="screen-import-error" class="screen-error screen-hidden" role="alert" tabindex="-1"></p><div class="screen-form-actions"><button class="btn btn-primary" type="submit" id="screen-import-submit">写入简历</button><button class="btn btn-ghost" type="button" id="screen-import-cancel">取消</button></div></form>'
      + '<p id="screen-import-success" class="screen-success screen-hidden" role="status"></p><section class="screen-source-stats" aria-label="简历来源统计"><div class="card"><span>简历总数</span><strong id="source-total">0</strong></div><div class="card"><span>个人端投递</span><strong id="source-candidate">0</strong></div><div class="card"><span>企业端录入</span><strong id="source-hr">0</strong></div></section>'
      + '<section class="screen-filters" aria-label="筛选申请"><label>岗位<select id="filter-job"><option value="">全部岗位</option></select></label><label>简历来源<select id="filter-source"><option value="">全部来源</option><option value="candidate_portal">个人投递</option><option value="hr_import">企业录入</option></select></label><label>申请状态<select id="filter-status"><option value="">全部状态</option><option value="hr_review">待 HR 审核</option><option value="ai_interview_invited">已邀 AI 辅助初面</option><option value="ai_interview_completed">AI 辅助初面完成</option><option value="failed">处理异常</option></select></label><label>审核重点<select id="filter-review"><option value="">全部</option><option value="manual">需要人工复核</option><option value="pending">待审核</option></select></label><label>录入时间<input id="filter-date" type="date"></label></section>'
      + '<p id="screen-list-error" class="screen-error screen-hidden" role="alert"></p><div class="screen-table-wrap"><table class="screen-table"><thead><tr><th>候选人 / 岗位</th><th>来源</th><th>录入时间</th><th>申请进度</th><th>处理状态</th><th>匹配指标</th><th>初筛建议</th><th>HR 审核</th><th></th></tr></thead><tbody id="screen-rows"><tr><td colspan="9">正在读取申请…</td></tr></tbody></table></div>';
    const form = byId('screen-job-form');
    const importForm = byId('screen-import-form');
    byId('screen-new-job').onclick = () => { form.classList.remove('screen-hidden'); byId('new-job-title').focus(); };
    byId('screen-job-cancel').onclick = () => form.classList.add('screen-hidden');
    byId('screen-new-import').onclick = () => { importForm.classList.remove('screen-hidden'); byId('screen-import-success').classList.add('screen-hidden'); byId('import-job').focus(); };
    byId('screen-import-cancel').onclick = () => importForm.classList.add('screen-hidden');
    importForm.onsubmit = async (event) => {
      event.preventDefault();
      showError('screen-import-error','');
      const file = byId('import-resume').files[0];
      if (!file || !/\.pdf$/i.test(file.name) || file.size > 8 * 1024 * 1024) {
        showError('screen-import-error','请选择不超过 8 MB 的 PDF 简历。');
        byId('screen-import-error').focus();
        return;
      }
      const button = byId('screen-import-submit'); button.disabled = true; button.textContent = '正在写入…';
      const body = new FormData();
      body.append('jobId',byId('import-job').value);
      body.append('candidateName',byId('import-name').value.trim());
      body.append('permissionConfirmed',String(byId('import-permission').checked));
      body.append('resume',file);
      try {
        const result = await api('/api/hr/resumes/import',{method:'POST',body});
        importForm.reset(); importForm.classList.add('screen-hidden');
        const notice = byId('screen-import-success');
        notice.innerHTML = '简历已写入，正在解析和初筛。<a href="screening.html?id=' + encodeURIComponent(result.application.id) + '">查看详情 →</a>';
        notice.classList.remove('screen-hidden');
        await loadList();
      } catch (error) { showError('screen-import-error',error.message || '写入失败。'); byId('screen-import-error').focus(); }
      finally { button.disabled = false; button.textContent = '写入简历'; }
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
    ['filter-job','filter-source','filter-status','filter-review','filter-date'].forEach((id) => { byId(id).onchange = drawRows; });
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
        importJob.value = selected;
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
  function drawRows() {
    const body = byId('screen-rows');
    if (!body) return;
    const job = byId('filter-job').value, source = byId('filter-source').value, status = byId('filter-status').value, review = byId('filter-review').value, date = byId('filter-date').value;
    const shown = entries.filter((item) => (!job || item.jobTitle === job) && (!source || item.source === source) && (!status || item.status === status) && (!date || dateISO(item.createdAt) === date) && (!review || (review === 'manual' ? ['manual_review','insufficient_evidence'].includes(item.recommendation || reportOf(item)?.screeningRecommendation) || item.reviewStatus === 'verify' : !item.reviewStatus)));
    body.innerHTML = shown.length ? shown.map((item) => '<tr><td><strong>' + esc(item.candidateName || '候选人') + '</strong><small>' + esc(item.jobTitle || '目标岗位') + '</small></td><td><span class="screen-state">' + sourceLabel(item.source) + '</span></td><td>' + esc(dateLabel(item.createdAt)) + '</td><td><span class="screen-state">' + esc(statusLabel(item.status)) + '</span></td><td>' + esc(processLabel(item.resumeStatus)) + ' / ' + esc(processLabel(item.screeningStatus)) + '</td><td>' + esc(scoreOf(item)) + '</td><td>' + esc(recommendationLabel(item.recommendation || reportOf(item)?.screeningRecommendation)) + '</td><td>' + esc(reviewStatus(item.review || item.reviewStatus)) + '</td><td><a class="screen-detail-link" href="screening.html?id=' + encodeURIComponent(item.id) + '">查看详情 →</a></td></tr>').join('') : '<tr><td colspan="9" class="screen-no-rows">没有符合条件的申请。</td></tr>';
  }

  async function renderDetail(id) {
    app.innerHTML = '<a class="screen-back" href="screening.html">← 返回初筛列表</a><p id="screen-detail-error" class="screen-error screen-hidden" role="alert"></p><div id="screen-detail"><p class="muted">正在读取候选人资料…</p></div>';
    try { const item = await api('/api/hr/applications/' + encodeURIComponent(id)); drawDetail(item); }
    catch (error) { showError('screen-detail-error',error.message || '无法读取详情。'); }
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
    const sections = [['工作经历',resume.workExperience],['项目经历',resume.projects],['教育经历',resume.education]];
    const body = sections.map(([label,items]) => {
      if (!Array.isArray(items) || !items.length) return '';
      return '<h3>' + label + '</h3><div class="screen-structured-list">' + items.map((entry) => '<div>' + esc(typeof entry === 'string' ? entry : Object.values(entry || {}).filter((value) => typeof value === 'string' && value).join(' · ')) + '</div>').join('') + '</div>';
    }).join('');
    const skills = Array.isArray(resume.skills) && resume.skills.length ? '<h3>技能</h3>' + listStrings(resume.skills) : '';
    const links = Array.isArray(resume.portfolioLinks) && resume.portfolioLinks.length ? '<h3>职业作品链接</h3><ul>' + resume.portfolioLinks.map((value) => { const url = safeUrl(value); return '<li>' + (url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(url) + '</a>' : esc(value)) + '</li>'; }).join('') + '</ul>' : '';
    return body + skills + links;
  }
  function drawDetail(item) {
    const sourceReport = reportOf(item);
    const report = sourceReport ? {...sourceReport, externalEvidence: item.evidence || sourceReport.externalEvidence} : null;
    const resume = item.parsedResume || {};
    const match = report?.jobMatch || {};
    const recommendation = report?.screeningRecommendation || item.recommendation;
    const review = item.review || {};
    const interviewPath = typeof item.invitation?.interviewPath === 'string' && item.invitation.interviewPath.startsWith('/classic/?room=') ? item.invitation.interviewPath : '';
    const title = esc(item.jobTitle || '目标岗位');
    byId('screen-detail').innerHTML = '<div class="screen-detail-heading"><div><span class="eyebrow">候选人 · ' + esc(statusLabel(item.status)) + '</span><h1>' + esc(item.candidateName || '候选人') + '</h1><p>' + title + ' · ' + sourceLabel(item.source) + '于 ' + esc(dateLabel(item.createdAt)) + '</p></div><div class="screen-heading-actions"><button id="screen-download" type="button" class="btn btn-ghost">查看原始简历</button>' + (interviewPath ? '<a class="btn btn-primary" href="' + esc(interviewPath) + '">人工面试房间（AI 辅助）</a>' : '') + '</div></div>'
      + '<div class="screen-detail-grid"><div class="screen-detail-column"><section class="card screen-panel"><div class="screen-panel-heading"><h2>候选人资料</h2><span>' + esc(processLabel(item.resumeStatus)) + '</span></div><div class="screen-resume-meta"><span>来源</span><strong>' + sourceLabel(item.source) + '</strong><span>姓名</span><strong>' + esc(resume.name || item.candidateName || '未提取') + '</strong><span>联系方式</span><strong>' + esc(item.candidateEmail || resume.contact?.email || '未提供') + '</strong>' + (item.uploadedBy ? '<span>企业录入人</span><strong>' + esc(item.uploadedBy) + '</strong>' : '') + '</div><p class="screen-panel-lead">以下分析引用简历中的具体内容；原始文件可在页面顶部下载核对。</p><details><summary>查看解析后的简历结构</summary>' + (structuredResumeHtml(resume) || '<p class="screen-empty-copy">尚无结构化简历内容。</p>') + '</details></section>'
      + '<section class="card screen-panel"><h2>HR 人工审核</h2><p class="screen-panel-lead">审核意见用于记录企业内部的核验要点与决策依据；AI 结论只供参考，最终由 HR 判断。</p>' + (item.source === 'hr_import' ? '<p class="screen-import-note">企业录入简历尚未关联候选人账号，可先审核；线上初面邀请暂不可用。</p>' : '') + '<p class="screen-review-current">当前状态：' + esc(reviewStatus(review)) + (review.notes ? ' · ' + esc(review.notes) : '') + '</p><label for="screen-review-notes">内部审核意见</label><textarea id="screen-review-notes" class="input" rows="4" maxlength="2000" placeholder="记录待核实的经历、追问结果及处理依据">' + esc(review.notes || '') + '</textarea><p id="screen-review-error" class="screen-error screen-hidden" role="alert"></p><div class="screen-review-actions">' + (item.source === 'hr_import' ? '' : '<button type="button" data-decision="invite" class="btn btn-primary">邀请 AI 辅助初面</button>') + '<button type="button" data-decision="verify" class="btn btn-ghost">进一步核验</button><button type="button" data-decision="hold" class="btn btn-ghost">暂缓申请</button></div></section></div>'
      + '<div class="screen-detail-column"><section class="card screen-panel"><div class="screen-panel-heading"><h2>AI 初筛报告</h2><span>' + esc(processLabel(item.screeningStatus)) + '</span></div>'
      + (report ? '<p class="screen-model-note">分析模型：' + esc(item.screeningMeta?.model || 'DeepSeek') + '</p><p class="screen-panel-lead">' + esc(report.candidateSummary || '报告未提供候选人概览。') + '</p><div class="screen-decision"><span>岗位匹配指标</span><strong>' + esc(scoreOf(item)) + '</strong><small>辅助指标；缺少证据时不评分</small></div><h3>经历内容与待核实点</h3>' + substanceHtml(report.substanceSignals) + '<h3>匹配的要求</h3>' + listStrings(match.matchedRequirements,'暂无有证据支持的匹配项。') + '<h3>岗位能力缺口</h3>' + listStrings(match.missingRequirements,'未发现明确缺口，或岗位资料不足。') + '<h3>匹配依据</h3>' + evidenceHtml(match.evidence) + '<h3>有证据的优势</h3>' + listStrings(report.strengths,'暂无可说明的优势。') + '<h3>需要核实的声明</h3>' + claimHtml(report.resumeClaims) + '<h3>其他核验重点</h3>' + listStrings(report.areasToVerify,'暂无补充事项。') + '<h3>面试问题</h3>' + listStrings(report.interviewQuestions,'初筛完成后生成。') + '<h3>初筛建议</h3><div class="screen-recommendation"><strong>' + esc(recommendationLabel(recommendation)) + '</strong>' + listStrings(report.recommendationReasons,'请结合完整报告人工判断。') + '</div><h3>外部证据</h3>' + evidenceHtml(report.externalEvidence) + '<h3>分析限制</h3>' + listStrings(report.limitations,'请结合原始简历人工核验。') : '<div class="screen-pending"><p>' + (item.screeningStatus === 'failed' ? '初筛处理失败，可重新运行。' : '初筛处理中，完成后自动显示分析。') + '</p>' + (item.screeningError ? '<small>' + esc(item.screeningError) + '</small>' : '') + (item.screeningStatus === 'failed' ? '<button type="button" id="screen-retry-screening" class="btn btn-ghost btn-sm">重新运行初筛</button>' : '') + '</div>')
      + '</section></div></div>';
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
    [['screen-retry-screening','/screening/retry'],['screen-retry-interview','/interview-analysis/retry']].forEach(([buttonId,path]) => {
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
    try {
      demoMode = Boolean((await api('/api/auth/demo-mode', {}, false)).enabled);
      if (demoMode) {
        saveAuth(await api('/api/auth/demo/hr', {method:'POST'}, false));
        renderWorkspace();
        return;
      }
    } catch (_) { /* Normal login remains available if demo bootstrap is unavailable. */ }
    if (auth()) renderWorkspace(); else renderAuth();
  })();
})();
