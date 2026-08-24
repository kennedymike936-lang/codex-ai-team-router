import { createServer } from "node:http";

const UI_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>AI Mission Control</title>
  <style>
    :root{color-scheme:dark;--bg:#07090d;--panel:#0d1118;--panel2:#111722;--line:#202a39;--text:#eef4ff;--muted:#8090a7;--cyan:#4de2ff;--lime:#9cff83;--amber:#ffc766;--magenta:#ee78ff;--red:#ff6f7d}
    *{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 72% -20%,#182348 0,transparent 38%),radial-gradient(circle at 2% 30%,#13242b 0,transparent 30%),var(--bg);color:var(--text);font:14px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;min-height:100vh}
    body:before{content:"";position:fixed;inset:0;pointer-events:none;background-image:linear-gradient(rgba(255,255,255,.018) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.018) 1px,transparent 1px);background-size:34px 34px;mask-image:linear-gradient(to bottom,#0006,transparent 70%)}
    button{font:inherit}.shell{max-width:1500px;margin:auto;padding:22px}.top{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:18px}.brand{display:flex;align-items:center;gap:14px}.mark{width:42px;height:42px;border:1px solid #3a7890;background:linear-gradient(145deg,#173443,#0b1018);display:grid;place-items:center;box-shadow:inset 0 0 20px #4de2ff18,0 0 24px #4de2ff12}.mark:after{content:"MC";font-size:11px;font-weight:900;letter-spacing:.14em;color:var(--cyan)}
    h1{font-size:18px;letter-spacing:.17em;margin:0;text-transform:uppercase}.sub{color:var(--muted);font-size:12px;margin-top:2px}.statusbar{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.chip{border:1px solid var(--line);background:#0a0e15cc;color:var(--muted);padding:7px 10px;font-size:11px;letter-spacing:.08em;text-transform:uppercase}.chip.live{color:var(--lime);border-color:#447a4e}.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:currentColor;margin-right:7px;box-shadow:0 0 9px currentColor}
    .grid{display:grid;grid-template-columns:245px minmax(420px,1fr) 280px;gap:14px}.panel{border:1px solid var(--line);background:linear-gradient(180deg,#0e141dcc,#090d13e8);box-shadow:0 18px 50px #0005;min-width:0}.panel-head{display:flex;justify-content:space-between;align-items:center;padding:13px 15px;border-bottom:1px solid var(--line);color:#b5c2d4;font-size:11px;font-weight:800;letter-spacing:.13em;text-transform:uppercase}.count{color:var(--cyan)}
    .commander{padding:16px}.commander-card{position:relative;border:1px solid #2b4654;background:linear-gradient(135deg,#13202a,#0c1118);padding:16px;overflow:hidden}.commander-card:after{content:"";position:absolute;width:120px;height:120px;border:1px solid #4de2ff22;border-radius:50%;right:-65px;top:-65px}.eyebrow{font-size:10px;letter-spacing:.18em;color:var(--cyan);text-transform:uppercase}.name{font-size:20px;font-weight:800;margin:5px 0}.role{color:var(--muted);font-size:12px}.rule{height:1px;background:var(--line);margin:15px 0}.metric{display:flex;justify-content:space-between;margin:10px 0;color:var(--muted);font-size:12px}.metric b{color:var(--text);font-variant-numeric:tabular-nums}.policy{margin-top:15px;padding:11px;border-left:2px solid var(--cyan);background:#101822;color:#9baabd;font-size:11px}
    .roster{max-height:calc(100vh - 390px);min-height:260px;overflow:auto;padding:6px}.model{display:grid;grid-template-columns:30px minmax(0,1fr) auto;align-items:center;gap:8px;padding:9px 7px;border-bottom:1px solid #17202c}.provider-mark{width:28px;height:28px;display:grid;place-items:center;border:1px solid var(--line);font-size:8px;font-weight:900;color:var(--cyan)}.model-name{font-weight:720;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.model-meta{font-size:9px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.model-state{font-size:8px;text-transform:uppercase;color:#66768c;text-align:right}.model-state.free,.model-state.ready,.model-state.active{color:var(--lime)}.model-state.manual,.model-state.credit{color:var(--amber)}.model-state.offline{color:var(--red)}
    .toolbar{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line)}.seg{display:flex;border:1px solid var(--line);padding:2px;background:#070a0f}.seg button,.pause{border:0;background:transparent;color:var(--muted);padding:6px 10px;cursor:pointer;font-size:11px}.seg button.active{background:#172232;color:var(--text)}.pause{margin-left:auto;border:1px solid var(--line)}.pause:hover,.seg button:hover{color:var(--text)}
    .timeline{height:calc(100vh - 150px);min-height:560px;overflow:auto;padding:14px 14px 50px}.empty{height:100%;min-height:420px;display:grid;place-items:center;text-align:center;color:var(--muted)}.empty-mark{width:66px;height:66px;border:1px solid #28374a;margin:auto auto 16px;display:grid;place-items:center;color:var(--cyan);font-size:22px;animation:pulse 2.2s infinite}@keyframes pulse{50%{box-shadow:0 0 35px #4de2ff1e}}
    .event{display:grid;grid-template-columns:78px 14px 1fr;gap:10px;position:relative}.event:not(:last-child):before{content:"";position:absolute;left:84px;top:23px;bottom:-12px;width:1px;background:#243142}.time{font:10px ui-monospace,SFMono-Regular,Consolas,monospace;color:#66768c;padding-top:11px;text-align:right}.node{width:9px;height:9px;border:2px solid var(--bg);background:var(--cyan);border-radius:50%;margin-top:12px;z-index:1;box-shadow:0 0 0 1px #355066}.event[data-status=success] .node{background:var(--lime)}.event[data-status=warning] .node{background:var(--amber)}.event[data-status=failed] .node,.event[data-status=takeover] .node{background:var(--red)}
    .event-card{border:1px solid #1d2836;background:#0d131c;margin-bottom:11px;padding:11px 13px;transition:.18s}.event-card:hover{border-color:#304257;transform:translateX(2px)}.event-top{display:flex;align-items:center;gap:8px}.actor{font-size:10px;font-weight:900;letter-spacing:.1em;text-transform:uppercase;color:var(--cyan)}.etype{font:9px ui-monospace,monospace;color:#62738a;margin-left:auto}.event-title{font-weight:720;margin:5px 0 2px}.detail{font-size:11px;color:#91a0b5;white-space:pre-wrap;word-break:break-word}.taskid{font:9px ui-monospace,monospace;color:#53647b;margin-top:7px}
    .legend{padding:13px 15px}.legend-row{display:flex;align-items:flex-start;gap:9px;margin:12px 0;color:#91a0b5;font-size:11px}.legend-row i{width:7px;height:7px;border-radius:50%;background:var(--cyan);margin-top:5px;flex:none}.notice{margin:12px;border:1px solid #393429;background:#191710;padding:11px;color:#c1ae81;font-size:10px}.footer{color:#526178;text-align:center;font-size:10px;margin-top:12px;letter-spacing:.08em}
    @media(max-width:1050px){.grid{grid-template-columns:210px 1fr}.right{display:none}}@media(max-width:760px){.shell{padding:12px}.top{align-items:flex-start}.grid{grid-template-columns:1fr}.left{display:none}.timeline{height:calc(100vh - 180px)}.statusbar .chip:not(.live){display:none}}
  </style>
</head>
<body>
  <div class="shell">
    <header class="top"><div class="brand"><div class="mark"></div><div><h1>AI Mission Control</h1><div class="sub">Codex-led orchestration · sanitized event surface</div></div></div><div class="statusbar"><div id="stream" class="chip"><span class="dot"></span>connecting</div><div class="chip">local only</div><div id="clock" class="chip">--:--:--</div></div></header>
    <main class="grid">
      <section class="panel left"><div class="panel-head">Commander <span class="count">01</span></div><div class="commander"><div class="commander-card"><div class="eyebrow">Final Authority</div><div class="name">Codex</div><div class="role">Marshal · Router · Reviewer</div><div class="rule"></div><div class="metric"><span>Tasks observed</span><b id="taskCount">0</b></div><div class="metric"><span>Decisions</span><b id="decisionCount">0</b></div><div class="metric"><span>Failovers</span><b id="failoverCount">0</b></div></div><div class="policy">Only sanitized events are displayed. Prompts, credentials and private chain-of-thought never enter this surface.</div></div></section>
      <section class="panel center"><div class="panel-head">Live operation timeline <span id="eventCount" class="count">0 events</span></div><div class="toolbar"><div class="seg"><button data-view="activity" class="active">Activity</button><button data-view="debate">Expert debate</button></div><button id="pause" class="pause">Pause stream</button></div><div id="timeline" class="timeline"><div class="empty"><div><div class="empty-mark">◇</div><strong>Waiting for the next operation</strong><div style="margin-top:7px;font-size:11px">Ask Codex to delegate a task or run a project phase.</div></div></div></div></section>
      <aside class="panel right"><div class="panel-head">Model roster <span id="modelCount" class="count">00</span></div><div id="roster" class="roster"><div class="notice">Loading configured model pool…</div></div><div class="panel-head">Signal guide</div><div class="legend"><div class="legend-row"><i></i><span>Assignments and active work</span></div><div class="legend-row"><i style="background:var(--lime)"></i><span>Free pool and accepted results</span></div><div class="legend-row"><i style="background:var(--amber)"></i><span>Credits, manual paid routes, verification</span></div><div class="legend-row"><i style="background:var(--red)"></i><span>Unavailable routes and Codex takeover</span></div></div><div class="notice">DeepSeek is paid and manual-only. Expert Debate shows explicit proposals and challenges—not hidden reasoning.</div></aside>
    </main><div class="footer">BOUND TO 127.0.0.1 · READ-ONLY · NO EXTERNAL ASSETS</div>
  </div>
  <script>
    const timeline=document.querySelector('#timeline'), stream=document.querySelector('#stream'), pause=document.querySelector('#pause'),rosterEl=document.querySelector('#roster');
    const events=[]; let paused=false,view='activity';
    const debateTypes=new Set(['agent.proposal','agent.challenge','leader.decision','research.verified']);
    const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
    const actorName=a=>({codex:'Codex',qwen:'Qwen',deepseek:'DeepSeek',grok:'Grok',gate:'Gate',system:'System'}[String(a).toLowerCase()]||a||'System');
    function render(){const visible=events.filter(e=>view==='activity'||debateTypes.has(e.type));document.querySelector('#eventCount').textContent=visible.length+' events';const tasks=new Set(events.map(e=>e.task_id).filter(Boolean));document.querySelector('#taskCount').textContent=tasks.size;document.querySelector('#decisionCount').textContent=events.filter(e=>e.type==='leader.decision').length;document.querySelector('#failoverCount').textContent=events.filter(e=>e.type==='provider.failover').length;if(!visible.length){timeline.innerHTML='<div class="empty"><div><div class="empty-mark">◇</div><strong>'+(view==='debate'?'No expert debate yet':'Waiting for the next operation')+'</strong><div style="margin-top:7px;font-size:11px">Structured events will appear here in real time.</div></div></div>';return}timeline.innerHTML=visible.map(e=>'<article class="event" data-status="'+esc(e.status)+'"><time class="time">'+new Date(e.created_at).toLocaleTimeString([],{hour12:false})+'</time><div class="node"></div><div class="event-card"><div class="event-top"><span class="actor">'+esc(actorName(e.actor))+'</span><span class="etype">'+esc(e.type)+'</span></div><div class="event-title">'+esc(e.title)+'</div>'+(e.detail?'<div class="detail">'+esc(e.detail)+'</div>':'')+(e.task_id?'<div class="taskid">'+esc(e.task_id)+'</div>':'')+'</div></article>').join('');timeline.scrollTop=timeline.scrollHeight;updateAgents()}
    function initials(s){return String(s||'?').split(/[-_ ]/).map(x=>x[0]).join('').slice(0,3).toUpperCase()}
    function renderRoster(items){document.querySelector('#modelCount').textContent=String(items.length).padStart(2,'0');rosterEl.innerHTML=items.map(m=>'<div class="model" data-provider="'+esc(m.provider)+'"><div class="provider-mark">'+esc(initials(m.provider))+'</div><div><div class="model-name" title="'+esc(m.model)+'">'+esc(m.model)+'</div><div class="model-meta">'+esc(m.provider)+' · '+esc(m.quota_label||m.tier||'configured')+'</div></div><div class="model-state '+esc(m.status)+'">'+esc(m.status)+'</div></div>').join('')||'<div class="notice">No models configured.</div>';updateAgents()}
    function updateAgents(){for(const actor of ['qwen','deepseek','grok']){const last=[...events].reverse().find(e=>String(e.actor).toLowerCase()===actor);const active=last&&['agent.started','research.started'].includes(last.type);for(const row of rosterEl.querySelectorAll('[data-provider]')){if(row.dataset.provider!==actor)continue;const el=row.querySelector('.model-state');if(!el)continue;if(active){el.dataset.prior=el.textContent;el.textContent='active';el.classList.add('active')}else if(el.textContent==='active'){el.textContent=el.dataset.prior||'ready';el.classList.remove('active')}}}}
    function add(e){if(events.some(x=>x.id===e.id))return;events.push(e);events.sort((a,b)=>a.id-b.id);if(events.length>500)events.splice(0,events.length-500);if(!paused)render()}
    const refreshRoster=()=>fetch('/api/roster').then(r=>r.json()).then(x=>renderRoster(x.models||[])).catch(()=>{if(!rosterEl.children.length)rosterEl.innerHTML='<div class="notice">Model roster unavailable.</div>'});
    fetch('/api/events').then(r=>r.json()).then(x=>(x.events||[]).forEach(add)).catch(()=>{});
    refreshRoster();
    setInterval(refreshRoster,10000);
    setInterval(()=>{const after=events.length?events[events.length-1].id:0;fetch('/api/events?after='+after).then(r=>r.json()).then(x=>(x.events||[]).forEach(add)).catch(()=>{})},2500);
    const source=new EventSource('/events');source.addEventListener('mission',e=>add(JSON.parse(e.data)));source.addEventListener('ready',()=>{stream.className='chip live';stream.innerHTML='<span class="dot"></span>live'});source.onerror=()=>{stream.className='chip';stream.innerHTML='<span class="dot"></span>reconnecting'};
    document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-view]').forEach(x=>x.classList.toggle('active',x===b));view=b.dataset.view;render()});
    pause.onclick=()=>{paused=!paused;pause.textContent=paused?'Resume stream':'Pause stream';if(!paused)render()};
    setInterval(()=>document.querySelector('#clock').textContent=new Date().toLocaleTimeString([],{hour12:false}),1000);
  </script>
</body></html>`;

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

export function createMissionControl({ stateStore, roster = [], host = "127.0.0.1", port = 0 } = {}) {
  let server = null;
  let address = null;
  const clients = new Set();

  const status = () => ({
    running: Boolean(server?.listening),
    host,
    port: address?.port || null,
    url: address ? `http://${host}:${address.port}` : null,
    clients: clients.size,
    privacy: "Sanitized events only; prompts, responses, credentials, and chain-of-thought are excluded.",
  });

  async function rosterSnapshot() {
    if (!stateStore?.countRequests) return roster;
    const now = Date.now();
    const since = Math.floor(now / 86_400_000) * 86_400_000;
    return Promise.all(roster.map(async (item) => {
      const limit = Number(item.daily_request_limit);
      if (!Number.isFinite(limit) || limit <= 0) return item;
      let used = 0;
      try { used = await stateStore.countRequests({ provider: item.provider, model: item.model, since }); } catch {}
      const remaining = Math.max(0, Math.trunc(limit) - Math.max(0, Number(used) || 0));
      return {
        ...item,
        daily_requests_used: used,
        quota_label: `${remaining}/${Math.trunc(limit)} left today`,
        status: remaining > 0 ? item.status : "offline",
      };
    }));
  }

  async function publish(event = {}) {
    const stored = stateStore?.recordMissionEvent
      ? await stateStore.recordMissionEvent(event)
      : { id: Date.now(), ...event, created_at: event.created_at || Date.now() };
    const payload = `event: mission\ndata: ${JSON.stringify(stored)}\n\n`;
    for (const client of [...clients]) {
      try { client.write(payload); } catch { clients.delete(client); }
    }
    return stored;
  }

  async function handle(req, res) {
    const url = new URL(req.url || "/", `http://${host}`);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("content-security-policy", "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:");
    if (req.method !== "GET") return json(res, 405, { error: "read_only" });
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(UI_HTML);
    }
    if (url.pathname === "/health" || url.pathname === "/api/status") return json(res, 200, status());
    if (url.pathname === "/api/roster") return json(res, 200, { models: await rosterSnapshot() });
    if (url.pathname === "/api/events") {
      const after = Number(url.searchParams.get("after") || 0);
      const events = stateStore?.listMissionEvents ? await stateStore.listMissionEvents({ after, limit: 500 }) : [];
      return json(res, 200, { events });
    }
    if (url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      res.write(`event: ready\ndata: ${JSON.stringify(status())}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (url.pathname === "/favicon.ico") { res.writeHead(204); return res.end(); }
    return json(res, 404, { error: "not_found" });
  }

  async function start() {
    if (server?.listening) return status();
    server = createServer((req, res) => { handle(req, res).catch((error) => json(res, 500, { error: String(error?.message || error).slice(0, 160) })); });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => { server.off("error", reject); resolve(); });
    });
    address = server.address();
    await publish({ type: "system.control", actor: "system", title: "Mission Control online", detail: "Read-only local event stream started.", status: "success" });
    return status();
  }

  async function stop() {
    if (!server) return status();
    for (const client of clients) { try { client.end(); } catch {} }
    clients.clear();
    const closing = server;
    server = null;
    address = null;
    await new Promise((resolve) => closing.close(() => resolve()));
    return status();
  }

  return { start, stop, status, publish };
}

export { UI_HTML };
