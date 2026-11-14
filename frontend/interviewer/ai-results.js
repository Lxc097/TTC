/* 企业端「AI 面试结果」：回答证据、指标条、进入真人面试与结果发送。
 *
 * 数据来自 PR1 的接口：
 * - 列表：GET /api/hr/applications（含 invitation 与 stage）
 * - 详情：GET /api/hr/applications/{id}（含 formalInterview 分析）
 * - 真人面试：POST /api/hr/applications/{id}/human-interview
 * - 结果发送：POST /api/hr/applications/{id}/ai-result/send
 */
(function () {
  'use strict';
  const core = window.TTCWorkspace;
  const app = document.getElementById('screen-app');
  const byId = (id) => document.getElementById(id);
  const esc = core.esc;
  const state = { items: [], filter: 'all', detail: null };

  (async () => {
    const current = await core.initPage('ai');
    if (!current) return;
    route();
  })();
  window.addEventListener('hashchange', route);

  function route() {
    const hash = (location.hash || '').replace(/^#\/?/, '');
    const id = core.query('id') || (hash.startsWith('result/') ? hash.split('/')[1] : '');
    if (id) openResult(id);
    else renderList();
  }

  // ---------- 列表 ----------
  async function renderList() {
    state.detail = null;
    app.innerHTML = pageHead() + '<div id="ai-error" class="screen-error screen-hidden" role="alert"></div>'
      + '<section class="ws-stats" id="ai-stats"></section><div class="ws-toolbar">'
      + '<div class="ws-chips" id="ai-filters" role="group" aria-label="按状态筛选">'
      + chipButton('all', '全部') + chipButton('pending', '待开始') + chipButton('in_progress', '进行中')
      + chipButton('completed', '已完成') + chipButton('analysis_failed', '分析失败')
      + '</div></div><div id="ai-list"><p class="muted">正在读取 AI 面试记录…</p></div>';
    byId('ai-filters').querySelectorAll('[data-filter]').forEach((button) => {
      button.onclick = () => { state.filter = button.dataset.filter; renderList(); };
    });
    try {
      const result = await core.api('/api/hr/applications');
      state.items = (result.items || []).filter((item) => item.invitation);
      drawStats();
      drawList();
    } catch (error) {
      byId('ai-list').innerHTML = '<p class="screen-error">' + esc(error.message || '无法读取申请。') + '</p>';
    }
  }

  function pageHead() {
    return '<div class="screen-heading"><div><span class="eyebrow">天镜 招聘 · 企业端</span><h1>AI 面试结果</h1>'
      + '<p>按题看引用与推理，再决定是否进入真人面试。生理信号与行为信号只在双人面试间采集。</p></div>'
      + '<div class="screen-heading-actions"><a class="btn btn-ghost" href="screening.html#/board">返回查看简历</a></div></div>';
  }

  function chipButton(value, label) {
    return '<button type="button" data-filter="' + value + '" class="ws-chip' + (state.filter === value ? ' on' : '') + '">' + label + '</button>';
  }

  function drawStats() {
    const items = state.items;
    const completed = items.filter((item) => item.status === 'ai_interview_completed'
      || item.formalInterview?.status === 'completed');
    const sent = items.filter((item) => item.aiResultSent);
    const failed = items.filter((item) => ['failed'].includes(item.status));
    byId('ai-stats').innerHTML = [
      ['已邀 AI 初面', items.length],
      ['已完成初面', completed.length],
      ['结果已发送', sent.length],
      ['处理异常', failed.length],
    ].map(([label, value]) => '<div class="card ws-stat"><span>' + label + '</span><strong>' + value + '</strong></div>').join('');
  }

  function category(item) {
    if (['failed', 'submitted', 'hr_review'].includes(item.status)) return 'analysis_failed';
    if (item.status === 'ai_interview_invited') return 'pending';
    if (item.status === 'ai_interview_in_progress') return 'in_progress';
    if (item.status === 'ai_interview_completed' || item.status === 'hr_interview_invited' || item.status === 'closed') return 'completed';
    return 'pending';
  }

  function statusTone(item) {
    if (item.status === 'failed') return 'red';
    if (item.status === 'ai_interview_completed' || item.status === 'hr_interview_invited' || item.status === 'closed') return 'green';
    if (item.status === 'ai_interview_in_progress') return 'amber';
    if (item.invitation?.state === 'expired') return 'red';
    return 'gray';
  }

  function aiCard(item) {
    const invitation = item.invitation || {};
    const completed = item.status === 'ai_interview_completed' || item.status === 'hr_interview_invited' || item.status === 'closed';
    const inProgress = item.status === 'ai_interview_in_progress' || invitation.state === 'accepted';
    const name = item.candidateName || '候选人';
    const summary = completed ? '已完成 AI 初面，逐题引用与分析可在结果页复核。'
      : inProgress ? '候选人正在 AI 初面中，完成后这里会出现引用与分析。'
      : invitation.state === 'expired' ? '邀请已过期，可在「邀请记录」里重发。'
      : '已发出邀请，等待候选人进入初面。';
    return '<article class="ai-card" data-open="' + esc(item.id) + '">'
      + '<header class="ai-card-head">'
      + '<span class="ws-avatar" aria-hidden="true">' + esc(String(name).slice(0, 1)) + '</span>'
      + '<div class="ai-who"><strong>' + esc(name) + '</strong>'
      + '<small>' + esc(item.jobTitle || '未填岗位') + ' · ' + esc(core.sourceLabel(item.source)) + '</small></div>'
      + '<span class="ws-badge ' + statusTone(item) + '">' + esc(completed ? '已完成' : inProgress ? '进行中' : invitation.state === 'expired' ? '已过期' : '待进入') + '</span>'
      + '</header>'
      + '<p class="ai-card-summary">' + summary + '</p>'
      + '<div class="ai-card-metrics" data-metrics="' + esc(item.id) + '"><span class="ai-card-muted">正在读取分析…</span></div>'
      + '<div class="ws-meta"><span>邀请截止 ' + esc(core.deadlineLabel(invitation.expiresAt)) + '</span>'
      + '<span>' + (item.aiResultSent ? '结果已发送' : '结果未发送') + '</span></div>'
      + '<div class="ai-card-actions">'
      + '<button type="button" class="btn btn-primary btn-sm" data-open="' + esc(item.id) + '">查看佐证</button>'
      + '<a class="btn btn-ghost btn-sm" href="screening.html?id=' + encodeURIComponent(item.id) + '">简历与初筛</a>'
      + '</div></article>';
  }

  async function fillCardMetrics(host, shown) {
    const nodes = Array.from(host.querySelectorAll('[data-metrics]')).slice(0, 9);
    await Promise.all(nodes.map(async (node) => {
      const id = node.dataset.metrics;
      try {
        const detail = await core.api('/api/hr/applications/' + encodeURIComponent(id));
        const evidence = detail?.formalInterview?.analysis?.answerEvidence || [];
        if (!evidence.length) {
          node.innerHTML = '<span class="ai-card-muted">还没有逐题引用；分析完成后显示回答具体度分布。</span>';
          return;
        }
        const dist = { specific: 0, partial: 0, unclear: 0 };
        evidence.forEach((entry) => { if (dist[entry.assessment] != null) dist[entry.assessment] += 1; });
        const total = dist.specific + dist.partial + dist.unclear || 1;
        const row = (key, label, tone) => '<div class="ai-metric"><span>' + label + '</span>'
          + '<div class="bar"><i class="' + tone + '" style="width:' + Math.round(dist[key] / total * 100) + '%"></i></div>'
          + '<b>' + dist[key] + '</b></div>';
        node.innerHTML = row('specific', '回答具体', 'ok') + row('partial', '部分具体', 'warn') + row('unclear', '证据不足', 'muted');
      } catch (_) {
        node.innerHTML = '<span class="ai-card-muted">暂无法读取分析。</span>';
      }
    }));
  }

  function drawList() {
    const host = byId('ai-list');
    if (!host) return;
    const shown = state.items.filter((item) => state.filter === 'all' || category(item) === state.filter);
    if (!shown.length) {
      host.innerHTML = '<div class="ws-empty"><h2>还没有 AI 初面记录</h2><p>在「查看简历」里发送 AI 面试邀请后，候选人的回答与分析会出现在这里。</p><a class="btn btn-primary" href="screening.html#/board">去查看简历 →</a></div>';
      return;
    }
    host.innerHTML = '<div class="ai-grid">' + shown.map(aiCard).join('') + '</div>';
    host.querySelectorAll('[data-open]').forEach((node) => {
      node.onclick = (event) => {
        event.stopPropagation();
        location.hash = '#/result/' + node.dataset.open;
      };
    });
    fillCardMetrics(host, shown);
  }

  // ---------- 详情 ----------
  async function openResult(id) {
    app.innerHTML = '<a class="screen-back" href="ai-results.html#/">← 返回 AI 面试结果</a>'
      + '<div id="ai-detail"><p class="muted">正在读取初面记录…</p></div>';
    try {
      const detail = await core.api('/api/hr/applications/' + encodeURIComponent(id));
      state.detail = detail;
      drawDetail(detail);
    } catch (error) {
      byId('ai-detail').innerHTML = '<p class="screen-error">' + esc(error.message || '无法读取初面记录。') + '</p>';
    }
  }

  function drawDetail(item) {
    const formal = item.formalInterview;
    const analysis = formal?.analysis;
    const answers = Array.isArray(formal?.answers) ? formal.answers : [];
    const evidence = Array.isArray(analysis?.answerEvidence) ? analysis.answerEvidence : [];
    const distribution = { specific: 0, partial: 0, unclear: 0 };
    evidence.forEach((entry) => { if (distribution[entry.assessment] != null) distribution[entry.assessment] += 1; });
    const durationMinutes = formal?.startedAt && formal?.completedAt
      ? Math.max(1, Math.round((formal.completedAt - formal.startedAt) / 60)) : null;
    const completed = item.status === 'ai_interview_completed';
    const scheduled = item.humanInterview;
    const room = item.interviewRoomReport;

    byId('ai-detail').innerHTML = '<div class="screen-detail-heading"><div><span class="eyebrow">AI 初面 · ' + esc(core.statusLabel(item.status)) + '</span>'
      + '<h1>' + esc(item.candidateName || '候选人') + '</h1>'
      + '<p>' + esc(item.jobTitle || '') + ' · ' + esc(core.sourceLabel(item.source)) + ' · ' + core.stageChip(item.stage) + '</p></div>'
      + '<div class="screen-heading-actions">'
      + '<a class="btn btn-ghost" href="screening.html?id=' + encodeURIComponent(item.id) + '">完整简历与初筛</a>'
      + (scheduled ? '<a class="btn btn-ghost" href="human-results.html?id=' + encodeURIComponent(item.id) + '">真人面试：' + esc(core.stateChip(scheduled.state)) + '</a>' : '')
      + '</div></div>'
      + '<div id="ai-detail-error" class="screen-error screen-hidden" role="alert"></div>'
      + metricSection(formal, analysis, distribution, answers, durationMinutes, evidence)
      + summarySection(analysis, formal)
      + evidenceSection(evidence)
      + answersSection(answers)
      + roomSection(room, item)
      + actionsSection(item, completed, scheduled);

    bindActions(item, completed, scheduled);
  }

  function metricSection(formal, analysis, distribution, answers, durationMinutes, evidence) {
    if (!formal) {
      return '<section class="card screen-panel"><h2>还没有 AI 初面记录</h2><p class="ws-empty-copy">候选人尚未进入初面。邀请状态与重发在「邀请记录」里处理。</p></section>';
    }
    const total = distribution.specific + distribution.partial + distribution.unclear || 1;
    const bar = (key, label, tone) => {
      const value = distribution[key];
      return '<div class="ws-metric-row"><span>' + label + '</span><div class="ws-metric-bar"><i class="' + tone + '" style="width:' + Math.round(value / total * 100) + '%"></i></div><strong>' + value + '</strong></div>';
    };
    return '<section class="ws-stats ws-stats-4">'
      + '<div class="card ws-stat"><span>完成题数</span><strong>' + answers.length + '</strong><small>' + esc(formal.status === 'completed' ? '已提交' : '进行中') + '</small></div>'
      + '<div class="card ws-stat"><span>逐题证据</span><strong>' + evidence.length + '</strong><small>可定位引用</small></div>'
      + '<div class="card ws-stat"><span>用时</span><strong>' + (durationMinutes == null ? '—' : durationMinutes + ' 分') + '</strong><small>完成至提交</small></div>'
      + '<div class="card ws-stat"><span>分析模型</span><strong class="ws-stat-text">' + esc(formal.analysisModel || (analysis ? 'DeepSeek' : '待分析')) + '</strong><small>' + esc(analysis ? '分析已完成' : formal.analysisStatus === 'failed' ? '分析失败' : '分析排队中') + '</small></div>'
      + '</section>'
      + '<section class="card screen-panel"><h2>指标条</h2><p class="ws-empty-copy">只统计过程与证据，不给候选人打分或排名。</p>'
      + bar('specific', '回答具体', 'ok') + bar('partial', '部分具体', 'warn') + bar('unclear', '证据不足', 'muted')
      + '</section>';
  }

  function summarySection(analysis, formal) {
    if (!formal) return '';
    if (!analysis) {
      return '<section class="card screen-panel"><h2>AI 总结</h2><div class="screen-pending"><p>'
        + esc(formal.status === 'completed' ? '面试已完成，正在分析问答证据。' : '面试进行中，完成后生成分析。') + '</p>'
        + (formal.analysisStatus === 'failed' ? '<small>' + esc(formal.analysisError || '模型分析失败。') + '</small>'
          + '<button type="button" id="ai-retry" class="btn btn-ghost btn-sm">重新分析</button>' : '') + '</div></section>';
    }
    return '<section class="card screen-panel"><h2>AI 总结</h2>'
      + '<p class="screen-panel-lead">' + esc(analysis.summary || '') + '</p>'
      + '<div class="ws-two-col"><div><h3>有依据的优势</h3>' + core.listStrings(analysis.strengths, '暂无。') + '</div>'
      + '<div><h3>证据缺口</h3>' + core.listStrings(analysis.gaps, '暂无。') + '</div></div>'
      + '<h3>建议真人面试追问</h3>' + core.listStrings(analysis.followUpQuestions, '暂无。')
      + '<h3>分析限制</h3>' + core.listStrings(analysis.limitations, '暂无。') + '</section>';
  }

  function evidenceSection(evidence) {
    if (!evidence.length) {
      return '<section class="card screen-panel"><h2>佐证观看</h2><p class="ws-empty-copy">还没有可定位的逐题引用。分析完成后会显示回答原文与推理。</p></section>';
    }
    const labels = { specific: '回答具体', partial: '部分具体', unclear: '证据不足' };
    return '<section class="card screen-panel"><h2>佐证观看</h2>'
      + '<p class="ws-empty-copy">每条都能回到候选人原话；引用来自同一题的连续原文。</p>'
      + evidence.map((entry) => '<article class="ws-evidence"><header><span class="chip ' + (entry.assessment === 'specific' ? 'green' : entry.assessment === 'partial' ? 'amber' : 'gray') + '">' + esc(labels[entry.assessment] || '待核实') + '</span>'
        + '<small>题目 ' + esc(entry.questionId) + '</small></header>'
        + '<blockquote>' + esc(entry.answerQuote || '') + '</blockquote>'
        + '<p>' + esc(entry.reasoning || '') + '</p>'
        + '<p class="ws-follow-up"><b>真人面试追问：</b>' + esc(entry.followUpQuestion || '') + '</p></article>').join('')
      + '</section>';
  }

  function answersSection(answers) {
    if (!answers.length) return '';
    return '<section class="card screen-panel"><details><summary>查看原始问答（' + answers.length + ' 题）</summary>'
      + '<ol class="screen-formal-answers">' + answers.map((entry, index) => '<li><strong>问题 ' + (index + 1) + '：' + esc(entry.prompt || '') + '</strong>'
        + '<p>' + esc(entry.answer || '未记录回答') + '</p><small>' + esc(core.dateLabel(entry.createdAt)) + '</small></li>').join('') + '</ol></details></section>';
  }

  function roomSection(room, item) {
    return '<section class="card screen-panel"><h2>生理 ∧ 行为双确认</h2>'
      + (room
        ? '<p class="ws-empty-copy">来自双人面试间的归档报告（' + esc(core.dateLabel(room.archivedAt)) + '）。单一生理信号不出提示，双确认后的追问点如下。</p>'
          + roomVerification(room.report)
        : '<p class="ws-empty-copy">本次没有双人面试间的归档记录。AI 初面默认不采集画面生理信号；需要双确认佐证时，请在真人面试中使用面试间。</p>')
      + '</section>';
  }

  function roomVerification(report) {
    const verification = report?.verification || {};
    const points = Array.isArray(report?.points) ? report.points : [];
    return '<div class="ws-stats ws-stats-3">'
      + '<div class="card ws-stat"><span>取证请求</span><strong>' + (verification.requested || 0) + '</strong></div>'
      + '<div class="card ws-stat"><span>双确认坐实</span><strong>' + (verification.confirmed || 0) + '</strong></div>'
      + '<div class="card ws-stat"><span>未能坐实</span><strong>' + (verification.unconfirmed || 0) + '</strong></div>'
      + '</div>'
      + (points.length ? '<ul class="ws-list">' + points.map((point) => '<li><b>' + esc(point.clock || '') + '</b> ' + esc(point.text || '')
        + (point.why ? ' — ' + esc(point.why) : '') + '</li>').join('') + '</ul>' : '<p class="ws-empty-copy">本场没有需要写进报告的追问点。</p>');
  }

  function actionsSection(item, completed, scheduled) {
    const aiResultSent = item.aiResultSent;
    return '<section class="card screen-panel"><h2>下一步</h2>'
      + '<div class="ws-actions">'
      + '<label class="ws-switch"><input type="checkbox" id="ai-result-sent"' + (aiResultSent ? ' checked' : '')
      + (completed ? '' : ' disabled') + '><span>把结果发送给候选人</span></label>'
      + '<span class="ws-hint">只发送一句通用结论，不发送分析内容与分数。</span></div>'
      + (scheduled
        ? '<p class="ws-inline-note">已安排真人面试：' + esc(core.dateLabel(scheduled.scheduledAt)) + ' · ' + esc(scheduled.interviewerName || '') + ' · ' + esc(core.modeLabel(scheduled.mode)) + '。'
          + ' <a href="human-results.html?id=' + encodeURIComponent(item.id) + '">去真人面试结果页处理 →</a></p>'
        : item.status === 'ai_interview_in_progress'
          ? '<p class="ws-empty-copy">候选人正在 AI 初面中，完成后再安排真人面试。</p>'
          : '<details class="ws-schedule"><summary class="btn btn-primary btn-sm">进入真人面试</summary>'
          + '<div class="ws-form-grid"><label class="ws-field"><span>面试时间</span><input id="human-at" class="input" type="datetime-local"></label>'
          + '<label class="ws-field"><span>时长（分钟）</span><input id="human-duration" class="input" type="number" min="15" max="240" value="45"></label>'
          + '<label class="ws-field"><span>面试官</span><input id="human-name" class="input" maxlength="60" placeholder="面试官姓名"></label>'
          + '<label class="ws-field"><span>形式</span><select id="human-mode" class="input"><option value="video">线上视频</option><option value="onsite">线下面试</option><option value="phone">电话面试</option></select></label>'
          + '<label class="ws-field ws-field-wide"><span>地点 / 联系方式（线下或电话必填）</span><input id="human-location" class="input" maxlength="120" placeholder="例如：上海张江 3 号楼 / 电话 138****"></label>'
          + '</div><div class="ws-actions"><button type="button" id="human-save" class="btn btn-primary">确认安排</button>'
          + '<span class="ws-hint">线上视频会复用该申请的双人面试间，房间号自动生成。</span></div></details>')
      + '</section>';
  }

  function bindActions(item, completed, scheduled) {
    const sent = byId('ai-result-sent');
    if (sent) {
      sent.onchange = async () => {
        sent.disabled = true;
        try {
          await core.api('/api/hr/applications/' + encodeURIComponent(item.id) + '/ai-result/send',
            { method: 'POST', body: JSON.stringify({ visible: sent.checked }) });
          core.toast(sent.checked ? '结果已发送给候选人' : '已收起候选人结果', 'ok');
        } catch (error) {
          sent.checked = !sent.checked;
          core.toast(error.message || '操作失败', 'error');
        } finally { sent.disabled = !completed; }
      };
    }
    const retry = byId('ai-retry');
    if (retry) {
      retry.onclick = async () => {
        retry.disabled = true;
        try {
          await core.api('/api/hr/applications/' + encodeURIComponent(item.id) + '/interview-analysis/retry', { method: 'POST' });
          core.toast('已重新排队分析', 'ok');
          setTimeout(() => openResult(item.id), 1500);
        } catch (error) { core.toast(error.message || '重试失败', 'error'); retry.disabled = false; }
      };
    }
    const at = byId('human-at');
    if (at && !scheduled) {
      const tomorrow = new Date(Date.now() + 86400000);
      tomorrow.setHours(10, 0, 0, 0);
      at.value = core.toDatetimeLocal(tomorrow.toISOString());
    }
    const save = byId('human-save');
    if (save) {
      save.onclick = async () => {
        const scheduledAt = core.fromDatetimeLocal(byId('human-at').value);
        const interviewerName = byId('human-name').value.trim();
        if (!scheduledAt || !interviewerName) { core.toast('请填写面试时间与面试官', 'error'); return; }
        save.disabled = true;
        try {
          await core.api('/api/hr/applications/' + encodeURIComponent(item.id) + '/human-interview', {
            method: 'POST',
            body: JSON.stringify({
              scheduledAt,
              durationMinutes: Number(byId('human-duration').value) || 45,
              interviewerName,
              mode: byId('human-mode').value,
              location: byId('human-location').value.trim() || null,
            }),
          });
          core.toast('已安排真人面试', 'ok');
          await openResult(item.id);
        } catch (error) { core.toast(error.message || '安排失败', 'error'); save.disabled = false; }
      };
    }
  }
})();
