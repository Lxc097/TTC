/* 企业端「真人面试结果」：安排 / 改期、面试官结论、双人面试间佐证与结果发送。
 *
 * 数据来自 PR1 的接口：
 * - 列表与详情：GET /api/hr/applications（含 humanInterview）
 * - 改期：PATCH /api/hr/applications/{id}/human-interview
 * - 结论：PATCH /api/hr/applications/{id}/human-interview { result, notes, resultSent }
 * - 佐证：GET /api/hr/applications/{id}/interview-room
 */
(function () {
  'use strict';
  const core = window.TTCWorkspace;
  const app = document.getElementById('screen-app');
  const byId = (id) => document.getElementById(id);
  const esc = core.esc;
  const state = { items: [], filter: 'all', opened: '' };

  (async () => {
    const current = await core.initPage('human');
    if (!current) return;
    await renderList();
    const id = core.query('id');
    if (id) {
      const item = state.items.find((entry) => entry.id === id);
      if (item) openDetail(item);
    }
  })();

  async function renderList() {
    app.innerHTML = '<div class="screen-heading"><div><span class="eyebrow">企业端 · 招聘工作台</span><h1>真人面试结果</h1>'
      + '<p>安排与改期、记录面试官结论，并回看双人面试间的双确认佐证。结论是否发送给候选人由 HR 决定。</p></div>'
      + '<div class="screen-heading-actions"><a class="btn btn-ghost" href="ai-results.html">AI 面试结果</a>'
      + '<a class="btn btn-ghost" href="screening.html#/board">返回查看简历</a></div></div>'
      + '<div id="human-error" class="screen-error screen-hidden" role="alert"></div>'
      + '<section class="ws-stats" id="human-stats"></section>'
      + '<div class="ws-toolbar"><div class="ws-chips" id="human-filters" role="group" aria-label="按状态筛选">'
      + chipButton('all', '全部') + chipButton('pending', '待响应') + chipButton('accepted', '已接受')
      + chipButton('expired', '已过期') + chipButton('completed', '已完成') + '</div></div>'
      + '<div id="human-list"><p class="muted">正在读取真人面试记录…</p></div>';
    byId('human-filters').querySelectorAll('[data-filter]').forEach((button) => {
      button.onclick = () => { state.filter = button.dataset.filter; renderList(); };
    });
    try {
      const result = await core.api('/api/hr/applications');
      state.items = (result.items || []).filter((item) => item.humanInterview);
      drawStats();
      drawList();
    } catch (error) {
      byId('human-list').innerHTML = '<p class="screen-error">' + esc(error.message || '无法读取申请。') + '</p>';
    }
  }

  function chipButton(value, label) {
    return '<button type="button" data-filter="' + value + '" class="ws-chip' + (state.filter === value ? ' on' : '') + '">' + label + '</button>';
  }

  function drawStats() {
    const items = state.items;
    const count = (fn) => items.filter(fn).length;
    byId('human-stats').innerHTML = [
      ['已安排', items.length],
      ['待响应', count((item) => item.humanInterview.state === 'pending')],
      ['已出结论', count((item) => item.humanInterview.state === 'completed')],
      ['结果已发送', count((item) => item.humanInterview.resultSent)],
    ].map(([label, value]) => '<div class="card ws-stat"><span>' + label + '</span><strong>' + value + '</strong></div>').join('');
  }

  function drawList() {
    const host = byId('human-list');
    if (!host) return;
    const shown = state.items.filter((item) => state.filter === 'all' || item.humanInterview.state === state.filter);
    if (!shown.length) {
      host.innerHTML = '<div class="ws-empty"><h2>还没有真人面试安排</h2><p>在「AI 面试结果」页点「进入真人面试」，或在候选人详情页安排。</p><a class="btn btn-primary" href="ai-results.html">去 AI 面试结果 →</a></div>';
      return;
    }
    host.innerHTML = '<div class="screen-table-wrap"><table class="screen-table ws-table"><thead><tr>'
      + '<th>候选人 / 岗位</th><th>面试时间</th><th>面试官</th><th>形式</th><th>状态</th><th>结论</th><th>结果发送</th><th></th>'
      + '</tr></thead><tbody>' + shown.map((item) => {
        const interview = item.humanInterview;
        return '<tr class="ws-row" data-open="' + esc(item.id) + '">'
          + '<td><strong>' + esc(item.candidateName || '候选人') + '</strong><small>' + esc(item.jobTitle || '') + '</small></td>'
          + '<td>' + esc(core.dateLabel(interview.scheduledAt)) + '<small>' + esc(interview.durationMinutes || 45) + ' 分钟</small></td>'
          + '<td>' + esc(interview.interviewerName || '—') + '</td>'
          + '<td>' + esc(core.modeLabel(interview.mode)) + (interview.location ? '<small>' + esc(interview.location) + '</small>' : '') + '</td>'
          + '<td>' + core.stateChip(interview.state) + '</td>'
          + '<td>' + core.resultChip(interview.result) + '</td>'
          + '<td>' + (interview.resultSent ? '已发送' : '未发送') + '</td>'
          + '<td><button type="button" class="btn btn-ghost btn-sm" data-open="' + esc(item.id) + '">处理 →</button></td></tr>';
      }).join('') + '</tbody></table></div>';
    host.querySelectorAll('[data-open]').forEach((node) => {
      node.onclick = (event) => {
        event.stopPropagation();
        const item = state.items.find((entry) => entry.id === node.dataset.open);
        if (item) openDetail(item);
      };
    });
  }

  // ---------- 详情弹窗 ----------
  function openDetail(item) {
    const interview = item.humanInterview;
    state.opened = item.id;
    const body = '<div class="ws-detail-grid">'
      + '<div><span class="ws-label">候选人</span><strong>' + esc(item.candidateName || '候选人') + '</strong></div>'
      + '<div><span class="ws-label">岗位</span><strong>' + esc(item.jobTitle || '') + '</strong></div>'
      + '<div><span class="ws-label">面试时间</span><strong>' + esc(core.dateLabel(interview.scheduledAt)) + ' · ' + esc(interview.durationMinutes || 45) + ' 分钟</strong></div>'
      + '<div><span class="ws-label">面试官</span><strong>' + esc(interview.interviewerName || '—') + '</strong></div>'
      + '<div><span class="ws-label">形式</span><strong>' + esc(core.modeLabel(interview.mode)) + (interview.location ? ' · ' + esc(interview.location) : '') + '</strong></div>'
      + '<div><span class="ws-label">房间号</span><strong>' + esc(interview.roomCode || '—') + '</strong></div>'
      + '<div><span class="ws-label">状态</span>' + core.stateChip(interview.state) + '</div>'
      + '<div><span class="ws-label">结论</span>' + core.resultChip(interview.result) + '</div>'
      + '</div>'
      + (interview.notes ? '<p class="ws-note">面试官备注：' + esc(interview.notes) + '</p>' : '')
      + '<p class="ws-hint">' + (interview.resultSent ? '结论已发送给候选人：' + esc(core.RESULT_LABELS[interview.result] || '') : '结论尚未发送给候选人。') + '</p>'
      + '<div class="ws-actions ws-modal-actions">'
      + '<button type="button" class="btn btn-ghost" data-modal-action="reschedule">改期 / 换面试官</button>'
      + '<button type="button" class="btn btn-ghost" data-modal-action="evidence">查看双确认佐证</button>'
      + '<button type="button" class="btn btn-primary" data-modal-action="result">填写结论</button>'
      + '<a class="btn btn-ghost" href="ai-results.html?id=' + encodeURIComponent(item.id) + '">AI 面试结果</a>'
      + '<a class="btn btn-ghost" href="screening.html?id=' + encodeURIComponent(item.id) + '">完整简历</a>'
      + '</div>';
    core.openModal('真人面试 · ' + (item.candidateName || '候选人'), body, {
      onMount: (overlay) => {
        overlay.querySelectorAll('[data-modal-action]').forEach((button) => {
          button.onclick = () => {
            if (button.dataset.modalAction === 'reschedule') openReschedule(item);
            if (button.dataset.modalAction === 'result') openResultForm(item);
            if (button.dataset.modalAction === 'evidence') openEvidence(item);
          };
        });
      },
    });
  }

  function openReschedule(item) {
    const interview = item.humanInterview;
    const body = '<div class="ws-form-grid">'
      + '<label class="ws-field"><span>面试时间</span><input id="re-at" class="input" type="datetime-local" value="' + esc(core.toDatetimeLocal(interview.scheduledAt)) + '"></label>'
      + '<label class="ws-field"><span>时长（分钟）</span><input id="re-duration" class="input" type="number" min="15" max="240" value="' + esc(interview.durationMinutes || 45) + '"></label>'
      + '<label class="ws-field"><span>面试官</span><input id="re-name" class="input" maxlength="60" value="' + esc(interview.interviewerName || '') + '"></label>'
      + '<label class="ws-field"><span>形式</span><select id="re-mode" class="input">'
      + ['video', 'onsite', 'phone'].map((mode) => '<option value="' + mode + '"' + (interview.mode === mode ? ' selected' : '') + '>' + esc(core.MODE_LABELS[mode]) + '</option>').join('')
      + '</select></label>'
      + '<label class="ws-field ws-field-wide"><span>地点 / 联系方式</span><input id="re-location" class="input" maxlength="120" value="' + esc(interview.location || '') + '"></label>'
      + '</div><p id="re-error" class="screen-error screen-hidden" role="alert"></p>'
      + '<div class="ws-actions"><button type="button" id="re-save" class="btn btn-primary">保存安排</button></div>';
    core.openModal('改期 / 换面试官', body, {
      onMount: (overlay) => {
        byId('re-save').onclick = async () => {
          const button = byId('re-save');
          button.disabled = true; showError('re-error', '');
          try {
            const scheduledAt = core.fromDatetimeLocal(byId('re-at').value);
            if (!scheduledAt) throw new Error('请选择面试时间。');
            await core.api('/api/hr/applications/' + encodeURIComponent(item.id) + '/human-interview', {
              method: 'PATCH',
              body: JSON.stringify({
                scheduledAt,
                durationMinutes: Number(byId('re-duration').value) || 45,
                interviewerName: byId('re-name').value.trim(),
                mode: byId('re-mode').value,
                location: byId('re-location').value.trim() || null,
              }),
            });
            core.closeModal();
            core.toast('安排已更新', 'ok');
            await refreshAndReopen(item.id);
          } catch (error) { showError('re-error', error.message || '保存失败。'); button.disabled = false; }
        };
      },
    });
  }

  function openResultForm(item) {
    const interview = item.humanInterview;
    const body = '<div class="ws-form-grid">'
      + '<label class="ws-field"><span>面试结论</span><select id="rs-result" class="input">'
      + ['pass', 'hold', 'reject'].map((value) => '<option value="' + value + '"' + (interview.result === value ? ' selected' : '') + '>' + esc(core.RESULT_LABELS[value]) + '</option>').join('')
      + '</select></label>'
      + '<label class="ws-field ws-field-wide"><span>内部备注（不发送给候选人）</span><textarea id="rs-notes" class="input" rows="4" maxlength="2000" placeholder="记录判断依据、待核实点与后续安排">' + esc(interview.notes || '') + '</textarea></label>'
      + '</div><label class="ws-switch"><input type="checkbox" id="rs-send"' + (interview.resultSent ? ' checked' : '') + '><span>把结论发送给候选人</span></label>'
      + '<p class="ws-hint">候选人只会看到「通过 / 待定 / 未通过」一句话，不会看到备注与评估内容。</p>'
      + '<p id="rs-error" class="screen-error screen-hidden" role="alert"></p>'
      + '<div class="ws-actions"><button type="button" id="rs-save" class="btn btn-primary">保存结论</button>'
      + '<button type="button" id="rs-toggle" class="btn btn-ghost">只切换发送状态</button></div>';
    core.openModal('填写真人面试结论', body, {
      onMount: () => {
        byId('rs-save').onclick = () => saveResult(item, {
          result: byId('rs-result').value,
          notes: byId('rs-notes').value.trim(),
          resultSent: byId('rs-send').checked,
        });
        byId('rs-toggle').onclick = () => {
          if (!interview.result) { showError('rs-error', '还没有结论，不能只切换发送状态。'); return; }
          saveResult(item, { resultSent: byId('rs-send').checked });
        };
      },
    });
  }

  async function saveResult(item, payload) {
    const buttons = [byId('rs-save'), byId('rs-toggle')].filter(Boolean);
    buttons.forEach((button) => { button.disabled = true; });
    showError('rs-error', '');
    try {
      await core.api('/api/hr/applications/' + encodeURIComponent(item.id) + '/human-interview',
        { method: 'PATCH', body: JSON.stringify(payload) });
      core.closeModal();
      core.toast('结论已保存', 'ok');
      await refreshAndReopen(item.id);
    } catch (error) {
      showError('rs-error', error.message || '保存失败。');
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  async function openEvidence(item) {
    core.openModal('双人面试间 · 双确认佐证', '<p class="muted">正在读取归档报告…</p>');
    try {
      const archived = await core.api('/api/hr/applications/' + encodeURIComponent(item.id) + '/interview-room');
      const report = archived.report || {};
      const verification = report.verification || {};
      const points = Array.isArray(report.points) ? report.points : [];
      const body = '<p class="ws-hint">归档于 ' + esc(core.dateLabel(archived.archivedAt)) + ' · 会话 ' + esc(archived.sessionId) + '</p>'
        + '<div class="ws-stats ws-stats-3">'
        + '<div class="card ws-stat"><span>取证请求</span><strong>' + (verification.requested || 0) + '</strong></div>'
        + '<div class="card ws-stat"><span>双确认坐实</span><strong>' + (verification.confirmed || 0) + '</strong></div>'
        + '<div class="card ws-stat"><span>未能坐实</span><strong>' + (verification.unconfirmed || 0) + '</strong></div>'
        + '</div>'
        + (points.length
          ? '<h3>写进报告的追问点</h3><ul class="ws-list">' + points.map((point) => '<li><b>' + esc(point.clock || '') + '</b> ' + esc(point.text || '')
            + (point.why ? ' — ' + esc(point.why) : '') + (point.adopted ? ' <span class="chip green">已采纳</span>' : '') + '</li>').join('') + '</ul>'
          : '<p class="ws-empty-copy">本场没有需要写进报告的追问点。</p>')
        + (report.summary ? '<h3>报告摘要</h3><p class="screen-panel-lead">' + esc(report.summary) + '</p>' : '');
      core.openModal('双人面试间 · 双确认佐证', body);
    } catch (error) {
      core.openModal('双人面试间 · 双确认佐证', '<p class="ws-empty-copy">' + esc(error.message || '没有可回看的面试间记录。')
        + '</p><p class="ws-hint">面试间数据只在内存中，会话结束时归档；未归档或未进行的场次无法回看。</p>');
    }
  }

  async function refreshAndReopen(id) {
    await renderList();
    const item = state.items.find((entry) => entry.id === id);
    if (item) openDetail(item);
  }

  function showError(id, message) {
    const node = byId(id);
    if (!node) return;
    node.textContent = message || '';
    node.classList.toggle('screen-hidden', !message);
  }
})();
