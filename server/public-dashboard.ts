// Self-contained read-only public dashboard HTML
// No auth, no action buttons -- spectator mode only

export const PUBLIC_DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentOS -- Live Experiment Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0a0e14; --panel: #0d1117; --border: #1b2028;
    --text: #c5c8c6; --muted: #5c6370; --accent: #61afef;
    --success: #98c379; --warn: #e5c07b; --danger: #e06c75;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; background: var(--bg); color: var(--text);
    font-family: 'IBM Plex Mono', monospace; font-size: 12px; }
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: var(--bg); }
  ::-webkit-scrollbar-thumb { background: var(--border); }

  .header { display: flex; align-items: center; gap: 16px; padding: 12px 20px;
    border-bottom: 1px solid var(--border); background: var(--panel); }
  .logo { color: var(--accent); font-size: 13px; font-weight: 600; letter-spacing: 0.12em; }
  .badge { font-size: 9px; letter-spacing: 0.08em; padding: 2px 8px;
    border: 1px solid var(--border); color: var(--muted); text-transform: uppercase; }
  .badge.live { border-color: var(--success); color: var(--success); animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
  .stat { text-align: center; }
  .stat-val { font-size: 16px; font-weight: 600; }
  .stat-label { font-size: 9px; color: var(--muted); letter-spacing: 0.08em; text-transform: uppercase; }

  .grid { display: grid; grid-template-columns: 1fr 340px; height: calc(100vh - 48px); }
  .main { overflow-y: auto; }
  .sidebar { border-left: 1px solid var(--border); overflow-y: auto; }

  .section { padding: 16px 20px; border-bottom: 1px solid var(--border); }
  .section-title { font-size: 10px; color: var(--muted); letter-spacing: 0.1em;
    text-transform: uppercase; margin-bottom: 10px; }
  .section-title span { margin-left: 6px; }

  .agent-row { display: flex; align-items: center; gap: 8px; padding: 6px 12px;
    border-left: 2px solid var(--accent); background: rgba(97,175,239,0.05); margin-bottom: 6px; }
  .agent-name { font-size: 12px; font-weight: 500; }
  .agent-role { font-size: 10px; color: var(--muted); }
  .agent-task { font-size: 11px; color: rgba(97,175,239,0.8); margin-top: 2px; }
  .task-type { font-size: 9px; color: var(--muted); text-transform: uppercase; margin-left: auto; }

  .done-group { margin-bottom: 8px; }
  .done-agent { font-size: 11px; font-weight: 500; margin-bottom: 4px; }
  .done-item { font-size: 10px; color: rgba(197,200,198,0.6); padding-left: 16px; margin-bottom: 2px; }
  .done-type { font-size: 9px; color: var(--muted); text-transform: uppercase; margin-right: 4px; }

  .activity-row { display: flex; gap: 8px; margin-bottom: 4px; font-size: 11px; }
  .activity-day { font-size: 9px; color: var(--muted); flex-shrink: 0; width: 28px; padding-top: 2px; }
  .activity-icon { font-size: 9px; flex-shrink: 0; padding-top: 2px; }
  .activity-text { color: rgba(197,200,198,0.8); }

  .queued-item { border-left: 2px solid var(--border); padding: 4px 12px; margin-bottom: 4px; font-size: 11px; }
  .queued-agent { color: var(--text); }
  .queued-desc { color: var(--muted); }

  .cfs-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 11px; }
  .cfs-name { flex: 1; }
  .cfs-bar { width: 60px; height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; }
  .cfs-fill { height: 100%; background: var(--accent); border-radius: 3px; }
  .cfs-val { font-size: 10px; color: var(--muted); width: 28px; text-align: right; }

  .gov-row { font-size: 10px; padding: 4px 0; border-bottom: 1px solid rgba(27,32,40,0.5); }
  .gov-type { font-size: 9px; text-transform: uppercase; }
  .gov-detail { color: var(--muted); margin-top: 2px; }

  .decision-row { padding: 6px 0; border-bottom: 1px solid rgba(27,32,40,0.5); }
  .decision-title { font-size: 11px; font-weight: 500; }
  .decision-meta { font-size: 9px; color: var(--muted); margin-top: 2px; }

  .phase-bar { display: flex; gap: 12px; flex-wrap: wrap; }
  .phase-item { display: flex; align-items: center; gap: 4px; font-size: 11px; }
  .phase-active { color: var(--accent); font-weight: 500; }
  .phase-done { color: var(--success); }
  .phase-pending { color: var(--muted); }

  .budget-bar { margin-top: 8px; height: 8px; background: var(--border); border-radius: 4px; overflow: hidden; }
  .budget-fill { height: 100%; border-radius: 4px; transition: width 1s; }

  .blocker-row { font-size: 10px; padding: 4px 0; color: var(--danger); }

  #error-banner { display: none; background: rgba(224,108,117,0.15); border: 1px solid var(--danger);
    color: var(--danger); padding: 8px 16px; font-size: 11px; text-align: center; }

  .empty { color: var(--muted); font-size: 11px; }
</style>
</head>
<body>
<div class="header">
  <div class="logo">AGENTOS</div>
  <div class="badge" id="status-badge">CONNECTING</div>
  <div style="flex:1"></div>
  <div class="stat"><div class="stat-val" id="h-day">--</div><div class="stat-label">Sim Day</div></div>
  <div class="stat"><div class="stat-val" style="color:var(--accent)" id="h-phase">--</div><div class="stat-label">Phase</div></div>
  <div class="stat"><div class="stat-val" style="color:var(--success)" id="h-budget">--</div><div class="stat-label">Budget Left</div></div>
  <div class="stat"><div class="stat-val" style="color:var(--warn)" id="h-revenue">--</div><div class="stat-label">Revenue</div></div>
  <div class="stat"><div class="stat-val" id="h-tasks">--</div><div class="stat-label">Completed</div></div>
  <div class="stat"><div class="stat-val" id="h-cycles">--</div><div class="stat-label">Cycles</div></div>
</div>
<div id="error-banner"></div>
<div class="grid">
  <div class="main">
    <div class="section" id="phases-section"><div class="section-title">PHASES</div><div class="phase-bar" id="phase-bar"></div></div>
    <div class="section" id="working-section"><div class="section-title">CURRENTLY WORKING <span style="color:var(--accent)" id="working-count"></span></div><div id="working-list"></div></div>
    <div class="section"><div class="section-title">COMPLETED WORK <span style="color:var(--success)" id="done-count"></span></div><div id="done-list"></div></div>
    <div class="section"><div class="section-title">ACTIVITY <span id="activity-count"></span></div><div id="activity-list"></div></div>
    <div class="section"><div class="section-title">UP NEXT</div><div id="queued-list"></div></div>
  </div>
  <div class="sidebar">
    <div class="section">
      <div class="section-title">BUDGET</div>
      <div style="display:flex;justify-content:space-between;font-size:11px">
        <span>Spent: $<span id="bud-spent">--</span></span>
        <span>Remaining: $<span id="bud-rem">--</span></span>
      </div>
      <div class="budget-bar"><div class="budget-fill" id="bud-bar" style="width:0%;background:var(--accent)"></div></div>
      <div style="font-size:10px;color:var(--muted);margin-top:4px">
        Revenue: $<span id="bud-rev">0</span> |
        Token cost: $<span id="bud-tokens">--</span>
      </div>
    </div>
    <div class="section">
      <div class="section-title">COLLABORATION SCORES (CFS)</div>
      <div id="cfs-list"></div>
    </div>
    <div class="section">
      <div class="section-title">DECISIONS</div>
      <div id="decision-list"></div>
    </div>
    <div class="section">
      <div class="section-title">BLOCKERS <span style="color:var(--danger)" id="blocker-count"></span></div>
      <div id="blocker-list"></div>
    </div>
    <div class="section">
      <div class="section-title">GOVERNANCE EVENTS</div>
      <div id="gov-list"></div>
    </div>
  </div>
</div>

<script>
const BASE = location.origin;
let lastTs = null;
let failCount = 0;

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function $(id) { return document.getElementById(id); }

const eventColors = {
  task_completed: '#98c379', handoff: '#e5c07b', review_requested: '#c678dd',
  review_assigned: '#c678dd', meeting_scheduled: '#e5c07b', human_directive: '#61afef',
};
const eventIcons = {
  task_completed: '\\u2713', handoff: '\\u2192', review_requested: '\\u2605',
  review_assigned: '\\u2605', meeting_scheduled: '\\u2606', human_directive: '\\u25B6',
};

async function poll() {
  try {
    const r = await fetch(BASE + '/public/api/snapshot');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    failCount = 0;
    $('error-banner').style.display = 'none';
    $('status-badge').textContent = d.orchestrator.running ? 'LIVE' : 'PAUSED';
    $('status-badge').className = 'badge' + (d.orchestrator.running ? ' live' : '');

    // Header stats
    $('h-day').textContent = d.simDay;
    const ap = (d.phases || []).find(p => p.status === 'active');
    $('h-phase').textContent = ap ? ap.phase_number + ': ' + ap.name : '--';
    $('h-budget').textContent = '$' + d.budget.remaining.toFixed(2);
    $('h-revenue').textContent = '$' + d.budget.revenue.toFixed(2);
    $('h-tasks').textContent = d.taskStats.completed || 0;
    $('h-cycles').textContent = d.orchestrator.cycles;

    // Phases
    $('phase-bar').innerHTML = (d.phases || []).map(p => {
      const cls = p.status === 'active' ? 'phase-active' : p.status === 'complete' ? 'phase-done' : 'phase-pending';
      const icon = p.status === 'complete' ? '\\u2713' : p.status === 'active' ? '\\u25B6' : '\\u25CB';
      return '<div class="phase-item ' + cls + '"><span style="font-size:10px">' + icon + '</span> Phase ' + p.phase_number + ': ' + esc(p.name) + '</div>';
    }).join('');

    // Working agents
    const working = (d.agents || []).filter(a => a.status === 'working');
    const running = (d.recentTasks || []).filter(t => t.status === 'running');
    $('working-count').textContent = working.length + ' agents active';
    if (working.length === 0) {
      $('working-list').innerHTML = '<div class="empty">No agents running right now.</div>';
    } else {
      $('working-list').innerHTML = working.map(a => {
        const task = running.find(t => t.agent_id === a.id);
        return '<div class="agent-row"><div><div class="agent-name">' + esc(a.personality_name) +
          '</div><div class="agent-role">' + esc(a.role) + '</div>' +
          (task ? '<div class="agent-task">' + esc(task.description.split('\\n')[0].slice(0, 120)) + '</div>' : '') +
          '</div>' + (task ? '<div class="task-type">' + esc(task.type) + '</div>' : '') + '</div>';
      }).join('');
    }

    // Completed
    const done = (d.recentTasks || []).filter(t => t.status === 'completed');
    $('done-count').textContent = (d.taskStats.completed || 0) + ' tasks';
    if (done.length === 0) {
      $('done-list').innerHTML = '<div class="empty">No completed tasks yet.</div>';
    } else {
      const byAgent = {};
      done.forEach(t => { const n = t.agent_name || 'Unknown'; (byAgent[n] = byAgent[n] || []).push(t); });
      $('done-list').innerHTML = Object.entries(byAgent).map(([name, tasks]) =>
        '<div class="done-group"><div class="done-agent"><span style="color:var(--success);font-size:9px;margin-right:4px">\\u2713</span>' +
        esc(name) + ' <span style="color:var(--muted);font-weight:normal">(' + tasks.length + ')</span></div>' +
        tasks.map(t => '<div class="done-item"><span style="color:var(--muted);margin-right:4px">\\u2022</span><span class="done-type">' +
          esc(t.type) + '</span>' + esc(t.description.split('\\n')[0].slice(0, 100)) + '</div>').join('') + '</div>'
      ).join('');
    }

    // Activity
    $('activity-count').textContent = (d.activity || []).length + ' events';
    $('activity-list').innerHTML = (d.activity || []).slice(0, 40).map(ev => {
      const col = eventColors[ev.event_type] || '#c5c8c6';
      const icon = eventIcons[ev.event_type] || '\\u2022';
      return '<div class="activity-row"><div class="activity-day">D' + ev.sim_day + '</div>' +
        '<div class="activity-icon" style="color:' + col + '">' + icon + '</div>' +
        '<div class="activity-text">' + esc(ev.summary) + '</div></div>';
    }).join('') || '<div class="empty">No activity yet.</div>';

    // Queued
    const queued = (d.recentTasks || []).filter(t => t.status === 'queued');
    $('queued-list').innerHTML = queued.length === 0
      ? '<div class="empty">No tasks in queue.</div>'
      : queued.map(t => '<div class="queued-item"><span class="queued-agent">' + esc(t.agent_name || '') +
        '</span> <span style="color:var(--muted)">--</span> <span class="done-type">' + esc(t.type) +
        '</span> <span class="queued-desc">' + esc(t.description.split('\\n')[0].slice(0, 80)) + '</span></div>').join('');

    // Budget sidebar
    $('bud-spent').textContent = d.budget.spent.toFixed(2);
    $('bud-rem').textContent = d.budget.remaining.toFixed(2);
    $('bud-rev').textContent = d.budget.revenue.toFixed(2);
    const pct = Math.min(100, (d.budget.spent / d.budget.total) * 100);
    $('bud-bar').style.width = pct + '%';
    $('bud-bar').style.background = pct > 80 ? 'var(--danger)' : pct > 60 ? 'var(--warn)' : 'var(--accent)';
    $('bud-tokens').textContent = d.tokenCosts ? '$' + (d.tokenCosts.totalCostUSD || 0).toFixed(4) : '--';

    // CFS
    const cfs = d.cfs || [];
    if (cfs.length === 0) {
      $('cfs-list').innerHTML = '<div class="empty">No collaboration data yet.</div>';
    } else {
      const maxScore = Math.max(...cfs.map(c => c.score || c.cfs || 0), 1);
      $('cfs-list').innerHTML = cfs.slice(0, 15).map(c => {
        const score = c.score || c.cfs || 0;
        const pct = Math.min(100, (score / maxScore) * 100);
        return '<div class="cfs-row"><div class="cfs-name">' + esc(c.personality_name || c.agent_id || '') +
          '</div><div class="cfs-bar"><div class="cfs-fill" style="width:' + pct + '%"></div></div>' +
          '<div class="cfs-val">' + score.toFixed(1) + '</div></div>';
      }).join('');
    }

    // Decisions
    const decs = d.decisions || [];
    $('decision-list').innerHTML = decs.length === 0
      ? '<div class="empty">No decisions yet.</div>'
      : decs.slice(0, 8).map(dec => '<div class="decision-row"><div class="decision-title">' +
        esc(dec.title) + '</div><div class="decision-meta">by ' + esc(dec.made_by_agent || '?') +
        ' | ' + esc(dec.status) + '</div></div>').join('');

    // Blockers
    const blockers = d.blockers || [];
    $('blocker-count').textContent = blockers.length > 0 ? blockers.length + ' active' : '';
    $('blocker-list').innerHTML = blockers.length === 0
      ? '<div class="empty">No active blockers.</div>'
      : blockers.map(b => '<div class="blocker-row">\\u26A0 ' + esc(b.agent_id || '') + ': ' + esc(b.reason || '') + '</div>').join('');

    // Governance
    const gov = d.governance || [];
    $('gov-list').innerHTML = gov.length === 0
      ? '<div class="empty">No governance events.</div>'
      : gov.slice(0, 12).map(g => {
        const col = g.severity === 'critical' ? 'var(--danger)' : g.severity === 'warning' ? 'var(--warn)' : 'var(--muted)';
        return '<div class="gov-row"><div class="gov-type" style="color:' + col + '">' + esc(g.event_type || '') +
          '</div><div class="gov-detail">' + esc((g.details || '').slice(0, 120)) + '</div></div>';
      }).join('');

  } catch (e) {
    failCount++;
    if (failCount > 3) {
      $('error-banner').style.display = 'block';
      $('error-banner').textContent = 'Connection lost: ' + e.message + ' (retrying...)';
      $('status-badge').textContent = 'OFFLINE';
      $('status-badge').className = 'badge';
    }
  }
}

// Poll every 5 seconds
poll();
setInterval(poll, 5000);
</script>
</body>
</html>`;
