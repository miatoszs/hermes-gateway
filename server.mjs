#!/usr/bin/env node
// Hermes Gateway — one dashboard to message every agent in a Hermes squad.
// Talks to each Hermes profile's API server (/v1/runs + SSE events), keeps API keys
// server-side, persists transcripts, and streams one event bus to the browser.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ARGS = process.argv.slice(2);
const MOCK = ARGS.includes('--mock') || process.env.HERMES_MOCK === '1';

// ---------- config ----------
function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}
const readEnvFile = (p) => { try { return parseEnv(fs.readFileSync(p, 'utf8')); } catch { return {}; } };
const localEnv = readEnvFile(path.join(ROOT, '.env'));
const env = (k) => process.env[k] ?? localEnv[k];

// squad.json is optional: without it every Hermes profile under HERMES_HOME is discovered.
const CONFIG_PATH = path.resolve(ROOT, env('SQUAD_CONFIG') || 'squad.json');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) {
  if (e.code !== 'ENOENT') { console.error(`Could not read ${CONFIG_PATH}: ${e.message}`); process.exit(1); }
}
const HERMES_HOME = env('HERMES_HOME') || path.join(os.homedir(), '.hermes');
const HOST = env('DASH_HOST') || cfg.dashboard?.host || '127.0.0.1';
const PORT = Number(env('DASH_PORT') || cfg.dashboard?.port || 8790);
const USER_LABEL = env('DASH_USER_NAME') || cfg.dashboard?.userName || 'the user';
const DISCOVER = String(env('HERMES_DISCOVER') ?? cfg.discover ?? 'true') !== 'false';

// ---------- agent discovery ----------
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function yamlTop(text, key) {
  const m = text.match(new RegExp(`^${reEsc(key)}:[ \\t]*(.*)$`, 'm'));
  if (!m) return '';
  const v = m[1].replace(/\s+#.*$/, '');
  if (!/^[|>]/.test(v)) return unquote(v);
  const lines = [];
  for (const l of text.slice(m.index + m[0].length + 1).split('\n')) { if (/^\s+\S/.test(l) || l === '') lines.push(l.trim()); else break; }
  return lines.join(' ').trim();
}
function yamlChild(text, parent, keys) {
  const m = text.match(new RegExp(`^${reEsc(parent)}:[ \\t]*\\n((?:[ \\t]+.*\\n?|[ \\t]*\\n)*)`, 'm'));
  if (!m) return '';
  for (const k of keys) {
    const c = m[1].match(new RegExp(`^[ \\t]+${reEsc(k)}:[ \\t]*(.+)$`, 'm'));
    if (c) return unquote(c[1].replace(/\s+#.*$/, ''));
  }
  return '';
}
const PALETTE = ['#8b7bff', '#22c55e', '#f59e0b', '#3b82f6', '#ef4444', '#14b8a6', '#ec4899', '#a855f7', '#84cc16', '#06b6d4'];
const EMOJIS = ['🤖', '🧠', '🛰️', '🦉', '🧭', '⚙️', '📡', '🔭', '🧩', '🪐'];
const hashOf = (s) => [...String(s)].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);
const titleCase = (s) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const profileDir = (p) => (p === 'default' ? HERMES_HOME : path.join(HERMES_HOME, 'profiles', p));

// Name/role/model come from the profile itself: profile.yaml (display_name, description),
// the first "# Name – Role" heading of SOUL.md, and model.default in config.yaml.
function describeProfile(profile) {
  const dir = profileDir(profile);
  const meta = readText(path.join(dir, 'profile.yaml'));
  const conf = readText(path.join(dir, 'config.yaml'));
  const h1 = (readText(path.join(dir, 'SOUL.md')).match(/^#\s+(.+)$/m) || [])[1] || '';
  let [soulName, soulRole] = h1.split(/\s+[–—-]\s+|:\s+/).map((s) => s?.trim());
  if (!soulName || soulName.length > 40) soulName = soulRole = undefined;
  const description = yamlTop(meta, 'description');
  return {
    id: profile, profile,
    name: yamlTop(meta, 'display_name') || soulName || titleCase(profile),
    role: soulRole || description.split(/(?<=[.!?])\s/)[0].slice(0, 90),
    model: yamlTop(conf, 'model') || yamlChild(conf, 'model', ['default', 'model']) || null,
    apiEnabled: truthy(readEnvFile(path.join(dir, '.env')).API_SERVER_ENABLED),
  };
}
function discoverProfiles() {
  if (!DISCOVER) return [];
  let names = [];
  try {
    names = fs.readdirSync(path.join(HERMES_HOME, 'profiles'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort();
  } catch { /* no profiles dir */ }
  if (truthy(readEnvFile(path.join(HERMES_HOME, '.env')).API_SERVER_ENABLED)) names.unshift('default');
  const exclude = new Set(cfg.exclude || []);
  return names.filter((n) => !exclude.has(n)).map(describeProfile);
}
const DEMO_SQUAD = [
  { id: 'coordinator', role: 'Plans the work and hands out tasks' },
  { id: 'researcher', role: 'Finds and checks facts' },
  { id: 'writer', role: 'Drafts and edits content' },
  { id: 'engineer', role: 'Builds, runs and fixes things' },
];
function agentSpecs() {
  const explicit = Array.isArray(cfg.agents) ? cfg.agents : [];
  const found = new Map(discoverProfiles().map((d) => [d.id, d]));
  const out = explicit.map((a) => {
    const base = found.get(a.profile || a.id) || (a.profile ? describeProfile(a.profile) : {});
    found.delete(a.profile || a.id);
    return { ...base, ...a };
  });
  out.push(...found.values());
  return MOCK && !out.length ? DEMO_SQUAD : out;
}

function resolveAgent(a) {
  const prof = a.profile ? readEnvFile(path.join(profileDir(a.profile), '.env')) : {};
  let baseUrl = a.baseUrl;
  if (!baseUrl && a.profile && (prof.API_SERVER_PORT || truthy(prof.API_SERVER_ENABLED))) {
    const h = !prof.API_SERVER_HOST || prof.API_SERVER_HOST === '0.0.0.0' ? '127.0.0.1' : prof.API_SERVER_HOST;
    baseUrl = `http://${h}:${prof.API_SERVER_PORT || 8642}`;
  }
  const autoEnv = `HERMES_KEY_${a.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  let key = '', keySource = 'none';
  if (a.key) { key = a.key; keySource = 'squad.json'; }
  else if (a.keyEnv && env(a.keyEnv)) { key = env(a.keyEnv); keySource = a.keyEnv; }
  else if (env(autoEnv)) { key = env(autoEnv); keySource = autoEnv; }
  else if (prof.API_SERVER_KEY) { key = prof.API_SERVER_KEY; keySource = 'profile .env'; }
  const h = hashOf(a.id);
  return {
    id: a.id, name: a.name || titleCase(a.id), role: a.role || '', emoji: a.emoji || EMOJIS[h % EMOJIS.length],
    color: a.color || PALETTE[h % PALETTE.length], profile: a.profile || null, model: a.model || null,
    apiEnabled: a.apiEnabled ?? true, baseUrl: (baseUrl || '').replace(/\/+$/, ''), key, keySource,
    health: { status: 'unknown', model: a.model || null, checkedAt: 0, error: null },
  };
}

const agents = [];
const agentById = new Map();
// (Re)load the roster: picks up profiles created or API-enabled while the dashboard runs.
function syncAgents(initial = false) {
  const fresh = agentSpecs().map(resolveAgent);
  const ids = new Set(fresh.map((a) => a.id));
  let changed = false;
  for (const a of fresh) {
    const cur = agentById.get(a.id);
    if (cur) {
      // mock mode keeps its fake endpoints/keys but still follows name/role/model edits
      const { health, ...rest } = a;
      const keys = MOCK ? ['name', 'role', 'model'] : Object.keys(rest);
      if (keys.some((k) => JSON.stringify(cur[k]) !== JSON.stringify(rest[k]))) changed = true;
      for (const k of keys) cur[k] = rest[k];
      continue;
    }
    agents.push(a); agentById.set(a.id, a); changed = true;
    const t = ensureThread(`dm:${a.id}`, 'dm', a.id);
    if (!initial) broadcast('thread', t);
  }
  for (let i = agents.length - 1; i >= 0; i--) {
    if (!ids.has(agents[i].id)) { agentById.delete(agents[i].id); agents.splice(i, 1); changed = true; }
  }
  if (changed && !initial) pushAgents();
}

const publicAgent = (a) => ({
  id: a.id, name: a.name, role: a.role, emoji: a.emoji, color: a.color, profile: a.profile,
  baseUrl: a.baseUrl, hasKey: Boolean(a.key), keySource: a.keySource, health: a.health, apiEnabled: a.apiEnabled,
  running: [...messagesRunning()].filter((m) => m.agent === a.id).length,
  avatar: avatarUrl(a), soulEditable: Boolean(soulPathOf(a)),
});

// ---------- state ----------
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
const MAX_MESSAGES = 600;
const uid = (p) => `${p}_${crypto.randomBytes(6).toString('hex')}`;

let state = { threads: {}, sessions: {}, seen: {} };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch { /* fresh start */ }

function ensureThread(id, kind, agent) {
  if (!state.threads[id]) state.threads[id] = { id, kind, agent: agent || null, messages: [] };
  return state.threads[id];
}
ensureThread('squad', 'squad');
syncAgents(true);

if (MOCK) {
  const { startMockSquad } = await import('./mock-hermes.mjs');
  const endpoints = await startMockSquad(agents.map((a) => a.id), Number(env('MOCK_BASE_PORT') || 18643));
  agents.forEach((a, i) => { Object.assign(a, { baseUrl: endpoints[i].baseUrl, key: endpoints[i].key, keySource: 'mock', apiEnabled: true }); });
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE);
  }, 400);
}

function* messagesRunning() {
  for (const t of Object.values(state.threads)) for (const m of t.messages) if (m.role === 'agent' && ACTIVE.has(m.status)) yield m;
}
const ACTIVE = new Set(['queued', 'running', 'waiting', 'stopping']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

function sessionFor(threadId, agentId) {
  const k = `${threadId}|${agentId}`;
  if (!state.sessions[k]) state.sessions[k] = `gw-${threadId.replace(/[^a-z0-9]+/gi, '-')}-${agentId}-${Date.now().toString(36)}`;
  return state.sessions[k];
}

// ---------- event bus ----------
const clients = new Set();
function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(frame);
}
const pending = new Map();
function pushMessage(msg, immediate = false) {
  save();
  if (immediate) { clearTimeout(pending.get(msg.id)); pending.delete(msg.id); broadcast('message', msg); return; }
  if (pending.has(msg.id)) return;
  pending.set(msg.id, setTimeout(() => { pending.delete(msg.id); broadcast('message', msg); }, 60));
}
const pushAgents = () => broadcast('agents', agents.map(publicAgent));

function addMessage(thread, msg) {
  msg.thread = thread.id;
  thread.messages.push(msg);
  if (thread.messages.length > MAX_MESSAGES) thread.messages.splice(0, thread.messages.length - MAX_MESSAGES);
  pushMessage(msg, true);
  return msg;
}

// ---------- hermes client ----------
async function hermes(agent, method, p, body, extraHeaders = {}) {
  const res = await fetch(agent.baseUrl + p, {
    method,
    headers: { Authorization: `Bearer ${agent.key}`, 'Content-Type': 'application/json', ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) {
    const err = new Error(json?.error?.message || json?.message || text.slice(0, 300) || `HTTP ${res.status}`);
    err.status = res.status; err.code = json?.error?.code;
    throw err;
  }
  return json;
}

async function checkHealth(agent) {
  const h = agent.health;
  if (!agent.baseUrl) {
    Object.assign(h, agent.apiEnabled === false
      ? { status: 'disabled', error: 'API server is off for this profile (API_SERVER_ENABLED)' }
      : { status: 'unconfigured', error: 'No baseUrl / API_SERVER_PORT' });
    h.checkedAt = Date.now(); return;
  }
  try {
    const r = await fetch(agent.baseUrl + '/health', { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(`health HTTP ${r.status}`);
    if (!agent.key) { Object.assign(h, { status: 'nokey', error: 'No API_SERVER_KEY configured' }); return; }
    try {
      const models = await hermes(agent, 'GET', '/v1/models');
      // /v1/models advertises the profile name, not the LLM; keep the configured/served model unless it says more.
      const id = models?.data?.[0]?.id;
      Object.assign(h, { status: 'online', model: id && id !== agent.profile && id !== agent.id && id !== 'hermes-agent' ? id : h.model, error: null });
    } catch (e) {
      Object.assign(h, { status: e.status === 401 || e.status === 403 ? 'auth' : 'online', error: e.status === 401 || e.status === 403 ? 'API key rejected' : null });
    }
  } catch (e) {
    Object.assign(h, { status: 'offline', error: e.cause?.code || e.message });
  } finally { h.checkedAt = Date.now(); }
}
async function healthLoop() {
  const before = JSON.stringify(agents.map((a) => a.health.status + a.health.model));
  await Promise.all(agents.map(checkHealth));
  if (JSON.stringify(agents.map((a) => a.health.status + a.health.model)) !== before) pushAgents();
}

// ---------- squad prompt building ----------
const clip = (s, n) => (s.length > n ? s.slice(0, n) + ' …' : s);
function buildInput(thread, agent, userMsg) {
  if (thread.kind !== 'squad') return userMsg.text;
  const seenKey = `${thread.id}|${agent.id}`;
  const lastSeen = state.seen[seenKey];
  const msgs = thread.messages;
  const start = lastSeen ? msgs.findIndex((m) => m.id === lastSeen) + 1 : 0;
  const unseen = msgs.slice(Math.max(0, start), msgs.indexOf(userMsg)).filter((m) =>
    (m.role === 'user') || (m.role === 'agent' && m.agent !== agent.id && m.status === 'completed' && m.text));
  state.seen[seenKey] = userMsg.id;
  const mates = agents.filter((a) => a.id !== agent.id).map((a) => (a.role ? `${a.id} (${a.role})` : a.id)).join(', ');
  const lines = [`[Group channel "#squad" in the Hermes Gateway dashboard. You are "${agent.id}"${agent.role ? ` (${agent.role})` : ''}. Other agents in this channel: ${mates || 'none'}. Messages are written by ${USER_LABEL}.]`];
  const recent = unseen.slice(-20);
  if (recent.length) {
    lines.push('', 'Channel messages since your last turn (context only):');
    for (const m of recent) lines.push(`- ${m.role === 'user' ? USER_LABEL : m.agent}: ${clip(m.text.replace(/\s+/g, ' '), 1200)}`);
  }
  const to = userMsg.targets?.length === agents.length ? 'everyone' : (userMsg.targets || []).join(', ');
  lines.push('', `New message from ${USER_LABEL} (addressed to: ${to}):`, userMsg.text);
  return lines.join('\n');
}

function parseTargets(text) {
  const ids = new Set();
  for (const m of text.matchAll(/(^|[\s(,])@([\p{L}0-9_-]+)/gu)) {
    const tag = m[2].toLowerCase();
    if (['all', 'everyone', 'squad', 'channel'].includes(tag)) return agents.map((a) => a.id);
    const a = agents.find((x) => x.id.toLowerCase() === tag || x.name.toLowerCase() === tag);
    if (a) ids.add(a.id);
  }
  return [...ids];
}

// ---------- runs ----------
// Agents that share one LLM backend (same `model` in squad.json) take turns, because hosted
// backends often cap parallel requests. dashboard.maxParallelPerModel: 0 = unlimited.
const PER_MODEL = Number(cfg.dashboard?.maxParallelPerModel ?? 1);
const slots = new Map();
const releases = new Map();
const inputs = new Map();
function acquire(agent) {
  const g = agent.model || `agent:${agent.id}`;
  const s = slots.get(g) || { active: 0, queue: [] };
  slots.set(g, s);
  const grant = (resolve) => { s.active += 1; let done = false; resolve(() => { if (done) return; done = true; s.active -= 1; s.queue.shift()?.(); }); };
  return new Promise((resolve) => (PER_MODEL <= 0 || s.active < PER_MODEL ? grant(resolve) : s.queue.push(() => grant(resolve))));
}
const RATE_LIMITED = /rate ?limit|max_parallel_requests|too many requests|\b429\b|overloaded|slots in use/i;
const MAX_RETRIES = 4;

function dispatch(thread, agent, userMsg, msg) {
  inputs.set(msg.id, buildInput(thread, agent, userMsg));
  return startRun(agent, msg);
}
async function startRun(agent, msg) {
  if (!agent.baseUrl || !agent.key) {
    Object.assign(msg, { status: 'failed', error: agent.baseUrl ? 'No API key configured for this agent.' : 'Agent has no endpoint configured.' });
    return pushMessage(msg, true);
  }
  if (msg.status === 'cancelled') return;
  const release = await acquire(agent);
  releases.set(msg.id, release);
  if (msg.status === 'cancelled') return settle(agent, msg);
  try {
    const run = await hermes(agent, 'POST', '/v1/runs',
      { input: inputs.get(msg.id), session_id: msg.sessionId },
      { 'Idempotency-Key': `hgw-${msg.id}-${msg.retries || 0}` });
    msg.runId = run.run_id || run.id;
    msg.seq = null;
    msg.status = run.status === 'queued' ? 'queued' : 'running';
    pushMessage(msg, true);
    attachRun(agent, msg);
  } catch (e) {
    Object.assign(msg, { status: 'failed', error: `Could not start run: ${e.message}`, endedAt: Date.now() });
    settle(agent, msg);
  }
}
// Called once a run reaches a terminal state: free the model slot, retry if the backend was just busy.
function settle(agent, msg) {
  releases.get(msg.id)?.(); releases.delete(msg.id);
  if (msg.status === 'failed' && RATE_LIMITED.test(msg.error || '') && (msg.retries || 0) < MAX_RETRIES && inputs.has(msg.id)) {
    msg.retries = (msg.retries || 0) + 1;
    const wait = 5000 * 2 ** (msg.retries - 1);
    (msg.steps ||= []).push({ kind: 'note', text: `Model was busy — retrying in ${wait / 1000}s (attempt ${msg.retries + 1}/${MAX_RETRIES + 1})`, ts: Date.now() });
    Object.assign(msg, { status: 'queued', error: null, text: '', endedAt: null, runId: null });
    pushMessage(msg, true);
    setTimeout(() => startRun(agent, msg), wait);
    return;
  }
  if (TERMINAL.has(msg.status)) inputs.delete(msg.id);
  pushMessage(msg, true);
  pushAgents();
}

function applyEvent(msg, ev) {
  if (typeof ev.seq === 'number') { if (msg.seq != null && ev.seq <= msg.seq) return; msg.seq = ev.seq; }
  const t = ev.event;
  const steps = (msg.steps ||= []);
  switch (t) {
    case 'run.queued': msg.status = 'queued'; break;
    case 'message.delta':
      msg.status = msg.status === 'queued' ? 'running' : msg.status;
      msg.text = (msg.text || '') + (ev.delta || ''); break;
    case 'message.interim':
      if (!ev.already_streamed && ev.text) steps.push({ kind: 'note', text: ev.text, ts: Date.now() }); break;
    case 'reasoning.available': if (ev.text) msg.reasoning = ev.text; break;
    case 'tool.started':
      if (msg.status === 'queued') msg.status = 'running';
      steps.push({ kind: 'tool', id: ev.tool_call_id || uid('t'), tool: ev.tool, preview: ev.preview || '', status: 'running', ts: Date.now() });
      break;
    case 'tool.completed': {
      const s = [...steps].reverse().find((x) => x.kind === 'tool' && x.status === 'running' &&
        (ev.tool_call_id ? x.id === ev.tool_call_id : x.tool === ev.tool));
      if (s) Object.assign(s, { status: ev.error ? 'error' : 'done', duration: ev.duration, result: ev.preview || '' });
      break;
    }
    case 'subagent.start': steps.push({ kind: 'note', text: `Delegated to a subagent${ev.goal ? `: ${clip(String(ev.goal), 200)}` : ''}`, ts: Date.now() }); break;
    case 'subagent.complete': steps.push({ kind: 'note', text: `Subagent ${ev.status || 'finished'}${ev.summary ? `: ${clip(String(ev.summary), 300)}` : ''}`, ts: Date.now() }); break;
    case 'approval.request':
      msg.status = 'waiting';
      msg.approval = {
        requestId: ev.request_id || ev.prompt_id || null, generation: ev.execution_generation ?? null,
        command: ev.command || '', description: ev.description || '', choices: ev.choices || ['once', 'deny'], resolved: null,
      };
      break;
    case 'approval.responded':
      if (msg.approval) msg.approval.resolved = ev.choice || 'answered';
      if (msg.status === 'waiting') msg.status = 'running';
      break;
    case 'run.stopping': msg.status = 'stopping'; break;
    case 'run.completed':
      msg.status = 'completed';
      if (typeof ev.output === 'string' && ev.output.trim()) msg.text = ev.output;
      msg.usage = ev.usage || null; msg.runtime = ev.runtime || null; msg.endedAt = Date.now();
      break;
    case 'run.failed': case 'run.cancelled': case 'run.interrupted':
      msg.status = t.slice(4); msg.error = ev.error || msg.error || null; msg.endedAt = Date.now();
      if (ev.output) msg.text = ev.output;
      break;
    default: break;
  }
}

async function attachRun(agent, msg, attempt = 0) {
  const url = new URL(`${agent.baseUrl}/v1/runs/${encodeURIComponent(msg.runId)}/events`);
  if (msg.seq != null) url.searchParams.set('last_seq', String(msg.seq));
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${agent.key}`, Accept: 'text/event-stream' } });
    if (res.status === 404) return finalizeFromStatus(agent, msg, true);
    if (!res.ok || !res.body) throw new Error(`events HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
        const data = frame.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        let ev; try { ev = JSON.parse(data); } catch { continue; }
        applyEvent(msg, ev);
        if (ev.event === 'run.completed' && ev.runtime?.model && agent.health.model !== ev.runtime.model) { agent.health.model = ev.runtime.model; pushAgents(); }
        pushMessage(msg, TERMINAL.has(msg.status) || ev.event === 'approval.request' || ev.event?.startsWith('tool.'));
      }
    }
  } catch (e) {
    msg.lastStreamError = e.message;
  }
  if (!TERMINAL.has(msg.status)) {
    await finalizeFromStatus(agent, msg, false);
    if (!TERMINAL.has(msg.status) && attempt < 30) setTimeout(() => attachRun(agent, msg, attempt + 1), Math.min(1000 * 2 ** attempt, 15000));
    else if (!TERMINAL.has(msg.status)) { Object.assign(msg, { status: 'interrupted', error: 'Lost the event stream for this run.' }); pushMessage(msg, true); }
  }
  if (TERMINAL.has(msg.status)) settle(agent, msg); else pushAgents();
}

async function finalizeFromStatus(agent, msg, notFound) {
  try {
    const st = await hermes(agent, 'GET', `/v1/runs/${encodeURIComponent(msg.runId)}`);
    if (TERMINAL.has(st.status)) {
      msg.status = st.status;
      if (st.output) msg.text = st.output;
      msg.error = st.error || null; msg.usage = st.usage || msg.usage; msg.runtime = st.runtime || msg.runtime; msg.endedAt ||= Date.now();
    } else if (st.status === 'waiting_for_approval' && !msg.approval && st.approval) {
      applyEvent(msg, { ...st.approval, event: 'approval.request', seq: undefined });
    }
  } catch (e) {
    if (notFound || e.status === 404) Object.assign(msg, { status: 'interrupted', error: 'Hermes no longer knows this run (gateway restarted?).' });
  }
  pushMessage(msg, true);
}

async function respondApproval(agent, msg, choice) {
  const a = msg.approval || {};
  const body = { choice };
  if (a.requestId) body.request_id = a.requestId;
  if (a.generation != null) body.execution_generation = a.generation;
  try {
    return await hermes(agent, 'POST', `/v1/runs/${encodeURIComponent(msg.runId)}/approval`, body);
  } catch (e) {
    if (e.status !== 409 && e.status !== 400) throw e;
    // Canonical gateway owner: needs the exact prompt identity from pending_controls.
    const st = await hermes(agent, 'GET', `/v1/runs/${encodeURIComponent(msg.runId)}`);
    const pcs = Array.isArray(st.pending_controls) ? st.pending_controls : Object.values(st.pending_controls || {});
    const pc = pcs.find((p) => !p.kind || /approv/i.test(p.kind)) || pcs[0];
    if (!pc) throw e;
    return hermes(agent, 'POST', `/v1/runs/${encodeURIComponent(msg.runId)}/approval`,
      { choice, request_id: pc.prompt_id || pc.request_id, execution_generation: pc.execution_generation });
  }
}


// ---------- agent profile pictures (stored by the dashboard in data/avatars, never in Hermes) ----------
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
const AVATAR_MAX_BYTES = 1024 * 1024;
const AVATAR_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const fileId = (id) => String(id).replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^\.+/, '_');
function avatarFile(agent) {
  for (const ext of Object.keys(AVATAR_TYPES)) {
    const f = path.join(AVATAR_DIR, `${fileId(agent.id)}.${ext}`);
    if (fs.existsSync(f)) return { file: f, ext };
  }
  return null;
}
function avatarUrl(agent) {
  const a = avatarFile(agent);
  return a ? `/api/agents/${encodeURIComponent(agent.id)}/avatar?v=${Math.round(fs.statSync(a.file).mtimeMs)}` : null;
}
// Sniff the real format from the bytes; SVG and everything else is refused.
function imageKind(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}
function saveAvatar(agent, dataUrl) {
  const m = /^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
  if (!m) throw Object.assign(new Error('Send the picture as a base64 data URL.'), { status: 400 });
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > AVATAR_MAX_BYTES) throw Object.assign(new Error('Picture is larger than 1 MB.'), { status: 413 });
  const kind = imageKind(buf);
  if (!kind) throw Object.assign(new Error('Only PNG, JPEG or WebP pictures are allowed.'), { status: 415 });
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
  removeAvatar(agent);
  const f = path.join(AVATAR_DIR, `${fileId(agent.id)}.${kind}`);
  fs.writeFileSync(`${f}.tmp`, buf); fs.renameSync(`${f}.tmp`, f);
}
function removeAvatar(agent) {
  for (const ext of Object.keys(AVATAR_TYPES)) fs.rmSync(path.join(AVATAR_DIR, `${fileId(agent.id)}.${ext}`), { force: true });
}

// ---------- SOUL.md editing ----------
// Hermes reads SOUL.md when a session starts; above ~20k chars (the default floor of
// context_file_max_chars) it may cut the middle. Every save keeps the previous text in data/soul-history.
const SOUL_SOFT_LIMIT = 20000;
const SOUL_HARD_LIMIT = 200000;
const SOUL_HISTORY_DIR = path.join(DATA_DIR, 'soul-history');
const SOUL_HISTORY_KEEP = 30;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
function soulPathOf(agent) {
  if (agent?.profile && /^[A-Za-z0-9_.-]+$/.test(agent.profile) && !agent.profile.startsWith('.')) {
    const dir = profileDir(agent.profile);
    return fs.existsSync(dir) ? path.join(dir, 'SOUL.md') : null;
  }
  // demo agents get a scratch SOUL.md so the editor can be tried without Hermes
  return MOCK && !agent?.profile ? path.join(DATA_DIR, 'demo-profiles', fileId(agent.id), 'SOUL.md') : null;
}
function soulHistory(agent) {
  const dir = path.join(SOUL_HISTORY_DIR, fileId(agent.id));
  try {
    return fs.readdirSync(dir).filter((f) => /^\d+\.md$/.test(f)).sort().reverse()
      .map((f) => ({ id: f, ts: Number(f.slice(0, -3)), size: fs.statSync(path.join(dir, f)).size }));
  } catch { return []; }
}
function readSoul(agent) {
  const file = soulPathOf(agent);
  if (!file) return null;
  let content = '', exists = true;
  try { content = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; exists = false; }
  return {
    agent: agent.id, path: file, exists, content, hash: sha256(content), softLimit: SOUL_SOFT_LIMIT,
    distribution: fs.existsSync(path.join(path.dirname(file), 'distribution.yaml')), history: soulHistory(agent),
  };
}
function writeSoul(agent, content) {
  const file = soulPathOf(agent);
  let st = null; try { st = fs.statSync(file); } catch { /* new file */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (st) {
    const hdir = path.join(SOUL_HISTORY_DIR, fileId(agent.id));
    fs.mkdirSync(hdir, { recursive: true, mode: 0o700 });
    fs.copyFileSync(file, path.join(hdir, `${Date.now()}.md`));
    for (const old of soulHistory(agent).slice(SOUL_HISTORY_KEEP)) fs.rmSync(path.join(hdir, old.id), { force: true });
  }
  // atomic replace that keeps the original file's mode and owner
  const tmp = path.join(path.dirname(file), `.SOUL.md.hgw-${crypto.randomBytes(4).toString('hex')}`);
  fs.writeFileSync(tmp, content, { mode: st ? st.mode & 0o777 : 0o644 });
  if (st) { try { fs.chownSync(tmp, st.uid, st.gid); } catch { /* not root: keep our ownership */ } }
  fs.renameSync(tmp, file);
}
function freshSessionsFor(agentId, reason) {
  for (const k of Object.keys(state.sessions)) if (k.endsWith(`|${agentId}`)) delete state.sessions[k];
  for (const k of Object.keys(state.seen)) if (k.endsWith(`|${agentId}`)) delete state.seen[k];
  for (const tid of ['squad', `dm:${agentId}`]) {
    const t = state.threads[tid];
    if (t) addMessage(t, { id: uid('m'), role: 'system', text: `${reason} · new Hermes session for ${agentId}`, ts: Date.now() });
  }
}

// resume runs that were live when the dashboard last stopped
for (const m of messagesRunning()) {
  const a = agentById.get(m.agent);
  if (a && m.runId) attachRun(a, m); else { m.status = 'interrupted'; m.error = 'Dashboard restarted before the run started.'; }
}

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
async function readBody(req, limit = 1e6) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 }); chunks.push(c); }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}
function findMessage(id) {
  for (const t of Object.values(state.threads)) { const m = t.messages.find((x) => x.id === id); if (m) return [t, m]; }
  return [null, null];
}
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`, ...(env('DASH_ALLOWED_HOSTS') || '').split(',').map((s) => s.trim()).filter(Boolean)]);

// ---------- optional password login (set DASH_PASSWORD when the dashboard is reachable from a network) ----------
const PASSWORD = env('DASH_PASSWORD') || '';
const SESSION = PASSWORD ? crypto.createHmac('sha256', PASSWORD).update('hermes-gateway-session-v1').digest('hex') : '';
const failures = new Map();
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((x) => x[0]).map(([k, ...v]) => [k, v.join('=')]));
}
const authed = (req) => !PASSWORD || (cookies(req).hgw_session || '').length === SESSION.length &&
  crypto.timingSafeEqual(Buffer.from(cookies(req).hgw_session), Buffer.from(SESSION));
const loginPage = (error) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hermes Gateway</title>
<style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d12;color:#e7e9ef;font:14px system-ui,sans-serif}
form{background:#10131a;border:1px solid #242a38;border-radius:16px;padding:28px;width:min(340px,calc(100vw - 32px));box-sizing:border-box}h1{font-size:18px;margin:0 0 4px}p{color:#8a92a6;margin:0 0 18px}
input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;border:1px solid #242a38;background:#161a23;color:inherit;font:inherit}button{margin-top:12px;width:100%;padding:10px;border:0;border-radius:10px;background:#8b7bff;color:#fff;font:inherit;font-weight:600;cursor:pointer}.e{color:#ef4444;margin-top:10px}</style></head>
<body><form method="post" action="/login"><h1>🪽 Hermes Gateway</h1><p>Enter the dashboard password.</p><input type="password" name="password" autofocus autocomplete="current-password"><button>Sign in</button>${error ? `<div class="e">${error}</div>` : ''}</form></body></html>`;

const server = http.createServer(async (req, res) => {
  try {
    // DNS-rebinding / CSRF guard: the dashboard holds agent keys, so only same-origin callers on known hosts.
    if (!ALLOWED_HOSTS.has(req.headers.host || '')) return json(res, 403, { error: 'host not allowed (set DASH_ALLOWED_HOSTS)' });
    if (req.method !== 'GET' && req.headers.origin) {
      let ok = false; try { ok = new URL(req.headers.origin).host === req.headers.host; } catch { /* "null" origin */ }
      if (!ok) return json(res, 403, { error: 'cross-origin request refused' });
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    let m;

    if (PASSWORD) {
      if (p === '/login' && req.method === 'POST') {
        const ip = req.socket.remoteAddress;
        const f = failures.get(ip) || { n: 0, until: 0 };
        let raw = ''; for await (const c of req) { raw += c; if (raw.length > 4096) break; }
        const given = Buffer.from(new URLSearchParams(raw).get('password') || '');
        const ok = Date.now() > f.until && given.length === Buffer.byteLength(PASSWORD) && crypto.timingSafeEqual(given, Buffer.from(PASSWORD));
        if (!ok) {
          f.n += 1; if (f.n >= 5) { f.until = Date.now() + 60000; f.n = 0; }
          failures.set(ip, f);
          await new Promise((r) => setTimeout(r, 600));
          res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(loginPage(Date.now() < f.until ? 'Too many attempts — wait a minute.' : 'Wrong password.'));
        }
        failures.delete(ip);
        res.writeHead(303, { Location: '/', 'Set-Cookie': `hgw_session=${SESSION}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` });
        return res.end();
      }
      if (p === '/logout') {
        res.writeHead(303, { Location: '/login', 'Set-Cookie': 'hgw_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
        return res.end();
      }
      if (!authed(req)) {
        if (p.startsWith('/api/')) return json(res, 401, { error: 'sign in required' });
        res.writeHead(p === '/login' ? 200 : 303, { 'Content-Type': 'text/html; charset=utf-8', ...(p === '/login' ? {} : { Location: '/login' }) });
        return res.end(p === '/login' ? loginPage('') : '');
      }
      if (p === '/login') { res.writeHead(303, { Location: '/' }); return res.end(); }
    }

    if (p === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`event: snapshot\ndata: ${JSON.stringify({ agents: agents.map(publicAgent), threads: state.threads, mock: MOCK, auth: Boolean(PASSWORD) })}\n\n`);
      clients.add(res);
      const ka = setInterval(() => res.write(': keepalive\n\n'), 15000);
      req.on('close', () => { clearInterval(ka); clients.delete(res); });
      return;
    }
    if (p === '/api/whoami') return json(res, 200, { ok: true });
    if (p === '/api/agents/refresh' && req.method === 'POST') { syncAgents(); await healthLoop(); pushAgents(); return json(res, 200, { ok: true }); }

    if ((m = p.match(/^\/api\/agents\/([^/]+)\/(avatar|soul|soul\/history\/(\d+\.md))$/))) {
      const agent = agentById.get(decodeURIComponent(m[1]));
      if (!agent) return json(res, 404, { error: 'unknown agent' });
      if (m[2] === 'avatar') {
        if (req.method === 'GET') {
          const a = avatarFile(agent);
          if (!a) return json(res, 404, { error: 'no picture' });
          res.writeHead(200, { 'Content-Type': AVATAR_TYPES[a.ext], 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
          return fs.createReadStream(a.file).pipe(res);
        }
        if (req.method === 'PUT') { saveAvatar(agent, (await readBody(req, 2e6)).dataUrl); pushAgents(); return json(res, 200, { avatar: avatarUrl(agent) }); }
        if (req.method === 'DELETE') { removeAvatar(agent); pushAgents(); return json(res, 200, { avatar: null }); }
      }
      if (!soulPathOf(agent)) return json(res, 400, { error: 'This agent has no local Hermes profile, so its SOUL.md can only be edited on its own machine.' });
      if (m[3] && req.method === 'GET') {
        const f = path.join(SOUL_HISTORY_DIR, fileId(agent.id), m[3]);
        try { return json(res, 200, { id: m[3], content: fs.readFileSync(f, 'utf8') }); } catch { return json(res, 404, { error: 'no such version' }); }
      }
      if (m[2] === 'soul' && req.method === 'GET') return json(res, 200, readSoul(agent));
      if (m[2] === 'soul' && req.method === 'PUT') {
        const body = await readBody(req);
        if (typeof body.content !== 'string') return json(res, 400, { error: 'content must be a string' });
        if (body.content.length > SOUL_HARD_LIMIT) return json(res, 413, { error: `SOUL.md is limited to ${SOUL_HARD_LIMIT} characters here.` });
        const cur = readSoul(agent);
        if (body.baseHash !== cur.hash) return json(res, 409, { error: 'SOUL.md changed on disk since you opened it.', current: cur });
        if (body.content !== cur.content) {
          writeSoul(agent, body.content);
          if (body.freshSession !== false) freshSessionsFor(agent.id, 'SOUL.md updated');
          syncAgents();
          pushAgents();
        }
        return json(res, 200, readSoul(agent));
      }
      return json(res, 405, { error: 'method not allowed' });
    }

    if ((m = p.match(/^\/api\/threads\/([^/]+)\/messages$/)) && req.method === 'POST') {
      const thread = state.threads[decodeURIComponent(m[1])];
      if (!thread) return json(res, 404, { error: 'unknown thread' });
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      if (!text) return json(res, 400, { error: 'empty message' });
      let targets;
      if (thread.kind === 'dm') targets = [thread.agent];
      else {
        targets = parseTargets(text);
        if (!targets.length && Array.isArray(body.targets)) targets = body.targets.filter((id) => agentById.has(id));
        if (!targets.length) targets = agents.map((a) => a.id);
      }
      const userMsg = addMessage(thread, { id: uid('m'), role: 'user', text, targets, ts: Date.now() });
      for (const id of targets) {
        const agent = agentById.get(id);
        const msg = addMessage(thread, {
          id: uid('m'), role: 'agent', agent: id, replyTo: userMsg.id, text: '', status: 'queued', steps: [],
          sessionId: sessionFor(thread.id, id), ts: Date.now(),
        });
        dispatch(thread, agent, userMsg, msg);
      }
      pushAgents();
      return json(res, 200, { ok: true, id: userMsg.id, targets });
    }

    if ((m = p.match(/^\/api\/threads\/([^/]+)\/reset$/)) && req.method === 'POST') {
      const thread = state.threads[decodeURIComponent(m[1])];
      if (!thread) return json(res, 404, { error: 'unknown thread' });
      const body = await readBody(req);
      const ids = thread.kind === 'dm' ? [thread.agent] : (body.agent ? [body.agent] : agents.map((a) => a.id));
      for (const id of ids) { delete state.sessions[`${thread.id}|${id}`]; delete state.seen[`${thread.id}|${id}`]; }
      if (body.clear) { thread.messages = []; save(); broadcast('thread', thread); }
      else addMessage(thread, { id: uid('m'), role: 'system', text: `New Hermes session started for ${ids.join(', ')}`, ts: Date.now() });
      return json(res, 200, { ok: true });
    }

    if ((m = p.match(/^\/api\/messages\/([^/]+)\/(stop|approval)$/)) && req.method === 'POST') {
      const [, msg] = findMessage(m[1]);
      if (!msg || msg.role !== 'agent') return json(res, 404, { error: 'unknown message' });
      const agent = agentById.get(msg.agent);
      if (m[2] === 'stop' && !msg.runId && ACTIVE.has(msg.status)) {
        // still waiting for a model slot or a retry: cancel before it ever starts
        Object.assign(msg, { status: 'cancelled', endedAt: Date.now() });
        inputs.delete(msg.id);
        pushMessage(msg, true);
        return json(res, 200, { ok: true });
      }
      if (!msg.runId) return json(res, 409, { error: 'run has not started' });
      if (m[2] === 'stop') {
        await hermes(agent, 'POST', `/v1/runs/${encodeURIComponent(msg.runId)}/stop`, {});
        if (!TERMINAL.has(msg.status)) { msg.status = 'stopping'; pushMessage(msg, true); }
        return json(res, 200, { ok: true });
      }
      const { choice } = await readBody(req);
      if (!['once', 'session', 'always', 'deny'].includes(choice)) return json(res, 400, { error: 'bad choice' });
      const r = await respondApproval(agent, msg, choice);
      if (msg.approval) msg.approval.resolved = choice;
      if (msg.status === 'waiting') msg.status = 'running';
      pushMessage(msg, true);
      return json(res, 200, r || { ok: true });
    }

    if (req.method === 'GET' && !p.startsWith('/api/')) {
      const file = path.normalize(path.join(ROOT, 'public', p === '/' ? 'index.html' : p));
      if (!file.startsWith(path.join(ROOT, 'public'))) return json(res, 403, { error: 'forbidden' });
      fs.readFile(file, (err, buf) => {
        if (err) return json(res, 404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(buf);
      });
      return;
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, e.status && e.status < 500 ? e.status : 502, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Hermes Gateway  →  http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}${MOCK ? '   (mock squad)' : ''}\n`);
  for (const a of agents) console.log(`  ${a.emoji}  ${a.id.padEnd(14)} ${a.baseUrl || (a.apiEnabled === false ? '(API server off)' : '(no endpoint)')}  key: ${a.key ? a.keySource : 'missing'}`);
  if (!agents.length) console.log(`  No agents found in ${HERMES_HOME}. Create Hermes profiles, run ./enable-api.sh, or list agents in squad.json.`);
  console.log('');
  healthLoop().then(pushAgents);
  setInterval(healthLoop, 10000);
  if (!MOCK && DISCOVER) setInterval(() => syncAgents(), 30000);
});
