// Runs production React, managed SDK and GPUI WASM against synthetic HTTP data.
// No credentials, real accounts or external model calls are used.
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, appendFile } from "node:fs/promises";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { nanocodexTools } from "../../nanocodex-vite/tools.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const out = path.join(root, "output/gpui/preview");
await mkdir(out, { recursive: true });
const entry = path.join(root, "js/account/gpui-preview.tsx");
await build({ configFile: false, root: path.join(root, "js/account"),
  define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
  resolve: { dedupe: ["react", "react-dom", "nanocodex", "nanocodex-react", "@tanstack/react-query"] },
  worker: { format: "es", plugins: () => [nanocodexTools()] },
  plugins: [nanocodexTools(), react(), { name: "gpui-preview-entry",
    resolveId(id) { if (id === entry) return entry; },
    load(id) {
      if (id === entry) return `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {QueryClientProvider} from '@tanstack/react-query';
      import {BrowserRouter,useLocation,useNavigate,Link} from 'react-router';
      import {appQueryClient} from './src/queryClient'; import {AccountSessionProvider} from './src/AccountSession';
      import {AgentExperience} from './src/AgentExperience'; import './src/index.css';
      function Preview(){const location=useLocation(),navigate=useNavigate();const [theme,setTheme]=React.useState('light');
        const change=React.useCallback((id,options)=>navigate('/agents/'+id,options),[navigate]);
        React.useEffect(()=>{document.documentElement.dataset.theme=theme;},[theme]);
        return <div style={{height:'100dvh',display:'flex',flexDirection:'column'}}>
          <div style={{padding:'8px 20px',fontSize:12,background:'#dce8dd',color:'#294d31'}}>GPUI preview · synthetic account and responses · no external calls</div>
          {location.pathname.startsWith('/agents')?<AgentExperience mode="full" agentId={location.pathname.split('/')[2]} onAgentChange={change} theme={theme} onThemeChange={setTheme}/>:<main style={{padding:40}}><h1>{location.pathname==='/account'?'Account':'Home'}</h1><p>Synthetic preview account.</p><Link to="/agents">Open agents</Link></main>}
        </div>;
      }
      createRoot(document.getElementById('root')).render(<QueryClientProvider client={appQueryClient}><BrowserRouter><AccountSessionProvider><Preview/></AccountSessionProvider></BrowserRouter></QueryClientProvider>);
    `; },
  }],
  build: { outDir: out, emptyOutDir: false, cssCodeSplit: false,
    lib: { entry, formats: ["es"], fileName: () => "preview.js", cssFileName: "preview" },
    rolldownOptions: { output: { codeSplitting: false } },
  },
});

const ids = [1, 2, 3].map(n => `019a65fe-a456-7000-8000-${String(n).padStart(12, "0")}`);
const agents = new Map(ids.map((id, index) => [id, {
  id, title: ["Prepare the release", "Investigate the slow build", "Compare storage options"][index],
  time: Date.now() - index * 60000, active: index === 1 ? ["background"] : [],
  events: [
    { cursor: "1", type: "turn_accepted", id: "initial", input: ["Review the release notes and flag anything we should fix before shipping.", "Find what is slowing down the build.", "Compare SQLite and Postgres for this project."][index], created_at: 1000 },
    { cursor: "2", type: "turn_completed", id: "initial", final_message: ["The release notes cover the API changes. One item needs a closer look: the migration guide still names the old configuration option.\n\nI can update the guide and run the examples before the release.", "I am checking the dependency graph and build timings.", "SQLite keeps deployment simple. Postgres is the better fit if multiple services need concurrent writes."][index], created_at: 2000 },
    ...(index === 1 ? [{ cursor: "3", type: "event", turn_id: "background", event: { type: "run.started", payload: { turn_id: "background" } } }] : []),
  ], streams: new Set(), turns: new Map(),
}]));
let offline = false;
let turnDelay = 4000;
function emit(agent, event) {
  const value = { cursor: String(agent.events.length + 1), created_at: Date.now(), turn_id: event.id, ...event };
  agent.events.push(value);
  for (const response of agent.streams) response.write(`id: ${value.cursor}\ndata: ${JSON.stringify(value)}\n\n`);
}
function finish(agent, id, status = "completed") {
  if (!agent.active.includes(id)) return;
  agent.active = agent.active.filter(value => value !== id);
  const text = `Synthetic response: ${agent.turns.get(id)?.input ?? ""}`;
  agent.turns.set(id, { id, status, final_message: text });
  emit(agent, { type: `turn_${status}`, id, final_message: text });
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    let raw = ""; for await (const chunk of req) raw += chunk;
    const input = raw ? JSON.parse(raw) : {};
    const json = (value, status = 200) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
    if (url.pathname.startsWith("/v1/") || url.pathname.startsWith("/__")) await appendFile(path.join(out, "http.jsonl"), JSON.stringify({ method: req.method, path: req.url, input }) + "\n");
    if (url.pathname === "/__control") { offline = input.offline ?? false; turnDelay = input.turnDelay ?? turnDelay; return json({ offline, turnDelay }); }
    if (url.pathname === "/__state") return json({ synthetic: true, agents: [...agents.values()].map(({ streams, turns, ...agent }) => ({ ...agent, turns: [...turns.values()] })) });
    if (url.pathname === "/api/health") return json({ agent_configured: true, credential_source: "brokered", voice_enabled: false });
    if (url.pathname === "/v1/me") return json({ user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", persistent: true, address: "0x1111111111111111111111111111111111111111" } });
    if (url.pathname === "/v1/teams") return json({ teams: [] });
    if (url.pathname === "/v1/agents") {
      if (offline) return json({ error: "Synthetic connection interrupted" }, 503);
      if (req.method === "POST") {
        const id = `019a65fe-a456-7000-8000-${String(agents.size + 1).padStart(12,"0")}`;
        agents.set(id, { id, title: "New agent", time: Date.now(), active: [], events: [], streams: new Set(), turns: new Map() });
        return json({ agent_id: id }, 201);
      }
      return json({ data: [...agents.keys()], summaries: Object.fromEntries([...agents].map(([id,a]) => [id, {
        title: a.title, created_at: 1, updated_at: a.time, last_user_message_at: a.time, turn_count: a.events.filter(e=>e.type==="turn_accepted").length,
        presentation: { revision: 1, status: a.active.length ? "running" : "idle", activeTurnIds: a.active, updatedAt: a.time, activity: a.active.length ? "Running checks" : "", lastUserPrompt: a.events.findLast(e=>e.type==="turn_accepted")?.input ?? "" },
      }])) });
    }
    const match = url.pathname.match(/^\/v1\/agents\/([^/]+)(.*)$/);
    if (match) {
      const [, agentId, suffix] = match; const agent = agents.get(agentId);
      if (!agent) return json({ error: "not_found" }, 404);
      if (suffix === "/phone/calls") return json({ calls: [] });
      if (suffix === "/events/history") return json({ data: agent.events.filter(event => (!url.searchParams.has("before") || BigInt(event.cursor) < BigInt(url.searchParams.get("before"))) && (!url.searchParams.has("after") || BigInt(event.cursor) > BigInt(url.searchParams.get("after")))), has_more: false, latest_cursor: String(agent.events.length) });
      if (suffix === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" }); res.write(": connected\n\n");
        for (const event of agent.events) if (BigInt(event.cursor) > BigInt(url.searchParams.get("cursor") === "latest" ? agent.events.length : url.searchParams.get("cursor") ?? "0")) res.write(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`);
        agent.streams.add(res); res.on("close", () => agent.streams.delete(res)); return;
      }
      if (suffix === "/turns" && req.method === "POST") {
        const id = input.id ?? `turn-${agent.events.length + 1}`; agent.active.push(id); agent.time = Date.now();
        agent.turns.set(id, { id, status: "running", input: input.input });
        emit(agent, { type: "turn_accepted", id, input: input.input });
        json({ agent_id: agentId, id, turn_id: id, accepted_cursor: String(agent.events.length) }, 202);
        emit(agent, { type: "event", id, event: { type: "run.started", payload: { turn_id: id } } });
        setTimeout(() => finish(agent, id), turnDelay).unref(); return;
      }
      const turn = suffix.match(/^\/turns\/([^/]+)(.*)$/);
      if (turn) {
        if (turn[2] === "/cancel") { finish(agent, turn[1], "cancelled"); return json({}); }
        if (turn[2] === "/steer") { agent.turns.get(turn[1]).input = input.input; return json({}); }
        return json(agent.turns.get(turn[1]) ?? { id: turn[1], status: "completed", final_message: "Saved response" });
      }
      if (suffix === "/prepare") return json({});
      if (suffix === "/triggers") return json({ data: [] });
      return json({ agent_id: agentId, latest_event_cursor: String(agent.events.length), active_turns: agent.active, accepted_turns: agent.events.length, scope: { type: "personal" }, settings: { model: "gpt-6-astra", thinking: "low", reasoning_mode: "standard", fast_mode: false } });
    }
    if (url.pathname.startsWith("/v1/")) return json({ data: [], connections: [], mcp_connections: [] });
    const publicRoot = path.join(root, "js/account/public");
    const file = url.pathname.startsWith("/gpui/") ? path.join(publicRoot, url.pathname) : ["/preview.js", "/preview.css"].includes(url.pathname) || url.pathname.startsWith("/assets/") ? path.join(out, url.pathname) : null;
    if (file) {
      res.setHeader("content-type", ({ ".wasm": "application/wasm", ".js": "text/javascript", ".css": "text/css", ".html": "text/html" })[path.extname(file)] ?? "application/octet-stream");
      return res.end(await readFile(file));
    }
    res.setHeader("content-type", "text/html");
    res.end('<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/preview.css"><div id="root"></div><script type="module" src="/preview.js"></script></html>');
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
server.listen(Number(process.env.PORT ?? 8799), "0.0.0.0", () => console.log(`GPUI synthetic preview ready on ${server.address().port}`));
