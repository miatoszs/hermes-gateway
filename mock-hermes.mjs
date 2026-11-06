// Mock Hermes API servers (one per profile) for trying the dashboard without a live squad.
// Speaks the same /health, /v1/models, /v1/runs and /v1/runs/{id}/events contract as
// `hermes gateway` with API_SERVER_ENABLED=true. Run with: node server.mjs --mock
import http from 'node:http';
import crypto from 'node:crypto';

// Generic tool calls the mock agents pretend to make (picked by profile name, so each agent differs).
const TOOL_SETS = [
  [['web_search', 'latest news on the topic'], ['read_file', 'notes/todo.md']],
  [['search_files', 'TODO'], ['read_file', 'README.md']],
  [['terminal', 'uptime && df -h /'], ['terminal', 'ls -la']],
  [['web_search', 'best practices checklist'], ['write_file', 'drafts/outline.md']],
];
const toolsFor = (profile) => TOOL_SETS[[...profile].reduce((h, c) => h + c.charCodeAt(0), 0) % TOOL_SETS.length];
const RISKY = /\b(deploy|restart|rm\s|delete|reboot|migrat)/i;
const STATUS_ASK = /\b(status|update|working on|progress)\b/i;

// Scripted replies for the built-in demo squad (npm run demo), so it looks like a real team.
// Real profiles run in mock mode fall back to the generic reply below.
const DEMO = {
  coordinator: {
    tools: [['kanban_list', 'board=launch status=open'], ['read_file', 'plans/this-week.md']],
    status: '**Launch week, day 3:** 7 of 10 tasks done.\n\n- ✅ Pricing page copy approved\n- 🔄 Launch post is on draft 2 and needs the researcher\'s numbers\n- ⛔ Staging deploy is waiting on the engineer\n\nNothing is blocked on you yet.',
  },
  researcher: {
    tools: [['web_search', 'competitor pricing 2026'], ['read_file', 'notes/market.md']],
    status: 'Finished the competitor scan: **12 sources** checked, summary in `notes/market.md`.\n\nTwo numbers still need a second source before the writer can quote them.',
  },
  writer: {
    tools: [['read_file', 'drafts/launch-post.md'], ['write_file', 'drafts/launch-post.md']],
    status: 'Launch post **draft 2** is ready (~900 words). I\'ll add the researcher\'s numbers once they\'re confirmed, then it\'s yours to review.',
  },
  engineer: {
    tools: [['terminal', 'git log --oneline -3'], ['terminal', 'npm test']],
    status: 'Staging build is green: **148 tests pass**. I can deploy once the web service is restarted, which needs your approval.',
    approval: { command: 'sudo systemctl restart web', description: 'Restart the web service on staging' },
    approved: 'Restarted `web` on staging. The health check is green and the new build is live. ✅',
    denied: 'Okay, I left the web service running. Tell me when you want to deploy.',
  },
};

function reply(profile, input, approval) {
  const ask = input.split('\n').filter(Boolean).pop() || '';
  const demo = DEMO[profile];
  if (demo && approval && demo.approved) return approval.choice === 'deny' ? demo.denied : demo.approved;
  if (demo && STATUS_ASK.test(ask)) return demo.status;
  const ctx = (input.split('\n').filter((l) => /^- [^:]{1,60}: /.test(l))).length;
  return [
    `**${profile}** here (mock Hermes). I got your message:`,
    '',
    `> ${ask.slice(0, 240)}`,
    '',
    ctx ? `I also read **${ctx}** earlier channel message(s) for context.` : 'No earlier channel context was needed.',
    '',
    'What I would do next:',
    '1. Break the request into steps',
    `2. Use my \`${profile}\` tools to gather facts`,
    '3. Report back here with what I verified',
  ].join('\n');
}

function startOne(profile, port, key) {
  const runs = new Map();
  const rateLimited = new Set();
  const emit = (run, event, fields = {}) => {
    const ev = { event, run_id: run.id, timestamp: Date.now() / 1000, ...fields, seq: run.events.length };
    run.events.push(ev);
    for (const s of run.subs) s.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
    if (/^run\.(completed|failed|cancelled)$/.test(event)) {
      run.status = event.slice(4);
      for (const s of run.subs) s.end();
      run.subs.clear();
    }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function execute(run) {
    const alive = () => run.status === 'running' || run.status === 'waiting_for_approval';
    await sleep(300 + Math.random() * 700);
    if (run.input.includes('RATELIMITTEST') && !rateLimited.has(run.session_id)) {
      rateLimited.add(run.session_id);
      return emit(run, 'run.failed', { error: 'HTTP 400: litellm.RateLimitError: Deployment has all max_parallel_requests slots in use.' });
    }
    for (const [tool, preview] of DEMO[profile]?.tools || toolsFor(profile)) {
      if (!alive()) return;
      const call = 'call_' + crypto.randomBytes(3).toString('hex');
      emit(run, 'tool.started', { tool, preview, tool_call_id: call });
      await sleep(500 + Math.random() * 900);
      emit(run, 'tool.completed', { tool, duration: 0.6, error: false, preview: 'ok (mock result)', tool_call_id: call });
    }
    if (RISKY.test(run.input)) {
      run.status = 'waiting_for_approval';
      run.approval = { request_id: 'apr_' + crypto.randomBytes(3).toString('hex'),
        ...(DEMO[profile]?.approval || { command: 'sudo systemctl restart example-service', description: 'Restart a system service' }) };
      emit(run, 'approval.request', { ...run.approval, choices: ['once', 'session', 'deny'] });
      const choice = await new Promise((r) => { run.resolveApproval = r; });
      if (run.status === 'cancelled') return;
      run.status = 'running';
      emit(run, 'approval.responded', { choice, request_id: run.approval.request_id, resolved: 1 });
      const call = 'call_' + crypto.randomBytes(3).toString('hex');
      emit(run, 'tool.started', { tool: 'terminal', preview: run.approval.command, tool_call_id: call });
      await sleep(600);
      emit(run, 'tool.completed', { tool: 'terminal', duration: 0.6, error: choice === 'deny', preview: choice === 'deny' ? 'BLOCKED: user denied' : 'exit 0', tool_call_id: call });
    }
    let text = reply(profile, run.input, run.approval);
    if (run.approval && !DEMO[profile]?.approved) text += `\n\nApproval answer received: \`${run.approval.choice}\`.`;
    for (const chunk of text.match(/[\s\S]{1,6}/g)) {
      if (!alive()) return;
      emit(run, 'message.delta', { delta: chunk });
      await sleep(18);
    }
    emit(run, 'run.completed', { output: text, usage: { input_tokens: run.input.length, output_tokens: text.length, total_tokens: run.input.length + text.length }, runtime: { provider: 'demo', model: 'demo-model' } });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (url.pathname === '/health') return send(200, { status: 'ok' });
    if (req.headers.authorization !== `Bearer ${key}`) return send(401, { error: { message: 'Invalid API key' } });
    let body = {};
    if (req.method === 'POST') { let s = ''; for await (const c of req) s += c; try { body = JSON.parse(s || '{}'); } catch { /* empty */ } }
    let m;
    if (url.pathname === '/v1/models') return send(200, { object: 'list', data: [{ id: profile, object: 'model' }] });
    if (url.pathname === '/v1/runs' && req.method === 'POST') {
      const run = { id: 'run_' + crypto.randomBytes(5).toString('hex'), status: 'running', input: String(body.input || ''), session_id: body.session_id, events: [], subs: new Set() };
      runs.set(run.id, run);
      execute(run);
      return send(202, { run_id: run.id, status: 'started' });
    }
    if ((m = url.pathname.match(/^\/v1\/runs\/([^/]+)(\/events|\/stop|\/approval)?$/))) {
      const run = runs.get(m[1]);
      if (!run) return send(404, { error: { message: 'run not found' } });
      if (!m[2]) return send(200, { object: 'hermes.run', run_id: run.id, status: run.status, session_id: run.session_id, output: run.events.at(-1)?.output });
      if (m[2] === '/stop') {
        run.status = 'cancelled';
        run.resolveApproval?.('deny');
        emit(run, 'run.cancelled', {});
        return send(200, { status: 'stopping' });
      }
      if (m[2] === '/approval') {
        if (!run.resolveApproval) return send(409, { error: { message: 'no pending approval' } });
        run.approval.choice = body.choice;
        run.resolveApproval(body.choice); run.resolveApproval = null;
        return send(200, { object: 'hermes.run.approval_response', run_id: run.id, choice: body.choice, resolved: 1 });
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(': open\n\n');
      const last = Number(url.searchParams.get('last_seq') ?? -1);
      for (const ev of run.events) if (ev.seq > last) res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
      if (['completed', 'failed', 'cancelled'].includes(run.status)) return res.end(': stream closed\n\n');
      run.subs.add(res);
      req.on('close', () => run.subs.delete(res));
      return;
    }
    send(404, { error: { message: 'not found' } });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ baseUrl: `http://127.0.0.1:${port}`, key })));
}

export function startMockSquad(profiles, basePort = 18643) {
  return Promise.all(profiles.map((p, i) => startOne(p, basePort + i, 'mock-' + crypto.randomBytes(8).toString('hex'))));
}
