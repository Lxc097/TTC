/* 企业端「邀请记录」：AI 初面与真人面试的邀请回溯、过期状态与重发。
 *
 * 数据来自 PR1 的接口：
 * - GET /api/hr/invitations（状态由后端按 expires_at 计算）
 * - POST /api/hr/applications/{id}/invitation/resend（AI）
 * - POST /api/hr/applications/{id}/human-interview/resend（真人）
 */
(function () {
  'use strict';
  const core = window.TTCWorkspace;
  const app = document.getElementById('screen-app');
  const byId = (id) => document.getElementById(id);
  const esc = core.esc;
  const state = { items: [], counts: {}, filter: 'all', kind: '' };

  (async () => {
    const current = await core.initPage('invites');
    if (!current) return;
    render();
  })();

  async function render() {
    app.innerHTML = '<div class="screen-heading"><div><span class="eyebrow">企业端 · 招聘工作台</span><h1>邀请记录</h1>'
      + '<p>AI 初面与真人面试的邀请都在这里回溯。过期状态在读取时计算，重发只顺延有效期并计数，不会产生第二条记录。</p></div>'
      + '<div class="screen-heading-actions"><a class="btn btn-ghost" href="screening.html#/board">返回查看简历</a></div></div>'
      + '<div id="invites-error" class="screen-error screen-hidden" role="alert"></div>'
      + '<section class="ws-stats ws-stats-5" id="invite-stats"></section>'
      + '<div class="ws-toolbar"><div class="ws-chips" id="invite-filters" role="group" aria-label="按状态筛选">'
      + chip('all', '全部') + chip('pending', '待响应') + chip('accepted', '已接受')
      + chip('expired', '已过期') + chip('completed', '已完成')
      + '</div><label class="ws-field ws-field-inline"><span>类型</span><select id="invite-kind" class="input">'
      + '<option value="">全部类型</option><option value="ai">AI 初面</option><option value="human">真人面试</option>'
      + '</select></label></div>'
      + '<div id="invite-list"><p class="muted">正在读取邀请记录…</p></div>';
    byId('invite-filters').querySelectorAll('[data-filter]').forEach((button) => {
      button.onclick = () => { state.filter = button.dataset.filter; render(); };
    });
    byId('invite-kind').onchange = () => { state.kind = byId('invite-kind').value; render(); };
    byId('invite-kind').value = state.kind;
    try {
      const result = await core.api('/api/hr/invitations');
      state.items = Array.isArray(result.items) ? result.items : [];
      state.counts = result.counts || {};
      drawStats();
      drawList();
    } catch (error) {
      byId('invite-list').innerHTML = '<p class="screen-error">' + esc(error.message || '无法读取邀请记录。') + '</p>';
    }
  }

  function chip(value, label) {
    return '<button type="button" data-filter="' + value + '" class="ws-chip' + (state.filter === value ? ' on' : '') + '">' + label + '</button>';
  }

  function drawStats() {
    const counts = state.counts || {};
    const tiles = [['全部邀请', counts.total || 0], ['待响应', counts.pending || 0],
      ['已接受', counts.accepted || 0], ['已过期', counts.expired || 0], ['已完成', counts.completed || 0]];
    byId('invite-stats').innerHTML = tiles.map(([label, value]) =>
      '<div class="card ws-stat"><span>' + label + '</span><strong>' + value + '</strong></div>').join('');
  }

  function shownItems() {
    return state.items.filter((item) => (state.filter === 'all' || item.state === state.filter)
      && (!state.kind || item.kind === state.kind));
  }

  function drawList() {
    const host = byId('invite-list');
    if (!host) return;
    const items = shownItems();
    if (!items.length) {
      host.innerHTML = '<div class="ws-empty"><h2>没有符合条件的邀请</h2><p>发送 AI 面试邀请或安排真人面试后，记录会出现在这里。</p></div>';
      return;
    }
    host.innerHTML = '<div class="screen-table-wrap"><table class="screen-table ws-table"><thead><tr>'
      + '<th>候选人 / 岗位</th><th>类型</th><th>发送时间</th><th>截止 / 面试时间</th><th>状态</th><th>发送次数</th><th></th>'
      + '</tr></thead><tbody>' + items.map((item) => '<tr class="ws-row">'
        + '<td><strong>' + esc(item.candidateName || '候选人') + '</strong><small>' + esc(item.jobTitle || '') + '</small></td>'
        + '<td>' + (item.kind === 'ai' ? '<span class="chip blue">AI 初面</span>' : '<span class="chip peach">真人面试</span>') + '</td>'
        + '<td>' + esc(core.dateLabel(item.sentAt)) + '</td>'
        + '<td>' + esc(item.kind === 'human' ? core.dateLabel(item.scheduledAt) : core.deadlineLabel(item.expiresAt))
        + (item.kind === 'human' && item.interviewerName ? '<small>' + esc(item.interviewerName) + '</small>' : '') + '</td>'
        + '<td>' + core.stateChip(item.state) + '</td>'
        + '<td>' + (item.sendCount || 1) + '</td>'
        + '<td class="ws-row-actions">'
        + (item.resendable ? '<button type="button" class="btn btn-ghost btn-sm" data-resend="' + esc(item.id) + '">重新发送</button>' : '')
        + '<a class="screen-detail-link" href="screening.html?id=' + encodeURIComponent(item.applicationId) + '">查看申请 →</a>'
        + '</td></tr>').join('') + '</tbody></table></div>';
    host.querySelectorAll('[data-resend]').forEach((button) => {
      button.onclick = () => {
        const item = state.items.find((entry) => entry.id === button.dataset.resend);
        if (item) openResend(item);
      };
    });
  }

  function openResend(item) {
    const defaultDays = item.kind === 'ai' ? 7 : 3;
    const label = item.kind === 'ai' ? 'AI 初面邀请' : '真人面试邀请';
    const body = '<p class="ws-hint">重发不会新建邀请，只更新发送时间、顺延有效期并把发送次数 +1。当前状态：'
      + esc(core.INVITATION_STATE_LABELS[item.state] || item.state) + '。</p>'
      + '<label class="ws-field"><span>顺延天数</span><input id="resend-days" class="input" type="number" min="1" max="60" value="' + defaultDays + '"></label>'
      + '<p id="resend-error" class="screen-error screen-hidden" role="alert"></p>'
      + '<div class="ws-actions"><button type="button" id="resend-save" class="btn btn-primary">确认重发</button>'
      + '<span class="ws-hint">候选人会在申请进度里看到新的截止时间。</span></div>';
    core.openModal('重发' + label, body, {
      onMount: () => {
        byId('resend-save').onclick = async () => {
          const button = byId('resend-save');
          button.disabled = true; showError('resend-error', '');
          try {
            const days = Math.max(1, Math.min(60, Number(byId('resend-days').value) || defaultDays));
            const path = item.kind === 'ai'
              ? '/api/hr/applications/' + encodeURIComponent(item.applicationId) + '/invitation/resend'
              : '/api/hr/applications/' + encodeURIComponent(item.applicationId) + '/human-interview/resend';
            await core.api(path, { method: 'POST', body: JSON.stringify({ days }) });
            core.closeModal();
            core.toast('邀请已重发', 'ok');
            await render();
          } catch (error) { showError('resend-error', error.message || '重发失败。'); button.disabled = false; }
        };
      },
    });
  }

  function showError(id, message) {
    const node = byId(id);
    if (!node) return;
    node.textContent = message || '';
    node.classList.toggle('screen-hidden', !message);
  }
})();
