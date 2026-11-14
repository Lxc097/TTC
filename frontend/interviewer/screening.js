/* 企业端「查看简历」：登录、AI 初筛标准、卡片 / 列表演示与完整详情。
 *
 * 所有共享函数都在 recruitment-core.js（window.TTCWorkspace）。
 * 本文件只关心这一页的四个视图：登录、初筛标准、双视图、简历详情。
 */
(function () {
  'use strict';
  const core = window.TTCWorkspace;
  const app = document.getElementById('screen-app');
  const byId = (id) => document.getElementById(id);
  const esc = core.esc;

  const state = {
    entries: [],
    jobs: [],
    counts: { total: 0, candidatePortal: 0, hrImport: 0 },
    view: localStorage.getItem('ttc.recruitment.view') === 'list' ? 'list' : 'cards',
    index: 0,
    expandedId: '',
    details: new Map(),
    pending: new Set(),
    failed: new Set(),
    detailPoll: null,
  };

  // ---------- 启动与路由 ----------
  (async () => {
    const current = await core.initPage('resumes');
    if (!current) { renderAuth(); return; }
    route();
  })();

  window.addEventListener('hashchange', () => {
    if (!core.auth()) return;
    route();
  });
  document.addEventListener('keydown', boardKeys);

  function route() {
    const hash = (location.hash || '').replace(/^#\/?/, '');
    if (!hash) {
      const id = core.query('id');
      if (id) { renderDetail(id); return; }
      renderBoard();
      return;
    }
    if (hash === 'criteria') renderCriteria();
    else renderBoard();
  }

  // ---------- 登录 ----------
  function renderAuth() {
    let mode = 'login';
    const draw = () => {
      app.innerHTML = '<div class="screen-auth-layout"><div class="screen-auth-copy"><span class="eyebrow">企业招聘工作台</span><h1>让每一次审核，<br>都有清楚依据。</h1><p>查看岗位匹配证据与 AI 初面结果，推进真人面试并留下可回看的记录。最终招聘决定由企业人员作出。</p></div><section class="card screen-auth-card"><div class="screen-tabs"><button id="screen-login" type="button" class="' + (mode === 'login' ? 'active' : '') + '">登录</button><button id="screen-register" type="button" class="' + (mode === 'register' ? 'active' : '') + '">创建企业账户</button></div><h2>' + (mode === 'login' ? '登录工作台' : '创建企业账户') + '</h2><form id="screen-auth-form">'
        + (mode === 'register' ? '<label for="screen-name">姓名</label><input id="screen-name" class="input" maxlength="80" autocomplete="name" required placeholder="招聘人员姓名"><label for="screen-company">企业名称</label><input id="screen-company" class="input" maxlength="120" required placeholder="企业名称">' : '')
        + '<label for="screen-email">邮箱</label><input id="screen-email" class="input" type="email" autocomplete="email" required placeholder="name@company.com"><label for="screen-password">密码</label><input id="screen-password" class="input" type="password" autocomplete="' + (mode === 'login' ? 'current-password' : 'new-password') + '" minlength="10" required placeholder="至少 10 位">'
        + (mode === 'register' ? '<label for="screen-code">企业注册授权码</label><input id="screen-code" class="input" type="password" required autocomplete="off" placeholder="由平台管理员提供"><p class="screen-hint">授权码用于限制企业账户注册；请勿发送给候选人。</p>' : '')
        + '<p id="screen-auth-error" class="screen-error screen-hidden" role="alert"></p><button id="screen-auth-submit" type="submit" class="btn btn-primary">' + (mode === 'login' ? '登录工作台' : '创建账户') + '</button></form></section></div>';
      byId('screen-login').onclick = () => { mode = 'login'; draw(); };
      byId('screen-register').onclick = () => { mode = 'register'; draw(); };
      byId('screen-auth-form').onsubmit = async (event) => {
        event.preventDefault();
        const button = byId('screen-auth-submit');
        button.disabled = true; button.textContent = '正在处理…'; showError('screen-auth-error', '');
        try {
          const payload = { email: byId('screen-email').value.trim(), password: byId('screen-password').value };
          if (mode === 'register') Object.assign(payload, { name: byId('screen-name').value.trim(), role: 'hr', companyName: byId('screen-company').value.trim(), hrRegistrationCode: byId('screen-code').value });
          const result = await core.api('/api/auth/' + mode, { method: 'POST', body: JSON.stringify(payload) }, false);
          if (!result || typeof result.token !== 'string' || result.user?.role !== 'hr') throw new Error('请使用企业招聘人员账户登录。');
          core.saveAuth(result);
          core.mountNav('resumes');
          history.replaceState(null, '', 'screening.html#/board');
          route();
        } catch (error) { showError('screen-auth-error', error.message || '无法完成登录。'); }
        finally { button.disabled = false; button.textContent = mode === 'login' ? '登录工作台' : '创建账户'; }
      };
    };
    draw();
  }

  function showError(id, message) {
    const node = byId(id);
    if (!node) return;
    node.textContent = message || '';
    node.classList.toggle('screen-hidden', !message);
  }

  function subnav(active) {
    return '<nav class="ws-subnav" aria-label="查看简历">'
      + '<a href="#/board" class="' + (active === 'board' ? 'active' : '') + '">筛选后的简历</a>'
      + '<a href="#/criteria" class="' + (active === 'criteria' ? 'active' : '') + '">AI 初筛标准</a>'
      + '</nav>';
  }

  function pageHead(title, desc, actions) {
    return '<div class="screen-heading"><div><span class="eyebrow">企业端 · 招聘工作台</span><h1>' + esc(title) + '</h1><p>' + esc(desc) + '</p></div>'
      + (actions ? '<div class="screen-heading-actions">' + actions + '</div>' : '') + '</div>';
  }

  // ---------- 初筛标准 ----------
  async function renderCriteria() {
    app.innerHTML = subnav('criteria')
      + pageHead('AI 初筛标准', '由 HR 自己写。标准会作为评估维度进入 AI 初筛，但不会改变输出结构，也不会替 HR 做决定。')
      + '<div id="criteria-error" class="screen-error screen-hidden" role="alert"></div>'
      + '<section class="card ws-criteria" id="criteria-panel"><p class="muted">正在读取岗位…</p></section>';
    try {
      const result = await core.api('/api/hr/jobs');
      state.jobs = Array.isArray(result.items) ? result.items : [];
    } catch (error) {
      byId('criteria-panel').innerHTML = '<p class="screen-error">' + esc(error.message || '无法读取岗位。') + '</p>';
      return;
    }
    if (!state.jobs.length) {
      byId('criteria-panel').innerHTML = '<h2>还没有岗位</h2><p class="ws-empty-copy">先发布一个岗位，初筛标准按岗位保存。</p><a class="btn btn-primary" href="#/board">去发布岗位 →</a>';
      return;
    }
    const options = state.jobs.map((job) => '<option value="' + esc(job.id) + '">' + esc(job.title) + '</option>').join('');
    byId('criteria-panel').innerHTML = '<div class="ws-criteria-head"><div><h2>按岗位填写初筛标准</h2>'
      + '<p class="ws-empty-copy">例如：必备技能、经验年限、必须能说明个人贡献、需要重点核实的项目证据。留空表示只用岗位 JD。</p></div>'
      + '<label class="ws-field"><span>岗位</span><select id="criteria-job" class="input">' + options + '</select></label></div>'
      + '<label class="ws-field"><span>初筛标准（最多 4000 字）</span><textarea id="criteria-text" class="input" rows="9" maxlength="4000" placeholder="1. 必须能说清项目中的个人贡献&#10;2. 3 年以上前端经验，React / TypeScript 为主&#10;3. 有可核查的性能优化结果"></textarea></label>'
      + '<p class="ws-meta" id="criteria-meta"></p>'
      + '<div class="ws-actions"><button id="criteria-save" class="btn btn-primary" type="button">保存标准</button><span class="ws-hint">保存后对新提交的初筛任务生效；已完成的报告不会重算。</span></div>';
    const select = byId('criteria-job');
    const textarea = byId('criteria-text');
    const showJob = () => {
      const job = state.jobs.find((item) => item.id === select.value);
      textarea.value = job?.screeningCriteria || '';
      byId('criteria-meta').textContent = job?.criteriaUpdatedAt
        ? '上次保存：' + core.dateLabel(job.criteriaUpdatedAt)
        : '还没有保存过标准，当前只用岗位 JD。';
    };
    select.onchange = showJob;
    showJob();
    byId('criteria-save').onclick = async () => {
      const button = byId('criteria-save');
      button.disabled = true; button.textContent = '正在保存…';
      showError('criteria-error', '');
      try {
        const saved = await core.api('/api/hr/jobs/' + encodeURIComponent(select.value) + '/criteria',
          { method: 'PUT', body: JSON.stringify({ criteria: textarea.value.trim() }) });
        const job = state.jobs.find((item) => item.id === select.value);
        if (job) { job.screeningCriteria = saved.screeningCriteria; job.criteriaUpdatedAt = saved.updatedAt; }
        byId('criteria-meta').textContent = '已保存：' + core.dateLabel(saved.updatedAt);
        core.toast('初筛标准已保存', 'ok');
      } catch (error) { showError('criteria-error', error.message || '保存失败。'); }
      finally { button.disabled = false; button.textContent = '保存标准'; }
    };
  }

  // ---------- 筛选后的简历 ----------
  function renderBoard() {
    const viewToggle = '<div class="ws-seg" role="group" aria-label="展示方式">'
      + '<button type="button" data-view="cards" class="' + (state.view === 'cards' ? 'on' : '') + '">卡片翻页</button>'
      + '<button type="button" data-view="list" class="' + (state.view === 'list' ? 'on' : '') + '">列表</button></div>';
    app.innerHTML = subnav('board')
      + pageHead('查看简历', '先看 AI 初筛的岗位匹配证据，再决定邀请或暂缓。顺序固定为 能力 → 竞赛 → 项目。',
        '<button id="screen-new-import" class="btn btn-ghost" type="button">录入 PDF 简历</button><button id="screen-new-job" class="btn btn-primary" type="button">发布岗位</button>')
      + jobFormHtml() + importFormHtml()
      + '<p id="screen-import-success" class="screen-success screen-hidden" role="status"></p>'
      + '<section class="screen-source-stats" aria-label="简历来源统计">'
      + '<div class="card"><span>简历总数</span><strong id="source-total">0</strong></div>'
      + '<div class="card"><span>个人端投递</span><strong id="source-candidate">0</strong></div>'
      + '<div class="card"><span>企业端录入</span><strong id="source-hr">0</strong></div></section>'
      + '<div class="ws-toolbar"><div class="screen-filters" aria-label="筛选申请">'
      + '<label>岗位<select id="filter-job"><option value="">全部岗位</option></select></label>'
      + '<label>来源<select id="filter-source"><option value="">全部来源</option><option value="candidate_portal">个人投递</option><option value="hr_import">企业录入</option></select></label>'
      + '<label>阶段<select id="filter-stage"><option value="">全部阶段</option><option value="applied">投递与初筛</option><option value="ai_interview">AI 初面</option><option value="human_interview">真人面试</option><option value="ended">流程结束</option></select></label>'
      + '<label>审核重点<select id="filter-review"><option value="">全部</option><option value="manual">需要人工复核</option><option value="pending">还没审核</option></select></label>'
      + '<label>录入时间<input id="filter-date" type="date"></label>'
      + '</div>' + viewToggle + '</div>'
      + '<p id="screen-list-error" class="screen-error screen-hidden" role="alert"></p>'
      + '<div id="screen-board" class="ws-board"><p class="muted">正在读取申请…</p></div>';
    bindBoardEvents();
    loadJobs();
    loadList();
    clearInterval(state.refreshTimer);
    state.refreshTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && byId('screen-board')) loadList({ silent: true });
    }, 20000);
  }

  function jobFormHtml() {
    return '<form id="screen-job-form" class="card screen-job-form screen-hidden"><h2>发布招聘岗位</h2><p>岗位说明将作为简历初筛和后续面试的依据。</p><label for="new-job-title">岗位名称</label><input id="new-job-title" class="input" required maxlength="120" placeholder="例如：后端开发工程师"><label for="new-job-description">岗位职责与必备要求</label><textarea id="new-job-description" class="input" required minlength="30" maxlength="8000" rows="6" placeholder="写明职责、必备技能和经验要求，至少 30 字"></textarea><p id="screen-job-error" class="screen-error screen-hidden" role="alert"></p><div class="screen-form-actions"><button class="btn btn-primary" type="submit" id="screen-job-submit">发布岗位</button><button class="btn btn-ghost" type="button" id="screen-job-cancel">取消</button></div></form>';
  }
  function importFormHtml() {
    return '<form id="screen-import-form" class="card screen-job-form screen-hidden"><h2>录入企业已有简历</h2><p>选择本企业岗位，上传 PDF 后写入本地数据库，并进入与个人投递相同的解析和初筛队列。</p><label for="import-job">目标岗位</label><select id="import-job" class="input" required><option value="">请选择岗位</option></select><label for="import-name">候选人姓名（可选）</label><input id="import-name" class="input" maxlength="100" placeholder="不填则暂用文件名"><label for="import-resume">PDF 简历（最大 8 MB）</label><input id="import-resume" class="input" type="file" accept=".pdf,application/pdf" required><label class="screen-check"><input id="import-permission" type="checkbox" required><span>我确认企业已获得将此简历用于当前岗位招聘评估的授权。</span></label><p id="screen-import-error" class="screen-error screen-hidden" role="alert" tabindex="-1"></p><div class="screen-form-actions"><button class="btn btn-primary" type="submit" id="screen-import-submit">写入简历</button><button class="btn btn-ghost" type="button" id="screen-import-cancel">取消</button></div></form>';
  }

  function bindBoardEvents() {
    const jobForm = byId('screen-job-form');
    const importForm = byId('screen-import-form');
    byId('screen-new-job').onclick = () => { jobForm.classList.remove('screen-hidden'); byId('new-job-title').focus(); };
    byId('screen-job-cancel').onclick = () => jobForm.classList.add('screen-hidden');
    byId('screen-new-import').onclick = () => { importForm.classList.remove('screen-hidden'); byId('screen-import-success').classList.add('screen-hidden'); byId('import-job').focus(); };
    byId('screen-import-cancel').onclick = () => importForm.classList.add('screen-hidden');
    importForm.onsubmit = async (event) => {
      event.preventDefault();
      showError('screen-import-error', '');
      const file = byId('import-resume').files[0];
      if (!file || !/\.pdf$/i.test(file.name) || file.size > 8 * 1024 * 1024) {
        showError('screen-import-error', '请选择不超过 8 MB 的 PDF 简历。');
        byId('screen-import-error').focus();
        return;
      }
      const button = byId('screen-import-submit');
      button.disabled = true; button.textContent = '正在写入…';
      const body = new FormData();
      body.append('jobId', byId('import-job').value);
      body.append('candidateName', byId('import-name').value.trim());
      body.append('permissionConfirmed', String(byId('import-permission').checked));
      body.append('resume', file);
      try {
        const result = await core.api('/api/hr/resumes/import', { method: 'POST', body });
        importForm.reset(); importForm.classList.add('screen-hidden');
        const notice = byId('screen-import-success');
        notice.innerHTML = '简历已写入，正在解析和初筛。<a href="screening.html?id=' + encodeURIComponent(result.application.id) + '">查看详情 →</a>';
        notice.classList.remove('screen-hidden');
        await loadList();
      } catch (error) {
        showError('screen-import-error', error.message || '写入失败。');
        byId('screen-import-error').focus();
      } finally { button.disabled = false; button.textContent = '写入简历'; }
    };
    jobForm.onsubmit = async (event) => {
      event.preventDefault();
      const button = byId('screen-job-submit');
      button.disabled = true; button.textContent = '正在发布…';
      showError('screen-job-error', '');
      try {
        await core.api('/api/hr/jobs', { method: 'POST', body: JSON.stringify({ title: byId('new-job-title').value.trim(), description: byId('new-job-description').value.trim() }) });
        jobForm.reset(); jobForm.classList.add('screen-hidden');
        await loadJobs(); await loadList();
      } catch (error) { showError('screen-job-error', error.message || '发布失败。'); }
      finally { button.disabled = false; button.textContent = '发布岗位'; }
    };
    ['filter-job', 'filter-source', 'filter-stage', 'filter-review', 'filter-date'].forEach((id) => { byId(id).onchange = drawBoard; });
    document.querySelectorAll('[data-view]').forEach((button) => {
      button.onclick = () => {
        state.view = button.dataset.view;
        state.index = 0;
        localStorage.setItem('ttc.recruitment.view', state.view);
        document.querySelectorAll('[data-view]').forEach((node) => node.classList.toggle('on', node === button));
        drawBoard();
      };
    });
  }

  function boardKeys(event) {
    if (state.view !== 'cards' || !byId('screen-board')) return;
    if (event.target && /input|textarea|select/i.test(event.target.tagName)) return;
    if (event.key === 'ArrowLeft') { state.index = Math.max(0, state.index - 1); drawBoard(); }
    if (event.key === 'ArrowRight') { state.index += 1; drawBoard(); }
  }

  async function loadJobs() {
    try {
      const result = await core.api('/api/hr/jobs');
      state.jobs = Array.isArray(result.items) ? result.items : [];
      const importJob = byId('import-job');
      if (importJob) {
        const selected = importJob.value;
        importJob.innerHTML = '<option value="">请选择岗位</option>'
          + state.jobs.map((job) => '<option value="' + esc(job.id) + '">' + esc(job.title) + '</option>').join('');
        importJob.value = selected;
      }
    } catch (_) { /* the list still works without job options */ }
  }

  async function loadList(options) {
    try {
      const result = await core.api('/api/hr/applications');
      state.entries = Array.isArray(result.items) ? result.items : [];
      state.counts = result.counts || { total: 0, candidatePortal: 0, hrImport: 0 };
      byId('source-total').textContent = state.counts.total || 0;
      byId('source-candidate').textContent = state.counts.candidatePortal || 0;
      byId('source-hr').textContent = state.counts.hrImport || 0;
      const select = byId('filter-job');
      if (select) {
        const value = select.value;
        const titles = [...new Set(state.entries.map((item) => item.jobTitle).filter(Boolean))];
        select.innerHTML = '<option value="">全部岗位</option>'
          + titles.map((title) => '<option value="' + esc(title) + '">' + esc(title) + '</option>').join('');
        select.value = value;
      }
      showError('screen-list-error', '');
      drawBoard();
    } catch (error) {
      if (!options?.silent) showError('screen-list-error', error.message || '无法读取申请。');
    }
  }

  function filteredEntries() {
    const job = byId('filter-job')?.value || '';
    const source = byId('filter-source')?.value || '';
    const stage = byId('filter-stage')?.value || '';
    const review = byId('filter-review')?.value || '';
    const date = byId('filter-date')?.value || '';
    return state.entries.filter((item) => (!job || item.jobTitle === job)
      && (!source || item.source === source)
      && (!stage || item.stage === stage)
      && (!date || core.dateISO(item.createdAt) === date)
      && (!review || (review === 'manual'
        ? ['manual_review', 'insufficient_evidence'].includes(item.recommendation || core.reportOf(item)?.screeningRecommendation) || item.reviewStatus === 'verify'
        : !item.reviewStatus)));
  }

  function drawBoard() {
    const host = byId('screen-board');
    if (!host) return;
    const shown = filteredEntries();
    if (!shown.length) {
      host.innerHTML = '<div class="ws-empty"><h2>没有符合条件的简历</h2><p>调整筛选条件，或从个人端 / 企业录入补充简历。</p></div>';
      return;
    }
    if (state.view === 'cards') drawCards(host, shown);
    else drawList(host, shown);
  }

  // ---------- 卡片翻页 ----------
  function drawCards(host, shown) {
    state.index = Math.max(0, Math.min(state.index, shown.length - 1));
    const item = shown[state.index];
    host.innerHTML = '<div class="ws-card-wrap">' + cardHtml(item, state.index, shown.length, state.details.get(item.id)) + '</div>';
    const detail = state.details.get(item.id);
    if (!detail && !state.pending.has(item.id) && !state.failed.has(item.id)) {
      loadDetail(item.id).then((value) => { if (!value) state.failed.add(item.id); drawBoard(); });
    }
    bindCardActions(host, item, detail || null, shown.length);
  }

  function cardHtml(item, index, total, detail) {
    const report = core.reportOf(item) || {};
    const recommended = item.recommendation || report.screeningRecommendation;
    const invited = ['ai_interview_invited', 'ai_interview_in_progress', 'ai_interview_completed', 'hr_interview_invited', 'closed'].includes(item.status);
    const imported = item.source === 'hr_import';
    return '<article class="ws-card" aria-label="候选人 ' + esc(item.candidateName || '候选人') + '">'
      + '<header class="ws-card-head"><div><span class="eyebrow">候选人 ' + (index + 1) + ' / ' + total + '</span>'
      + '<h2>' + esc(item.candidateName || '候选人') + '</h2>'
      + '<p>' + esc(item.jobTitle || '目标岗位') + ' · ' + esc(core.sourceLabel(item.source)) + ' · ' + esc(core.dateLabel(item.createdAt)) + '</p></div>'
      + '<div class="ws-card-score"><span>初筛建议</span><strong>' + esc(core.recommendationLabel(recommended)) + '</strong>'
      + '<small>匹配指标 ' + esc(core.scoreLabel(item)) + '</small>' + core.stageChip(item.stage) + '</div></header>'
      + '<div class="ws-card-body">' + resumeBlocks(item, detail) + interviewHint(detail) + '</div>'
      + '<footer class="ws-card-actions">'
      + '<button type="button" class="btn btn-primary" data-card-action="invite"' + (invited || imported ? ' disabled' : '') + '>'
      + (invited ? '已发送邀请' : imported ? '企业录入不可邀请' : '发送 AI 面试邀请') + '</button>'
      + '<button type="button" class="btn btn-ghost" data-card-action="skip"' + (invited ? ' disabled' : '') + '>跳过（暂缓）</button>'
      + '<button type="button" class="btn btn-ghost" data-card-action="resume">查看原简历</button>'
      + '<a class="btn btn-ghost" href="screening.html?id=' + encodeURIComponent(item.id) + '">完整详情</a>'
      + '</footer>'
      + '<nav class="ws-card-nav" aria-label="翻页">'
      + '<button type="button" class="btn btn-ghost btn-sm" data-card-action="prev"' + (index === 0 ? ' disabled' : '') + '>← 上一个</button>'
      + '<span>' + (index + 1) + ' / ' + total + '</span>'
      + '<button type="button" class="btn btn-ghost btn-sm" data-card-action="next"' + (index >= total - 1 ? ' disabled' : '') + '>下一个 →</button>'
      + '</nav></article>';
  }

  function resumeBlocks(item, detail) {
    const resume = detail?.parsedResume || {};
    const report = core.reportOf(item) || {};
    const match = report.jobMatch || {};
    const skills = [...new Set([...(resume.skills || []), ...(resume.certifications || []), ...(match.matchedRequirements || [])])];
    const competitions = [...(resume.competitions || []).map((entry) => entry?.text || entry),
      ...(resume.achievements || [])].filter(Boolean);
    const projects = (resume.projects || []).map((entry) => entry?.text || entry).filter(Boolean);
    const block = (title, body) => '<section class="ws-resume-block"><h3>' + title + '</h3>' + body + '</section>';
    const chips = (values) => '<div class="ws-tags">' + values.slice(0, 8).map((value) => '<span class="chip gray">' + esc(value) + '</span>').join('') + '</div>';
    const lines = (values) => '<ul class="ws-list">' + values.slice(0, 3).map((value) => '<li>' + esc(value) + '</li>').join('') + '</ul>';
    return '<div class="ws-resume-blocks">'
      + block('能力', skills.length ? chips(skills) : '<p class="ws-empty-copy">简历里没有解析到技能；可看完整详情。</p>')
      + block('竞赛', competitions.length ? lines(competitions) : '<p class="ws-empty-copy">没有竞赛 / 获奖记录。</p>')
      + block('项目', projects.length ? lines(projects) : '<p class="ws-empty-copy">没有解析到项目经历。</p>')
      + '</div>';
  }

  function interviewHint(detail) {
    const formal = detail?.formalInterview;
    if (!formal) return '';
    const status = { prepared: '已准备', in_progress: '进行中', completed: '已完成' }[formal.status] || '处理中';
    return '<p class="ws-inline-note">AI 初面：' + esc(status)
      + (formal.analysisStatus ? ' · 分析' + esc({ queued: '排队中', processing: '进行中', completed: '已完成', failed: '失败' }[formal.analysisStatus] || '处理中') : '')
      + '。<a href="ai-results.html?id=' + encodeURIComponent(detail.id) + '">查看 AI 面试结果 →</a></p>';
  }

  function bindCardActions(host, item, detail, total) {
    host.querySelectorAll('[data-card-action]').forEach((button) => {
      button.onclick = async () => {
        const action = button.dataset.cardAction;
        if (action === 'prev') { state.index = Math.max(0, state.index - 1); drawBoard(); return; }
        if (action === 'next') { state.index = Math.min(total - 1, state.index + 1); drawBoard(); return; }
        if (action === 'resume') {
          button.disabled = true;
          try { await core.downloadResume(item.id, item.fileName || (item.candidateName || 'resume')); }
          catch (error) { core.toast(error.message || '无法读取原简历', 'error'); }
          finally { button.disabled = false; }
          return;
        }
        if (action === 'invite' || action === 'skip') {
          button.disabled = true;
          try {
            await core.api('/api/hr/applications/' + encodeURIComponent(item.id) + '/review', {
              method: 'POST',
              body: JSON.stringify({ decision: action === 'invite' ? 'invite' : 'hold', notes: '' }),
            });
            core.toast(action === 'invite' ? '已发送 AI 面试邀请' : '已暂缓，稍后可在列表里再处理', 'ok');
            await loadList({ silent: true });
            if (action === 'invite') state.index = Math.min(state.index, Math.max(0, total - 1));
          } catch (error) { core.toast(error.message || '操作失败', 'error'); }
          finally { button.disabled = false; }
        }
      };
    });
  }

  // ---------- 列表 ----------
  function drawList(host, shown) {
    const sorted = [...shown].sort((a, b) => String(a.candidateName || '').localeCompare(String(b.candidateName || ''), 'zh-CN'));
    const row = (item) => {
      const expanded = state.expandedId === item.id;
      const report = core.reportOf(item) || {};
      return '<tr class="ws-row' + (expanded ? ' expanded' : '') + '" data-row="' + esc(item.id) + '">'
        + '<td><strong>' + esc(item.candidateName || '候选人') + '</strong><small>' + esc(item.jobTitle || '') + '</small></td>'
        + '<td>' + core.stageChip(item.stage) + '</td>'
        + '<td><span class="screen-state">' + esc(core.sourceLabel(item.source)) + '</span></td>'
        + '<td>' + esc(core.dateOnly(item.createdAt)) + '</td>'
        + '<td>' + esc(core.recommendationLabel(item.recommendation || report.screeningRecommendation)) + '</td>'
        + '<td>' + esc(core.scoreLabel(item)) + '</td>'
        + '<td>' + esc(core.reviewStatus(item.review || item.reviewStatus)) + '</td>'
        + '<td class="ws-row-actions"><button type="button" class="btn btn-ghost btn-sm" data-expand="' + esc(item.id) + '">' + (expanded ? '收起' : '展开') + '</button>'
        + '<a class="screen-detail-link" href="screening.html?id=' + encodeURIComponent(item.id) + '">详情 →</a></td></tr>'
        + (expanded ? '<tr class="ws-expand-row"><td colspan="8">' + expandHtml(item) + '</td></tr>' : '');
    };
    host.innerHTML = '<div class="screen-table-wrap"><table class="screen-table ws-table"><thead><tr>'
      + '<th>候选人 / 岗位</th><th>阶段</th><th>来源</th><th>录入时间</th><th>初筛建议</th><th>匹配指标</th><th>HR 审核</th><th></th>'
      + '</tr></thead><tbody>' + sorted.map(row).join('') + '</tbody></table></div>';
    host.querySelectorAll('[data-expand]').forEach((button) => {
      button.onclick = (event) => {
        event.stopPropagation();
        state.expandedId = state.expandedId === button.dataset.expand ? '' : button.dataset.expand;
        if (state.expandedId && !state.details.get(state.expandedId)) loadDetail(state.expandedId).then(() => drawBoard());
        else drawBoard();
      };
    });
    host.querySelectorAll('tr.ws-row').forEach((tr) => {
      tr.onclick = (event) => {
        if (event.target.closest('a,button')) return;
        state.expandedId = state.expandedId === tr.dataset.row ? '' : tr.dataset.row;
        if (state.expandedId && !state.details.get(state.expandedId)) loadDetail(state.expandedId).then(() => drawBoard());
        else drawBoard();
      };
    });
  }

  function expandHtml(item) {
    const detail = state.details.get(item.id);
    const report = core.reportOf(item) || {};
    const invited = ['ai_interview_invited', 'ai_interview_in_progress', 'ai_interview_completed', 'hr_interview_invited', 'closed'].includes(item.status);
    const imported = item.source === 'hr_import';
    return '<div class="ws-expand">'
      + (detail ? resumeBlocks(item, detail) : '<p class="muted">正在读取解析后的简历…</p>')
      + '<div class="ws-expand-summary"><h3>初筛建议</h3><p>' + esc(core.recommendationLabel(item.recommendation || report.screeningRecommendation)) + '</p>'
      + '<p class="ws-empty-copy">' + esc(report.candidateSummary || '暂无初筛摘要。') + '</p></div>'
      + '<div class="ws-actions">'
      + '<button type="button" class="btn btn-primary btn-sm" data-row-action="invite"' + (invited || imported ? ' disabled' : '') + '>' + (invited ? '已发送邀请' : '发送 AI 面试邀请') + '</button>'
      + '<button type="button" class="btn btn-ghost btn-sm" data-row-action="skip"' + (invited ? ' disabled' : '') + '>跳过（暂缓）</button>'
      + '<button type="button" class="btn btn-ghost btn-sm" data-row-action="resume">查看原简历</button>'
      + '<a class="btn btn-ghost btn-sm" href="screening.html?id=' + encodeURIComponent(item.id) + '">完整详情</a>'
      + '</div></div>';
  }

  async function loadDetail(id) {
    if (state.details.has(id)) return state.details.get(id);
    if (state.pending.has(id)) return null;
    state.pending.add(id);
    try {
      const detail = await core.api('/api/hr/applications/' + encodeURIComponent(id));
      state.details.set(id, detail);
      return detail;
    } catch (error) {
      core.toast(error.message || '无法读取详情', 'error');
      return null;
    } finally {
      state.pending.delete(id);
    }
  }

  // 列表展开里的按钮在 drawBoard 之后绑定
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-row-action]');
    if (!button) return;
    const row = button.closest('.ws-expand')?.closest('tr')?.previousElementSibling;
    const itemId = row?.dataset?.row;
    if (!itemId) return;
    const item = state.entries.find((entry) => entry.id === itemId);
    if (!item) return;
    const action = button.dataset.rowAction;
    if (action === 'resume') {
      button.disabled = true;
      try { await core.downloadResume(item.id, item.fileName || 'resume'); }
      catch (error) { core.toast(error.message || '无法读取原简历', 'error'); }
      finally { button.disabled = false; }
      return;
    }
    button.disabled = true;
    try {
      await core.api('/api/hr/applications/' + encodeURIComponent(item.id) + '/review', {
        method: 'POST',
        body: JSON.stringify({ decision: action === 'invite' ? 'invite' : 'hold', notes: '' }),
      });
      core.toast(action === 'invite' ? '已发送 AI 面试邀请' : '已暂缓', 'ok');
      state.expandedId = '';
      await loadList({ silent: true });
    } catch (error) {
      core.toast(error.message || '操作失败', 'error');
      button.disabled = false;
    }
  });

  // ---------- 详情 ----------
  async function renderDetail(id) {
    app.innerHTML = subnav('board')
      + '<a class="screen-back" href="screening.html#/board">← 返回筛选后的简历</a>'
      + '<p id="screen-detail-error" class="screen-error screen-hidden" role="alert"></p>'
      + '<div id="screen-detail"><p class="muted">正在读取候选人资料…</p></div>';
    try { drawDetail(await core.api('/api/hr/applications/' + encodeURIComponent(id))); }
    catch (error) { showError('screen-detail-error', error.message || '无法读取详情。'); }
  }

  function evidenceHtml(evidence, empty) {
    if (!Array.isArray(evidence) || !evidence.length) return '<p class="ws-empty-copy">' + esc(empty || '未进行外部核验，或没有可展示的外部证据。') + '</p>';
    return '<ul class="screen-evidence-list">' + evidence.map((entry) => {
      if (typeof entry === 'string') return '<li>' + esc(entry) + '</li>';
      const url = core.safeUrl(entry.url);
      return '<li><strong>' + esc(entry.source || entry.relatedClaim || entry.requirement || '证据') + '</strong>'
        + (url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">打开来源 ↗</a>' : '')
        + '<small>' + esc(entry.verificationStatus || '待核实')
        + (entry.checkedAt ? ' · 核验于 ' + esc(core.dateLabel(entry.checkedAt)) : '') + '</small>'
        + (entry.details || entry.excerpt || entry.sourceText ? '<p>' + esc(entry.details || entry.excerpt || entry.sourceText) + '</p>' : '')
        + '</li>';
    }).join('') + '</ul>';
  }

  function claimHtml(claims) {
    if (!Array.isArray(claims) || !claims.length) return '<p class="ws-empty-copy">暂无需要单独核验的声明。</p>';
    const labels = { unverified: '尚未核实', resume_supported: '简历内部有支撑', external_supported: '外部证据支持', conflict: '发现冲突' };
    return claims.map((claim) => '<article class="screen-claim"><strong>' + esc(claim.claim || '') + '</strong>'
      + '<span class="screen-state">' + esc(labels[claim.verificationStatus] || '待核实') + '</span>'
      + (claim.sourceText ? '<blockquote>' + esc(claim.sourceText) + '</blockquote>' : '')
      + (Array.isArray(claim.supportingEvidence) && claim.supportingEvidence.length ? evidenceHtml(claim.supportingEvidence) : '')
      + (claim.followUpQuestion ? '<p><b>建议追问：</b>' + esc(claim.followUpQuestion) + '</p>' : '') + '</article>').join('');
  }

  function substanceHtml(signals) {
    if (!Array.isArray(signals) || !signals.length) return '<p class="ws-empty-copy">模型未识别到可引用的具体信号；请结合原始简历核对关键经历。</p>';
    return signals.map((entry) => '<article class="screen-claim"><strong>' + esc(entry.signal || '待核实细节') + '</strong>'
      + '<blockquote>' + esc(entry.sourceText || '') + '</blockquote><p>' + esc(entry.reasoning || '') + '</p>'
      + '<p><b>核验问题：</b>' + esc(entry.followUpQuestion || '') + '</p></article>').join('');
  }

  function interviewAnalysisHtml(formal) {
    const report = formal.analysis;
    if (!report) {
      return '<div class="screen-pending"><p>' + (formal.status === 'completed' ? '面试已完成，DeepSeek 正在分析问答证据。' : '面试进行中；完成全部题目后生成 AI 分析。') + '</p>'
        + (formal.analysisStatus === 'failed' ? '<small>' + esc(formal.analysisError || '模型分析失败。') + '</small><button type="button" id="screen-retry-interview" class="btn btn-ghost btn-sm">重新分析面试</button>' : '') + '</div>';
    }
    const labels = { specific: '回答具体', partial: '部分具体', unclear: '证据不足' };
    return '<p class="screen-model-note">分析模型：' + esc(formal.analysisModel || 'DeepSeek') + '</p>'
      + '<p class="screen-panel-lead">' + esc(report.summary || '') + '</p><h3>逐题证据与推理</h3>'
      + (Array.isArray(report.answerEvidence) ? report.answerEvidence.map((entry) => '<article class="screen-claim"><strong>' + esc(labels[entry.assessment] || '待核实') + '</strong>'
        + '<blockquote>' + esc(entry.answerQuote || '') + '</blockquote><p>' + esc(entry.reasoning || '') + '</p>'
        + '<p><b>复试追问：</b>' + esc(entry.followUpQuestion || '') + '</p></article>').join('') : '')
      + '<h3>有依据的优势</h3>' + core.listStrings(report.strengths)
      + '<h3>证据缺口</h3>' + core.listStrings(report.gaps)
      + '<h3>建议复试追问</h3>' + core.listStrings(report.followUpQuestions)
      + '<h3>分析限制</h3>' + core.listStrings(report.limitations);
  }

  function structuredResumeHtml(resume) {
    const sections = [['能力', [...(resume.skills || []), ...(resume.certifications || [])]],
      ['竞赛', [...(resume.competitions || []).map((entry) => entry?.text || entry), ...(resume.achievements || [])]],
      ['项目', (resume.projects || []).map((entry) => entry?.text || entry)],
      ['工作经历', (resume.workExperience || []).map((entry) => entry?.text || entry)],
      ['教育经历', (resume.education || []).map((entry) => entry?.text || entry)]];
    return sections.map(([label, items]) => {
      if (!Array.isArray(items) || !items.length) return '';
      return '<h3>' + label + '</h3><div class="screen-structured-list">'
        + items.map((entry) => '<div>' + esc(typeof entry === 'string' ? entry : Object.values(entry || {}).filter((value) => typeof value === 'string' && value).join(' · ')) + '</div>').join('') + '</div>';
    }).join('');
  }

  function drawDetail(item) {
    const sourceReport = core.reportOf(item);
    const report = sourceReport ? { ...sourceReport, externalEvidence: item.evidence || sourceReport.externalEvidence } : null;
    const resume = item.parsedResume || {};
    const match = report?.jobMatch || {};
    const recommendation = report?.screeningRecommendation || item.recommendation;
    const review = item.review || {};
    const interviewPath = typeof item.invitation?.interviewPath === 'string' && item.invitation.interviewPath.startsWith('/classic/?room=') ? item.invitation.interviewPath : '';
    const title = esc(item.jobTitle || '目标岗位');
    const human = item.humanInterview;
    byId('screen-detail').innerHTML = '<div class="screen-detail-heading"><div><span class="eyebrow">候选人 · ' + esc(core.statusLabel(item.status)) + '</span>'
      + '<h1>' + esc(item.candidateName || '候选人') + '</h1>'
      + '<p>' + title + ' · ' + esc(core.sourceLabel(item.source)) + ' 于 ' + esc(core.dateLabel(item.createdAt)) + ' · ' + core.stageChip(item.stage) + '</p></div>'
      + '<div class="screen-heading-actions"><button id="screen-download" type="button" class="btn btn-ghost">查看原始简历</button>'
      + (interviewPath ? '<a class="btn btn-primary" href="' + esc(interviewPath) + '">人工面试房间（AI 辅助）</a>' : '')
      + '<a class="btn btn-ghost" href="ai-results.html?id=' + encodeURIComponent(item.id) + '">AI 面试结果</a>'
      + '<a class="btn btn-ghost" href="human-results.html?id=' + encodeURIComponent(item.id) + '">真人面试结果</a></div></div>'
      + '<div class="screen-detail-grid"><div class="screen-detail-column">'
      + '<section class="card screen-panel"><div class="screen-panel-heading"><h2>候选人资料</h2><span>' + esc(core.processLabel(item.resumeStatus)) + '</span></div>'
      + '<div class="screen-resume-meta"><span>来源</span><strong>' + esc(core.sourceLabel(item.source)) + '</strong>'
      + '<span>姓名</span><strong>' + esc(resume.name || item.candidateName || '未提取') + '</strong>'
      + '<span>联系方式</span><strong>' + esc(item.candidateEmail || resume.contact?.email || '未提供') + '</strong>'
      + (item.uploadedBy ? '<span>企业录入人</span><strong>' + esc(item.uploadedBy) + '</strong>' : '') + '</div>'
      + '<p class="screen-panel-lead">以下分析引用简历中的具体内容；原始文件可在页面顶部下载核对。</p>'
      + '<details><summary>查看解析后的简历结构</summary>' + (structuredResumeHtml(resume) || '<p class="ws-empty-copy">尚无结构化简历内容。</p>') + '</details></section>'
      + '<section class="card screen-panel"><h2>HR 人工审核</h2><p class="screen-panel-lead">审核意见用于记录企业内部的核验要点与决策依据；AI 结论只供参考，最终由 HR 判断。</p>'
      + (item.source === 'hr_import' ? '<p class="screen-import-note">企业录入简历尚未关联候选人账号，可先审核；线上初面邀请暂不可用。</p>' : '')
      + '<p class="screen-review-current">当前状态：' + esc(core.reviewStatus(review)) + (review.notes ? ' · ' + esc(review.notes) : '') + '</p>'
      + '<label for="screen-review-notes">内部审核意见</label><textarea id="screen-review-notes" class="input" rows="4" maxlength="2000" placeholder="记录待核实的经历、追问结果及处理依据">' + esc(review.notes || '') + '</textarea>'
      + '<p id="screen-review-error" class="screen-error screen-hidden" role="alert"></p>'
      + '<div class="screen-review-actions">' + (item.source === 'hr_import' ? '' : '<button type="button" data-decision="invite" class="btn btn-primary">邀请 AI 辅助初面</button>')
      + '<button type="button" data-decision="verify" class="btn btn-ghost">进一步核验</button><button type="button" data-decision="hold" class="btn btn-ghost">暂缓申请</button></div></section>'
      + '</div><div class="screen-detail-column">'
      + '<section class="card screen-panel"><div class="screen-panel-heading"><h2>AI 初筛报告</h2><span>' + esc(core.processLabel(item.screeningStatus)) + '</span></div>'
      + (report
        ? '<p class="screen-model-note">分析模型：' + esc(item.screeningMeta?.model || 'DeepSeek') + '</p>'
          + '<p class="screen-panel-lead">' + esc(report.candidateSummary || '报告未提供候选人概览。') + '</p>'
          + '<div class="screen-decision"><span>岗位匹配指标</span><strong>' + esc(core.scoreLabel(item)) + '</strong><small>辅助指标；缺少证据时不评分</small></div>'
          + '<h3>经历内容与待核实点</h3>' + substanceHtml(report.substanceSignals)
          + '<h3>匹配的要求</h3>' + core.listStrings(match.matchedRequirements, '暂无有证据支持的匹配项。')
          + '<h3>岗位能力缺口</h3>' + core.listStrings(match.missingRequirements, '未发现明确缺口，或岗位资料不足。')
          + '<h3>匹配依据</h3>' + evidenceHtml(match.evidence)
          + '<h3>有证据的优势</h3>' + core.listStrings(report.strengths, '暂无可说明的优势。')
          + '<h3>需要核实的声明</h3>' + claimHtml(report.resumeClaims)
          + '<h3>其他核验重点</h3>' + core.listStrings(report.areasToVerify, '暂无补充事项。')
          + '<h3>面试问题</h3>' + core.listStrings(report.interviewQuestions, '初筛完成后生成。')
          + '<h3>初筛建议</h3><div class="screen-recommendation"><strong>' + esc(core.recommendationLabel(recommendation)) + '</strong>' + core.listStrings(report.recommendationReasons, '请结合完整报告人工判断。') + '</div>'
          + '<h3>外部证据</h3>' + evidenceHtml(report.externalEvidence)
          + '<h3>分析限制</h3>' + core.listStrings(report.limitations, '请结合原始简历人工核验。')
        : '<div class="screen-pending"><p>' + (item.screeningStatus === 'failed' ? '初筛处理失败，可重新运行。' : '初筛处理中，完成后自动显示分析。') + '</p>'
          + (item.screeningError ? '<small>' + esc(item.screeningError) + '</small>' : '')
          + (item.screeningStatus === 'failed' ? '<button type="button" id="screen-retry-screening" class="btn btn-ghost btn-sm">重新运行初筛</button>' : '') + '</div>')
      + '</section></div></div>';

    if (Array.isArray(item.corrections) && item.corrections.length) {
      const section = document.createElement('section');
      section.className = 'screen-corrections';
      section.innerHTML = '<h3>候选人更正申请</h3><ul>' + item.corrections.map((correction) => '<li><small>' + esc(core.dateLabel(correction.createdAt)) + '</small><p>' + esc(correction.message) + '</p></li>').join('') + '</ul>';
      byId('screen-detail').querySelector('.screen-review-current').after(section);
    }
    if (item.formalInterview && typeof item.formalInterview === 'object') {
      const formal = item.formalInterview;
      const status = { prepared: '已准备', in_progress: '进行中', completed: '已完成' }[formal.status] || '处理中';
      const answers = Array.isArray(formal.answers) ? formal.answers : [];
      const section = document.createElement('section');
      section.className = 'card screen-panel screen-formal-interview';
      section.innerHTML = '<div class="screen-panel-heading"><h2>岗位 AI 初面记录</h2><span class="screen-state">' + esc(status) + '</span></div>'
        + '<p class="screen-panel-lead">基于岗位、简历和候选人实际回答生成分析；原始问答保留供 HR 复核。</p>'
        + '<p class="screen-formal-times">开始：' + esc(core.dateLabel(formal.startedAt)) + (formal.completedAt ? ' · 完成：' + esc(core.dateLabel(formal.completedAt)) : '') + '</p>'
        + '<h3>AI 问答分析</h3>' + interviewAnalysisHtml(formal)
        + '<details><summary>查看原始问答（' + answers.length + ' 题）</summary>'
        + (answers.length ? '<ol class="screen-formal-answers">' + answers.map((entry, index) => '<li><strong>问题 ' + (index + 1) + '：' + esc(entry.prompt || '未提供题目') + '</strong><p>' + esc(entry.answer || '未记录回答') + '</p><small>' + esc(core.dateLabel(entry.createdAt)) + '</small></li>').join('') + '</ol>' : '<p class="ws-empty-copy">暂无可显示的问答记录。</p>')
        + '</details>';
      byId('screen-detail').querySelectorAll('.screen-detail-column')[1].append(section);
    }
    if (human) {
      const section = document.createElement('section');
      section.className = 'card screen-panel';
      section.innerHTML = '<div class="screen-panel-heading"><h2>真人面试</h2><span>' + core.stateChip(human.state) + '</span></div>'
        + '<div class="screen-resume-meta"><span>时间</span><strong>' + esc(core.dateLabel(human.scheduledAt)) + '</strong>'
        + '<span>面试官</span><strong>' + esc(human.interviewerName || '—') + '</strong>'
        + '<span>形式</span><strong>' + esc(core.modeLabel(human.mode)) + '</strong>'
        + (human.location ? '<span>地点</span><strong>' + esc(human.location) + '</strong>' : '')
        + (human.roomCode ? '<span>房间号</span><strong>' + esc(human.roomCode) + '</strong>' : '')
        + '<span>结论</span><strong>' + esc(core.resultChip(human.result)) + '</strong>'
        + '<span>结果已发送</span><strong>' + (human.resultSent ? '是' : '否') + '</strong></div>'
        + (human.notes ? '<p class="screen-panel-lead">内部备注：' + esc(human.notes) + '</p>' : '')
        + '<a class="btn btn-ghost btn-sm" href="human-results.html?id=' + encodeURIComponent(item.id) + '">去真人面试结果页处理 →</a>';
      byId('screen-detail').querySelectorAll('.screen-detail-column')[1].append(section);
    }
    if (match.scoreBasis) {
      const basis = document.createElement('p');
      basis.className = 'screen-score-basis';
      basis.textContent = '指标依据：' + (typeof match.scoreBasis === 'string' ? match.scoreBasis : JSON.stringify(match.scoreBasis));
      byId('screen-detail').querySelector('.screen-decision')?.after(basis);
    }
    byId('screen-download').onclick = async () => {
      const button = byId('screen-download');
      button.disabled = true; button.textContent = '正在读取…';
      try { await core.downloadResume(item.id, item.fileName || 'resume'); }
      catch (error) { showError('screen-detail-error', error.message || '无法读取原始简历。'); }
      finally { button.disabled = false; button.textContent = '查看原始简历'; }
    };
    byId('screen-detail').querySelectorAll('[data-decision]').forEach((button) => {
      if (button.dataset.decision === 'invite' && ['ai_interview_invited', 'ai_interview_in_progress', 'ai_interview_completed', 'hr_interview_invited', 'closed'].includes(item.status)) {
        button.disabled = true;
        button.textContent = 'AI 辅助初面已安排';
      }
      button.onclick = async () => {
        byId('screen-detail').querySelectorAll('[data-decision]').forEach((node) => { node.disabled = true; });
        showError('screen-review-error', '');
        try {
          const updated = await core.api('/api/hr/applications/' + encodeURIComponent(item.id) + '/review', {
            method: 'POST',
            body: JSON.stringify({ decision: button.dataset.decision, notes: byId('screen-review-notes').value.trim() }),
          });
          drawDetail(updated);
          core.toast('审核意见已保存', 'ok');
        } catch (error) {
          showError('screen-review-error', error.message || '无法保存审核意见。');
          byId('screen-detail').querySelectorAll('[data-decision]').forEach((node) => { node.disabled = false; });
        }
      };
    });
    [['screen-retry-screening', '/screening/retry'], ['screen-retry-interview', '/interview-analysis/retry']].forEach(([buttonId, path]) => {
      const button = byId(buttonId);
      if (!button) return;
      button.onclick = async () => {
        button.disabled = true;
        showError('screen-detail-error', '');
        try {
          await core.api('/api/hr/applications/' + encodeURIComponent(item.id) + path, { method: 'POST' });
          drawDetail(await core.api('/api/hr/applications/' + encodeURIComponent(item.id)));
        } catch (error) {
          showError('screen-detail-error', error.message || '重试失败。');
          button.disabled = false;
        }
      };
    });
    clearTimeout(state.detailPoll);
    const formal = item.formalInterview;
    if (['queued', 'processing', 'screening'].includes(item.screeningStatus)
      || (formal && (formal.status === 'in_progress'
        || (formal.status === 'completed' && ['pending', 'queued', 'processing'].includes(formal.analysisStatus))))) {
      state.detailPoll = setTimeout(async () => {
        if (!byId('screen-detail')) return;
        try { drawDetail(await core.api('/api/hr/applications/' + encodeURIComponent(item.id))); }
        catch (error) { showError('screen-detail-error', error.message || '更新状态失败。'); }
      }, 12000);
    }
  }
})();
