/* TTC 企业端招聘工作台公共层。
 *
 * 这里只放「每个页面都要用」的东西：鉴权、同源接口、格式化、导航条、
 * 轻提示与弹窗。页面脚本只负责各自视图，不再复制这些函数。
 *
 * 约定：
 * - 所有企业端页面都挂一个 <div id="workspace-nav"></div>，由 mountNav 注入导航。
 * - 只有 screening.html 承担登录；其他页面发现未登录直接回登录页。
 */
(function () {
  'use strict';

  const AUTH_KEY = 'ttc.recruitment.hr.auth';
  const TABS = [
    { id: 'resumes', label: '查看简历', href: 'screening.html' },
    { id: 'ai', label: 'AI 面试结果', href: 'ai-results.html' },
    { id: 'human', label: '真人面试结果', href: 'human-results.html' },
    { id: 'invites', label: '邀请记录', href: 'invites.html' },
  ];
  const STAGE_LABELS = {
    applied: '投递与初筛', ai_interview: 'AI 初面',
    human_interview: '真人面试', ended: '流程结束',
  };
  const INVITATION_STATE_LABELS = {
    pending: '待响应', accepted: '已接受', expired: '已过期',
    completed: '已完成', cancelled: '已取消',
  };
  const RESULT_LABELS = { pass: '通过', hold: '待定', reject: '未通过' };
  const MODE_LABELS = { video: '线上视频', onsite: '线下面试', phone: '电话面试' };

  const byId = (id) => document.getElementById(id);
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));

  let demoMode = false;

  // ---------- 鉴权 ----------
  function auth() {
    try {
      const value = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null');
      return value && typeof value.token === 'string' && value.user?.role === 'hr' ? value : null;
    } catch (_) { return null; }
  }
  function saveAuth(value) { localStorage.setItem(AUTH_KEY, JSON.stringify(value)); }
  function clearAuth() { localStorage.removeItem(AUTH_KEY); }

  async function bootstrap() {
    try {
      const result = await api('/api/auth/demo-mode', {}, false);
      demoMode = Boolean(result.enabled);
    } catch (_) { demoMode = false; }
    if (demoMode) {
      try { saveAuth(await api('/api/auth/demo/hr', { method: 'POST' }, false)); }
      catch (_) { /* fall back to the normal login form */ }
    }
    return { demoMode, current: auth() };
  }

  // ---------- 接口 ----------
  async function readError(response) {
    try {
      const data = await response.json();
      const message = typeof data.detail === 'string' ? data.detail
        : typeof data.error === 'string' ? data.error : '';
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
    if (options?.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
    let response;
    try { response = await fetch(path, { ...options, headers, cache: 'no-store' }); }
    catch (_) { throw new Error('无法连接招聘服务，请检查网络。'); }
    if (!response.ok) throw new Error(await readError(response));
    return response.json();
  }

  // ---------- 格式化 ----------
  function toDate(value) {
    if (value == null || value === '') return null;
    const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
    return isNaN(date.getTime()) ? null : date;
  }
  function dateLabel(value) {
    const date = toDate(value);
    return date ? date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
  }
  function dateOnly(value) {
    const date = toDate(value);
    return date ? date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }) : '—';
  }
  function timeOnly(value) {
    const date = toDate(value);
    return date ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '—';
  }
  function dateISO(value) {
    const date = toDate(value);
    if (!date) return '';
    const part = (number) => String(number).padStart(2, '0');
    return date.getFullYear() + '-' + part(date.getMonth() + 1) + '-' + part(date.getDate());
  }
  function toDatetimeLocal(value) {
    const date = toDate(value);
    if (!date) return '';
    const part = (number) => String(number).padStart(2, '0');
    return date.getFullYear() + '-' + part(date.getMonth() + 1) + '-' + part(date.getDate())
      + 'T' + part(date.getHours()) + ':' + part(date.getMinutes());
  }
  function fromDatetimeLocal(value) {
    const date = new Date(value);
    return isNaN(date.getTime()) ? null : Math.round(date.getTime() / 1000);
  }
  function deadlineLabel(epoch) {
    const date = toDate(epoch);
    if (!date) return '—';
    const days = Math.ceil((date.getTime() - Date.now()) / 86400000);
    const suffix = days > 0 ? days + ' 天后截止' : '已过期';
    return dateLabel(epoch) + '（' + suffix + '）';
  }
  function statusLabel(value) {
    return ({
      submitted: '已提交', parsing: '解析中', screening: '初筛中', hr_review: '待 HR 审核',
      ai_interview_invited: '已邀 AI 初面', ai_interview_in_progress: 'AI 初面进行中',
      ai_interview_completed: 'AI 初面已完成', hr_interview_invited: '已安排真人面试',
      closed: '已结束', failed: '处理异常',
    })[value] || '待处理';
  }
  function stageLabel(stage) { return STAGE_LABELS[stage] || STAGE_LABELS.applied; }
  function stageChip(stage) {
    const tone = { applied: 'gray', ai_interview: 'blue', human_interview: 'peach', ended: 'green' }[stage] || 'gray';
    return '<span class="chip ' + tone + '">' + esc(stageLabel(stage)) + '</span>';
  }
  function stateChip(state) {
    const tone = { pending: 'amber', accepted: 'blue', expired: 'red', completed: 'green', cancelled: 'gray' }[state] || 'gray';
    return '<span class="chip ' + tone + '">' + esc(INVITATION_STATE_LABELS[state] || state || '待处理') + '</span>';
  }
  function resultChip(result) {
    const tone = { pass: 'green', hold: 'amber', reject: 'red' }[result] || 'gray';
    return '<span class="chip ' + tone + '">' + esc(RESULT_LABELS[result] || '未出结论') + '</span>';
  }
  function modeLabel(mode) { return MODE_LABELS[mode] || mode || '—'; }
  function processLabel(value) {
    return ({ queued: '排队中', parsing: '解析中', screening: '初筛中', completed: '已完成',
      failed: '处理失败', skipped: '已跳过' })[value] || value || '待处理';
  }
  function recommendationLabel(value) {
    return ({
      invite: '建议邀请 AI 初面', invite_interview: '建议邀请 AI 初面',
      invite_ai_interview: '建议邀请 AI 初面', manual_review: '建议 HR 审核',
      insufficient_evidence: '匹配证据不足',
    })[value] || '待初筛';
  }
  function sourceLabel(value) { return value === 'hr_import' ? '企业录入' : '个人投递'; }
  function reviewStatus(value) {
    const decision = value?.decision || value?.status || value;
    return ({ invite: '已邀请', verify: '待进一步核验', hold: '暂缓', pending: '待审核' })[decision] || '待审核';
  }
  function scoreOf(item) {
    const value = item.matchScore ?? item.score ?? item.jobMatchScore
      ?? item.screening?.jobMatch?.score ?? item.screening?.report?.jobMatch?.score;
    return typeof value === 'number' && value >= 0 && value <= 100 ? Math.round(value) : null;
  }
  function scoreLabel(item) {
    const value = scoreOf(item);
    return value == null ? '证据不足' : value + '/100';
  }
  function reportOf(item) { return item.screening?.report || item.screening || null; }
  function listStrings(values, empty) {
    if (!Array.isArray(values) || !values.length) {
      return '<p class="ws-empty-copy">' + esc(empty || '尚无资料') + '</p>';
    }
    return '<ul class="ws-list">' + values.map((item) => '<li>'
      + esc(typeof item === 'string' ? item : item?.text || item?.requirement || JSON.stringify(item))
      + '</li>').join('') + '</ul>';
  }
  function safeUrl(value) {
    try {
      const url = new URL(value);
      return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
    } catch (_) { return ''; }
  }
  function query(name) { return new URLSearchParams(location.search).get(name); }

  // ---------- 导航 ----------
  function mountNav(activeId) {
    const host = byId('workspace-nav');
    if (!host) return;
    const current = auth();
    const links = TABS.map((tab) => '<a href="' + tab.href + '"'
      + (tab.id === activeId ? ' class="active" aria-current="page"' : '')
      + '>' + tab.label + '</a>').join('');
    host.innerHTML = '<header class="nav"><div class="wrap nav-in">'
      + '<a class="brand" href="screening.html"><span class="screen-brand-badge">T</span><span>TTC</span></a>'
      + '<nav class="nav-links" aria-label="招聘工作台">' + links + '</nav>'
      + '<div class="nav-right" id="workspace-account"></div>'
      + '</div></header>';
    const account = byId('workspace-account');
    if (!account) return;
    if (demoMode) {
      account.innerHTML = '<a class="btn btn-ghost btn-sm" href="./#/interviewer">面试间</a>'
        + '<span class="screen-account-name">本机演示 · 企业端</span>';
    } else if (current) {
      account.innerHTML = '<a class="btn btn-ghost btn-sm" href="./#/interviewer">面试间</a>'
        + '<span class="screen-account-name">' + esc(current.user.name || '招聘人员') + '</span>'
        + '<button class="btn btn-ghost btn-sm" id="workspace-logout" type="button">退出</button>';
      byId('workspace-logout').onclick = () => { clearAuth(); location.href = 'screening.html'; };
    } else {
      account.innerHTML = '<span class="screen-account-name">企业账户</span>';
    }
  }

  // ---------- 轻提示 / 弹窗 ----------
  function toast(message, kind) {
    let host = byId('workspace-toast');
    if (!host) {
      host = document.createElement('div');
      host.id = 'workspace-toast';
      host.className = 'ws-toast';
      document.body.appendChild(host);
    }
    host.textContent = message;
    host.className = 'ws-toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { host.className = 'ws-toast'; }, 2800);
  }
  function openModal(title, bodyHtml, options) {
    closeModal();
    const overlay = document.createElement('div');
    overlay.className = 'ws-modal';
    overlay.id = 'workspace-modal';
    overlay.innerHTML = '<div class="ws-modal-box" role="dialog" aria-modal="true" aria-label="' + esc(title) + '">'
      + '<header class="ws-modal-head"><h2>' + esc(title) + '</h2>'
      + '<button class="ws-modal-close" type="button" aria-label="关闭">×</button></header>'
      + '<div class="ws-modal-body">' + bodyHtml + '</div></div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closeModal();
    });
    overlay.querySelector('.ws-modal-close').onclick = closeModal;
    document.addEventListener('keydown', onModalKey);
    if (options?.onMount) options.onMount(overlay);
    return overlay;
  }
  function onModalKey(event) { if (event.key === 'Escape') closeModal(); }
  function closeModal() {
    byId('workspace-modal')?.remove();
    document.removeEventListener('keydown', onModalKey);
  }

  // ---------- 下载原简历 ----------
  async function downloadResume(applicationId, fileName) {
    const response = await fetch('/api/hr/applications/' + encodeURIComponent(applicationId) + '/resume',
      { headers: { Authorization: 'Bearer ' + (auth()?.token || '') }, cache: 'no-store' });
    if (!response.ok) throw new Error(await readError(response));
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName || 'resume';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function initPage(activeId) {
    return bootstrap().then((session) => {
      if (!session.current) {
        core.mountNav(activeId);
        if (activeId !== 'resumes') { location.replace('screening.html'); return null; }
      }
      core.mountNav(activeId);
      return session.current;
    });
  }

  const core = {
    byId, esc, query,
    auth, saveAuth, clearAuth, bootstrap, initPage,
    api, dateLabel, dateOnly, timeOnly, dateISO, toDatetimeLocal, fromDatetimeLocal,
    deadlineLabel, statusLabel, stageLabel, stageChip, stateChip, resultChip, modeLabel,
    processLabel, recommendationLabel, sourceLabel, reviewStatus, scoreOf, scoreLabel,
    reportOf, listStrings, safeUrl, mountNav, toast, openModal, closeModal, downloadResume,
    RESULT_LABELS, INVITATION_STATE_LABELS, MODE_LABELS,
  };
  window.TTCWorkspace = core;
})();
