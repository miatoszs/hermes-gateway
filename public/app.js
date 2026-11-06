// Hermes Gateway UI — folds one SSE stream (/api/events) into state and renders it.
const $ = (s) => document.querySelector(s);
const S = {
  agents: [], threads: {}, mock: false, active: 'squad', targets: new Set(), unread: {},
  rendered: new Map(), mention: null, connected: false,
};
const store = {
  get(k, d) { try { const v = localStorage.getItem('hgw.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('hgw.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
S.active = store.get('active', 'squad');
S.unread = store.get('unread', {});
const theme = store.get('theme', null);
if (theme) document.documentElement.dataset.theme = theme;
if (store.get('details', true) === false) $('#app').classList.add('no-details');

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const agent = (id) => S.agents.find((a) => a.id === id);
const thread = () => S.threads[S.active];
const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const STATUS_LABEL = { online: 'online', offline: 'offline', auth: 'key rejected', nokey: 'no key', unconfigured: 'not configured', disabled: 'API off', unknown: 'checking…' };
const RUN_LABEL = { queued: 'queued', running: 'working', waiting: 'needs approval', stopping: 'stopping', failed: 'failed', cancelled: 'stopped', interrupted: 'interrupted' };
const CHOICE_LABEL = { once: 'Allow once', session: 'Allow for session', always: 'Always allow', deny: 'Deny' };
const ACTIVE = new Set(['queued', 'running', 'waiting', 'stopping']);

function avatar(a, cls = '', dot = true) {
  if (!a) return `<div class="avatar ${cls}" style="background:var(--panel-3)">?</div>`;
  return `<div class="avatar ${cls}" style="background:${esc(a.color)}26;border:1px solid ${esc(a.color)}66">${esc(a.emoji)}${dot ? `<span class="dot ${esc(a.health?.status)}"></span>` : ''}</div>`;
}

function md(src) {
  const blocks = [];
  let s = String(src || '').replace(/```([\w+-]*)\n?([\s\S]*?)(```|$)/g, (_, lang, code) => {
    blocks.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  s = esc(s);
  const inline = (t) => t
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  const out = [];
  let list = null, para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.t}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.t}>`); list = null; } };
  const lines = s.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = line.match(/^\u0000(\d+)\u0000$/))) { flushPara(); flushList(); out.push(blocks[+m[1]]); continue; }
    if (/^\s*$/.test(line)) { flushPara(); flushList(); continue; }
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flushPara(); flushList(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue; }
    if ((m = line.match(/^&gt;\s?(.*)$/))) { flushPara(); flushList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      flushPara(); flushList();
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      const head = cells(line); i += 1;
      const rows = [];
      while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) rows.push(cells(lines[++i]));
      out.push(`<table><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`);
      continue;
    }
    if ((m = line.match(/^\s*([-*•]|\d+[.)])\s+(.*)$/))) {
      flushPara();
      const t = /\d/.test(m[1]) ? 'ol' : 'ul';
      if (!list || list.t !== t) { flushList(); list = { t, items: [] }; }
      list.items.push(m[2]); continue;
    }
    flushList(); para.push(line);
  }
  flushPara(); flushList();
  return out.join('').replace(/\u0000(\d+)\u0000/g, (_, n) => blocks[+n]);
}

async function api(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
function toast(text) {
  const t = document.createElement('div');
  t.className = 'system'; t.textContent = text;
  $('#messages').appendChild(t); scrollBottom(true);
  setTimeout(() => t.remove(), 6000);
}

// ---------- sidebar ----------
function lastMessage(t) {
  for (let i = (t?.messages.length || 0) - 1; i >= 0; i--) { const m = t.messages[i]; if (m.role !== 'system') return m; }
  return null;
}
function previewOf(t) {
  const m = lastMessage(t);
  if (!m) return '';
  if (m.role === 'user') return 'You: ' + m.text;
  if (ACTIVE.has(m.status)) return RUN_LABEL[m.status] + '…';
  return (t.kind === 'squad' ? (agent(m.agent)?.name || m.agent) + ': ' : '') + (m.text || m.error || RUN_LABEL[m.status] || '');
}
function renderSidebar() {
  const sq = S.threads.squad;
  const anyRunning = S.agents.some((a) => a.running > 0);
  $('#channelList').innerHTML = `
    <button class="row ${S.active === 'squad' ? 'active' : ''}" data-thread="squad">
      <div class="hash">#</div>
      <div class="meta"><div class="name">squad ${anyRunning ? '<span class="spinner"></span>' : ''}</div>
      <div class="preview">${esc(previewOf(sq) || 'Message every agent at once')}</div></div>
      ${S.unread.squad ? `<span class="badge">${S.unread.squad}</span>` : ''}
    </button>`;
  $('#agentList').innerHTML = S.agents.map((a) => {
    const tid = `dm:${a.id}`;
    return `<button class="row ${S.active === tid ? 'active' : ''}" data-thread="${esc(tid)}" title="${esc(a.role)}">
      ${avatar(a)}
      <div class="meta"><div class="name">${esc(a.name)} ${a.running ? '<span class="spinner"></span>' : ''}</div>
      <div class="preview">${esc(previewOf(S.threads[tid]) || a.role)}</div></div>
      ${S.unread[tid] ? `<span class="badge">${S.unread[tid]}</span>` : ''}
    </button>`;
  }).join('');
  const online = S.agents.filter((a) => a.health?.status === 'online').length;
  $('#onlineCount').textContent = `${online}/${S.agents.length} online`;
  $('#brandSub').textContent = !S.connected ? 'reconnecting…' : S.mock ? 'mock squad · test mode' : `${S.agents.length} agents`;
  const total = Object.values(S.unread).reduce((a, b) => a + b, 0);
  document.title = total ? `(${total}) Hermes Gateway` : 'Hermes Gateway';
}

// ---------- header + details ----------
function renderHeader() {
  const t = thread();
  if (!t) return;
  if (t.kind === 'squad') {
    $('#headAvatar').innerHTML = S.agents.slice(0, 5).map((a) => avatar(a, '', false)).join('');
    $('#headTitle').textContent = '# squad';
    $('#headSub').textContent = `${S.agents.map((a) => a.name).join(', ')} · @mention to target, otherwise everyone gets it`;
    $('#input').placeholder = 'Message the squad… (@ to mention)';
  } else {
    const a = agent(t.agent);
    $('#headAvatar').innerHTML = avatar(a, '');
    $('#headTitle').textContent = a?.name || t.agent;
    $('#headSub').textContent = `${a?.role || ''} · ${STATUS_LABEL[a?.health?.status] || ''}${a?.health?.model ? ' · ' + a.health.model : ''}`;
    $('#input').placeholder = `Message ${a?.name || t.agent}…`;
  }
}
function agentCard(a, t) {
  const h = a.health || {};
  const sess = t?.messages.slice().reverse().find((m) => m.agent === a.id && m.sessionId)?.sessionId;
  return `<div class="card">
    <div class="top">${avatar(a, 'lg')}<div style="min-width:0"><div style="font-weight:700">${esc(a.name)}</div><div class="help">${esc(a.role)}</div></div></div>
    <dl class="kv">
      <dt>Status</dt><dd><span class="pill ${esc(h.status)}">${esc(STATUS_LABEL[h.status] || h.status)}</span>${a.running ? ` · ${a.running} running` : ''}</dd>
      ${h.model ? `<dt>Model</dt><dd>${esc(h.model)}</dd>` : ''}
      <dt>Profile</dt><dd><code>${esc(a.profile || '—')}</code></dd>
      <dt>Endpoint</dt><dd><code>${esc(a.baseUrl || '—')}</code></dd>
      <dt>API key</dt><dd>${a.hasKey ? `set <span class="help">(${esc(a.keySource)})</span>` : '<span style="color:var(--warn)">missing</span>'}</dd>
      ${sess ? `<dt>Session</dt><dd><code>${esc(sess)}</code></dd>` : ''}
      ${h.error && h.status !== 'online' ? `<dt>Error</dt><dd style="color:var(--bad)">${esc(h.error)}</dd>` : ''}
    </dl>
    ${t?.kind === 'squad' ? `<div style="margin-top:10px;display:flex;gap:6px"><button class="btn" data-dm="${esc(a.id)}">Open DM</button><button class="btn" data-reset-agent="${esc(a.id)}">New session</button></div>` : ''}
  </div>`;
}
function renderDetails() {
  const t = thread();
  if (!t) return;
  const list = t.kind === 'squad' ? S.agents : [agent(t.agent)].filter(Boolean);
  const bad = S.agents.filter((a) => a.health?.status !== 'online');
  $('#details').innerHTML = `
    <h3>${t.kind === 'squad' ? 'Squad' : 'Agent'}</h3>
    ${list.map((a) => agentCard(a, t)).join('')}
    ${bad.length ? `<h3>Connecting agents</h3><div class="help">
      Each Hermes profile needs its API server on. In <code>~/.hermes/profiles/&lt;profile&gt;/.env</code>:<br><br>
      <code>API_SERVER_ENABLED=true</code><br><code>API_SERVER_PORT=&lt;free port&gt;</code><br><code>API_SERVER_KEY=&lt;secret&gt;</code><br><br>
      <code>./enable-api.sh</code> does this for every profile. Then restart the profile's gateway (<code>hermes -p &lt;profile&gt; gateway</code>).</div>` : ''}
    <h3>Tips</h3><div class="help">In <b>#squad</b>, every agent gets the message unless you @mention someone. Each agent also sees what teammates replied since its last turn.<br><br><b>Enter</b> sends · <b>Shift+Enter</b> new line · <code>/new</code> fresh session.</div>`;
}

// ---------- messages ----------
function stepsHtml(m) {
  const steps = m.steps || [];
  if (!steps.length && !m.reasoning) return '';
  const tools = steps.filter((s) => s.kind === 'tool');
  const running = tools.find((s) => s.status === 'running');
  const label = running ? `Running <b>${esc(running.tool)}</b>…` : `${tools.length} tool call${tools.length === 1 ? '' : 's'}${steps.length > tools.length ? ` · ${steps.length - tools.length} note${steps.length - tools.length === 1 ? '' : 's'}` : ''}`;
  const openKey = `steps-${m.id}`;
  const open = S.openSteps?.has(openKey) || (running && ACTIVE.has(m.status));
  return `<details class="steps" data-key="${openKey}" ${open ? 'open' : ''}><summary>${running ? '<span class="spinner"></span>' : '⚙'} ${label}</summary>
    ${m.reasoning ? `<div class="step note">💭 ${esc(m.reasoning.slice(0, 600))}</div>` : ''}
    ${steps.map((s) => s.kind === 'tool'
      ? `<div class="step tool ${esc(s.status)}"><div style="min-width:0">${s.status === 'running' ? '<span class="spinner"></span> ' : s.status === 'error' ? '✗ ' : '✓ '}<span class="tname">${esc(s.tool)}</span> <code>${esc((s.preview || '').slice(0, 300))}</code>${s.duration != null ? ` <span class="help">${Number(s.duration).toFixed(1)}s</span>` : ''}${s.result ? `<span class="res">${esc(s.result.slice(0, 400))}</span>` : ''}</div></div>`
      : `<div class="step note">${esc(s.text)}</div>`).join('')}
  </details>`;
}
function approvalHtml(m) {
  const a = m.approval;
  if (!a) return '';
  if (a.resolved) return `<div class="help" style="margin-top:6px">🔐 Approval answered: <b>${esc(CHOICE_LABEL[a.resolved] || a.resolved)}</b>${a.command ? ` · <code>${esc(a.command.slice(0, 120))}</code>` : ''}</div>`;
  return `<div class="approval"><div class="title">🔐 Approval needed</div>
    ${a.description ? `<div class="help">${esc(a.description)}</div>` : ''}
    ${a.command ? `<pre><code>${esc(a.command)}</code></pre>` : ''}
    <div class="btns">${(a.choices || ['once', 'deny']).map((c) => `<button class="btn ${c === 'once' ? 'primary' : c === 'deny' ? 'danger' : ''}" data-approve="${esc(c)}" data-mid="${esc(m.id)}">${esc(CHOICE_LABEL[c] || c)}</button>`).join('')}</div></div>`;
}
function msgHtml(m, t) {
  if (m.role === 'system') return `<div class="system">${esc(m.text)} · ${time(m.ts)}</div>`;
  if (m.role === 'user') {
    const to = t.kind === 'squad' && m.targets ? (m.targets.length === S.agents.length ? 'everyone' : m.targets.map((x) => `<span class="tag">@${esc(x)}</span>`).join(' ')) : '';
    return `<div class="msg user"><div class="avatar" style="background:var(--user-bg)">🧑‍💼</div><div class="body">
      <div class="msg-head">${to ? `<span class="to">to ${to}</span>` : ''}<span>${time(m.ts)}</span></div>
      <div class="bubble">${esc(m.text)}</div></div></div>`;
  }
  const a = agent(m.agent);
  const active = ACTIVE.has(m.status);
  const tokens = m.usage?.total_tokens ? `${m.usage.total_tokens.toLocaleString()} tok` : '';
  const dur = m.endedAt && m.ts ? `${((m.endedAt - m.ts) / 1000).toFixed(1)}s` : '';
  const model = m.runtime?.model || '';
  return `<div class="msg agent">${avatar(a, '', false)}<div class="body">
    <div class="msg-head"><b style="color:${esc(a?.color || 'inherit')}">${esc(a?.name || m.agent)}</b><span>${time(m.ts)}</span>
      ${m.status !== 'completed' ? `<span class="status ${esc(m.status)}">${active ? '<span class="spinner"></span>' : ''}${esc(RUN_LABEL[m.status] || m.status)}</span>` : ''}</div>
    ${stepsHtml(m)}
    ${m.text ? `<div class="bubble md">${md(m.text)}</div>` : active && m.status !== 'waiting' ? `<div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div>` : ''}
    ${approvalHtml(m)}
    ${m.error ? `<div class="err">${esc(m.error)}</div>` : ''}
    <div class="msg-foot">${[model, tokens, dur].filter(Boolean).map(esc).join(' · ')}
      ${active ? `<button class="btn" data-stop="${esc(m.id)}">■ Stop</button>` : ''}
      ${!active && m.text ? `<button class="btn" data-copy="${esc(m.id)}">Copy</button>` : ''}</div>
  </div></div>`;
}
const SETUP_HTML = `<div class="help" style="text-align:left;margin-top:14px">
  1. Create profiles: <code>hermes profile create &lt;name&gt;</code><br>
  2. Turn on their API servers: <code>./enable-api.sh</code><br>
  3. Restart each gateway: <code>hermes -p &lt;name&gt; gateway</code><br>
  4. Click <b>↻ Check agents</b>. New profiles show up on their own.</div>`;
function emptyHtml(t) {
  if (t.kind === 'squad') {
    if (!S.agents.length) {
      return `<div class="empty"><div class="big">🪽</div><h2>No agents found yet</h2>
        <div>Hermes Gateway lists every Hermes profile on this machine, or the agents in <code>squad.json</code>.</div>${SETUP_HTML}</div>`;
    }
    const first = S.agents[0];
    return `<div class="empty"><div class="big">🪽</div><h2>Talk to the whole squad</h2>
      <div>Everything you send here goes to ${S.agents.map((a) => `${a.emoji} ${esc(a.name)}`).join(', ')} at once, and each answers in this channel. Use @mentions to pick agents.</div>
      <div class="chips">
        <button class="chip" data-suggest="Hi team! Give me a one-line status update from each of you.">👋 Status from everyone</button>
        <button class="chip" data-suggest="What is each of you working on right now, and is anything blocked?">🧭 What's everyone working on?</button>
        <button class="chip" data-suggest="@${esc(first.id)} introduce yourself and say what you can help with.">${esc(first.emoji)} @${esc(first.id)} introduce yourself</button>
      </div></div>`;
  }
  const a = agent(t.agent);
  return `<div class="empty"><div class="big">${esc(a?.emoji || '🤖')}</div><h2>${esc(a?.name || t.agent)}</h2><div>${esc(a?.role || '')}</div>
    <div class="help" style="margin-top:8px">Direct messages use this agent's own Hermes session.</div></div>`;
}

function nearBottom() { const el = $('#messages'); return el.scrollHeight - el.scrollTop - el.clientHeight < 120; }
function scrollBottom(force) { const el = $('#messages'); if (force || nearBottom()) el.scrollTop = el.scrollHeight; }
function rememberOpen() {
  S.openSteps = new Set([...document.querySelectorAll('.steps[open]')].map((d) => d.dataset.key));
}
function renderMessages() {
  const t = thread();
  const el = $('#messages');
  S.rendered.clear();
  if (!t || !t.messages.length) { el.innerHTML = t ? emptyHtml(t) : ''; return; }
  el.innerHTML = t.messages.map((m) => `<div data-id="${esc(m.id)}">${msgHtml(m, t)}</div>`).join('');
  for (const node of el.children) S.rendered.set(node.dataset.id, node);
  scrollBottom(true);
}
function upsertMessage(m) {
  const t = thread();
  const stick = nearBottom();
  let node = S.rendered.get(m.id);
  rememberOpen();
  if (node) node.innerHTML = msgHtml(m, t);
  else {
    if (!S.rendered.size) $('#messages').innerHTML = '';
    node = document.createElement('div');
    node.dataset.id = m.id; node.innerHTML = msgHtml(m, t);
    $('#messages').appendChild(node); S.rendered.set(m.id, node);
  }
  if (stick) scrollBottom(true);
}

// ---------- composer ----------
function renderTargets() {
  const t = thread();
  const box = $('#targets');
  if (!t || t.kind !== 'squad') { box.innerHTML = ''; updateHint(); return; }
  const mentioned = mentionsIn($('#input').value);
  const forced = mentioned.length > 0;
  const sel = forced ? new Set(mentioned) : S.targets;
  const all = !forced && (S.targets.size === 0);
  box.innerHTML = `<button type="button" class="tgt all ${all ? 'on' : ''}" data-target="*">Everyone</button>` +
    S.agents.map((a) => `<button type="button" class="tgt ${sel.has(a.id) || all ? 'on' : ''} ${forced ? 'forced' : ''}" data-target="${esc(a.id)}">${avatar(a, 'sm', false)}${esc(a.name)}</button>`).join('');
  updateHint();
}
function mentionsIn(text) {
  const ids = new Set();
  for (const m of text.matchAll(/(^|[\s(,])@([\p{L}0-9_-]+)/gu)) {
    const tag = m[2].toLowerCase();
    if (['all', 'everyone', 'squad', 'channel'].includes(tag)) return S.agents.map((a) => a.id);
    const a = S.agents.find((x) => x.id.toLowerCase() === tag || x.name.toLowerCase() === tag);
    if (a) ids.add(a.id);
  }
  return [...ids];
}
function currentTargets() {
  const t = thread();
  if (t.kind === 'dm') return [t.agent];
  const m = mentionsIn($('#input').value);
  if (m.length) return m;
  return S.targets.size ? [...S.targets] : S.agents.map((a) => a.id);
}
function updateHint() {
  const t = thread();
  if (!t) return;
  const ids = currentTargets();
  const offline = ids.filter((id) => agent(id)?.health?.status !== 'online');
  $('#hint').innerHTML = t.kind === 'squad'
    ? `Sends to <b>${ids.length === S.agents.length ? 'everyone' : esc(ids.join(', '))}</b>${offline.length ? ` · <span style="color:var(--warn)">${esc(offline.join(', '))} not online</span>` : ''} · Enter to send, Shift+Enter for a new line`
    : `${offline.length ? '<span style="color:var(--warn)">Agent is not online — the message will fail until it is. </span>' : ''}Enter to send, Shift+Enter for a new line · /new starts a fresh session`;
}
function autosize() { const ta = $('#input'); ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'; }

async function send() {
  const ta = $('#input');
  const text = ta.value.trim();
  if (!text) return;
  const t = thread();
  if (text === '/new' || text === '/reset') { ta.value = ''; autosize(); return resetThread(false); }
  if (text === '/clear') { ta.value = ''; autosize(); return resetThread(true); }
  $('#sendBtn').disabled = true;
  try {
    await api(`/api/threads/${encodeURIComponent(t.id)}/messages`, { text, targets: t.kind === 'squad' ? currentTargets() : undefined });
    ta.value = ''; autosize(); store.set(`draft.${t.id}`, '');
    renderTargets();
  } catch (e) { toast(`Could not send: ${e.message}`); }
  finally { $('#sendBtn').disabled = false; ta.focus(); }
}
async function resetThread(clear, agentId) {
  const t = thread();
  if (clear && !confirm('Clear this transcript and start fresh Hermes sessions?')) return;
  try { await api(`/api/threads/${encodeURIComponent(t.id)}/reset`, { clear, agent: agentId }); } catch (e) { toast(e.message); }
}

// mention autocomplete
function mentionQuery() {
  const ta = $('#input');
  const upto = ta.value.slice(0, ta.selectionStart);
  const m = upto.match(/(^|\s)@([\p{L}0-9_-]*)$/u);
  return m ? { q: m[2].toLowerCase(), start: upto.length - m[2].length - 1 } : null;
}
function renderMentionPop() {
  const pop = $('#mentionPop');
  const t = thread();
  const mq = t?.kind === 'squad' ? mentionQuery() : null;
  if (!mq) { pop.hidden = true; S.mention = null; return; }
  const opts = [{ id: 'all', name: 'everyone', role: 'all agents', emoji: '🪽', color: '#8b7bff' }, ...S.agents]
    .filter((a) => a.id.toLowerCase().startsWith(mq.q) || a.name.toLowerCase().startsWith(mq.q));
  if (!opts.length) { pop.hidden = true; S.mention = null; return; }
  S.mention = { ...mq, opts, sel: Math.min(S.mention?.sel || 0, opts.length - 1) };
  pop.innerHTML = opts.map((a, i) => `<div class="row ${i === S.mention.sel ? 'sel' : ''}" data-mention="${esc(a.id)}">${avatar(a, 'sm', false)}<div class="meta"><div class="name">@${esc(a.id)}</div><div class="preview">${esc(a.role)}</div></div></div>`).join('');
  pop.hidden = false;
}
function applyMention(id) {
  const ta = $('#input');
  const { start } = S.mention;
  const before = ta.value.slice(0, start);
  const after = ta.value.slice(ta.selectionStart);
  ta.value = `${before}@${id} ${after.replace(/^\S*/, '').replace(/^\s/, '')}`;
  const pos = before.length + id.length + 2;
  ta.setSelectionRange(pos, pos);
  $('#mentionPop').hidden = true; S.mention = null;
  renderTargets(); ta.focus();
}

// ---------- navigation ----------
function openThread(id) {
  if (!S.threads[id]) id = 'squad';
  const prev = thread();
  if (prev) store.set(`draft.${prev.id}`, $('#input').value);
  S.active = id; store.set('active', id);
  S.unread[id] = 0; store.set('unread', S.unread);
  $('#input').value = store.get(`draft.${id}`, '') || ''; autosize();
  $('#app').classList.remove('show-side');
  renderAll();
  if (window.innerWidth > 760) $('#input').focus();
}
function renderAll() { renderSidebar(); renderHeader(); renderMessages(); renderTargets(); renderDetails(); }

// ---------- live connection ----------
function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('snapshot', (e) => {
    const d = JSON.parse(e.data);
    S.agents = d.agents; S.threads = d.threads; S.mock = d.mock; S.connected = true;
    $('#logoutBtn').hidden = !d.auth;
    if (!S.threads[S.active]) S.active = 'squad';
    renderAll();
  });
  es.addEventListener('agents', (e) => {
    S.agents = JSON.parse(e.data);
    renderSidebar(); renderHeader(); renderDetails(); updateHint();
  });
  es.addEventListener('thread', (e) => {
    const t = JSON.parse(e.data);
    S.threads[t.id] = t;
    if (t.id === S.active) renderMessages();
    renderSidebar();
  });
  es.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    const tid = m.thread;
    const t = S.threads[tid];
    if (!t) return;
    const idx = t.messages.findIndex((x) => x.id === m.id);
    const isNew = idx < 0;
    const prevStatus = isNew ? null : t.messages[idx].status;
    if (isNew) t.messages.push(m); else t.messages[idx] = m;
    if (tid === S.active) upsertMessage(m);
    const finished = m.role === 'agent' && (m.status === 'completed' || m.status === 'failed') && prevStatus !== m.status;
    if (finished && (tid !== S.active || document.hidden)) { S.unread[tid] = (S.unread[tid] || 0) + 1; store.set('unread', S.unread); }
    renderSidebar();
    if (tid === S.active && m.role === 'agent' && (isNew || finished)) renderDetails();
  });
  es.onerror = () => {
    S.connected = false; renderSidebar();
    fetch('/api/whoami').then((r) => { if (r.status === 401) location.href = '/login'; }).catch(() => {});
  };
  es.onopen = () => { S.connected = true; };
}

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-thread],[data-target],[data-approve],[data-stop],[data-copy],[data-mention],[data-suggest],[data-dm],[data-reset-agent]');
  if (!el) return;
  const d = el.dataset;
  if (d.thread) return openThread(d.thread);
  if (d.dm) return openThread(`dm:${d.dm}`);
  if (d.resetAgent) return resetThread(false, d.resetAgent);
  if (d.mention) return applyMention(d.mention);
  if (d.suggest) { $('#input').value = d.suggest; autosize(); renderTargets(); return $('#input').focus(); }
  if (d.target) {
    if (mentionsIn($('#input').value).length) return toast('Remove the @mentions in your message to pick targets with the chips.');
    if (d.target === '*') S.targets.clear();
    else if (S.targets.has(d.target)) S.targets.delete(d.target);
    else S.targets.add(d.target);
    if (S.targets.size === S.agents.length) S.targets.clear();
    return renderTargets();
  }
  if (d.approve) {
    el.closest('.btns')?.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try { await api(`/api/messages/${encodeURIComponent(d.mid)}/approval`, { choice: d.approve }); }
    catch (err) { toast(`Approval failed: ${err.message}`); el.closest('.btns')?.querySelectorAll('button').forEach((b) => { b.disabled = false; }); }
    return;
  }
  if (d.stop) { el.disabled = true; try { await api(`/api/messages/${encodeURIComponent(d.stop)}/stop`); } catch (err) { toast(`Stop failed: ${err.message}`); } return; }
  if (d.copy) {
    const m = thread()?.messages.find((x) => x.id === d.copy);
    try { await navigator.clipboard.writeText(m?.text || ''); el.textContent = 'Copied'; setTimeout(() => { el.textContent = 'Copy'; }, 1200); } catch { /* clipboard blocked */ }
  }
});
document.addEventListener('toggle', (e) => { if (e.target.matches?.('.steps')) rememberOpen(); }, true);

$('#composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });
$('#input').addEventListener('input', () => { autosize(); renderTargets(); renderMentionPop(); });
$('#input').addEventListener('click', renderMentionPop);
$('#input').addEventListener('keydown', (e) => {
  if (S.mention && !$('#mentionPop').hidden) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); S.mention.sel = (S.mention.sel + (e.key === 'ArrowDown' ? 1 : -1) + S.mention.opts.length) % S.mention.opts.length; return renderMentionPop(); }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return applyMention(S.mention.opts[S.mention.sel].id); }
    if (e.key === 'Escape') { $('#mentionPop').hidden = true; S.mention = null; return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
$('#newSessionBtn').addEventListener('click', () => resetThread(false));
$('#clearBtn').addEventListener('click', () => resetThread(true));
$('#refreshBtn').addEventListener('click', async (e) => { e.target.disabled = true; try { await api('/api/agents/refresh'); } finally { e.target.disabled = false; } });
$('#themeBtn').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : !matchMedia('(prefers-color-scheme: light)').matches;
  root.dataset.theme = dark ? 'light' : 'dark'; store.set('theme', root.dataset.theme);
});
$('#detailsBtn').addEventListener('click', () => {
  const app = $('#app');
  if (window.innerWidth <= 1100) app.classList.toggle('show-details');
  else { app.classList.toggle('no-details'); store.set('details', !app.classList.contains('no-details')); }
});
$('#menuBtn').addEventListener('click', () => $('#app').classList.add('show-side'));
$('#scrim').addEventListener('click', () => $('#app').classList.remove('show-side', 'show-details'));
document.addEventListener('visibilitychange', () => { if (!document.hidden) { S.unread[S.active] = 0; store.set('unread', S.unread); renderSidebar(); } });

if (!store.get('theme', null) && matchMedia('(prefers-color-scheme: light)').matches) document.documentElement.dataset.theme = 'light';
connect();
