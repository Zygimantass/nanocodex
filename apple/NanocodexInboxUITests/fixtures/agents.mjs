// Synthetic account transport shared by the Mac and iOS native UI journeys.
// node apple/NanocodexInboxUITests/fixtures/agents.mjs [port]
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const ids = [1, 2, 3, 4, 5].map(n => `019a65fe-a456-7000-8000-${String(n).padStart(12, "0")}`);
const key = "ncx_live_abcdefgh1234_" + "x".repeat(43);
let malformed = false, output = false, revision = 1;
let recentRunning = false, recentStateRunning = false, recentUpdatedAt = 4000;
const creations = new Map();
const streams = new Map();
const summaries = () => ({
  [ids[0]]: { title: "Recent request", created_at: 1, updated_at: recentUpdatedAt, last_user_message_at: 2000, turn_count: 1,
    presentation: { status: recentRunning ? "running" : "completed", done: true, activeTurnIds: recentRunning ? ["remote"] : [], revision, updatedAt: recentUpdatedAt, lastUserPrompt: "Review the release notes", lastUserMessageAt: 2000 } },
  [ids[1]]: { title: "Same-time request", created_at: 1, updated_at: 3000, last_user_message_at: 2000, turn_count: 1,
    presentation: { status: "failed", activeTurnIds: [], revision, updatedAt: 3000, lastUserPrompt: "Check the build", lastUserMessageAt: 2000 } },
  [ids[2]]: { title: "Background research", created_at: 1, updated_at: output ? 12000 : 9000, last_user_message_at: 1000, turn_count: 1,
    presentation: { status: "running", revision, updatedAt: output ? 12000 : 9000, activeTurnIds: ["research"], activityTurnId: "research", activity: output ? "Comparing results" : "Reading files", lastUserPrompt: "Research the project", lastUserMessageAt: 1000 } },
  [ids[3]]: { title: "Legacy conversation", created_at: 1, updated_at: 500, turn_count: 1 },
});
const events = id => ids.indexOf(id) > 4 ? [] : [
  { cursor: "1", type: "turn_accepted", id: id === ids[2] ? "research" : "request", input: summaries()[id]?.presentation?.lastUserPrompt ?? "A legacy request", created_at: 1000 },
  ...(id === ids[2] ? [] : [{ cursor: "2", type: "turn_completed", id: "request", final_message: id === ids[0] ? "The release notes are ready." : "Saved conversation response.", created_at: 2000 }]),
];
const server = createServer(async (req, res) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  const url = new URL(req.url, "http://127.0.0.1");
  const send = (value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  if (url.pathname === "/__control") {
    const body = text ? JSON.parse(text) : {};
    malformed = body.malformed ?? malformed; output = body.output ?? output; revision++;
    if (body.recentRunning !== undefined) { recentRunning = body.recentRunning; recentUpdatedAt = Date.now(); }
    recentStateRunning = body.recentStateRunning ?? recentStateRunning;
    if (body.reset) { malformed = false; output = false; recentRunning = false; recentStateRunning = false; recentUpdatedAt = 4000; creations.clear(); ids.splice(5); }
    if (output) for (const response of streams.get(ids[2]) ?? []) response.write('id: 3\ndata: {"cursor":"3","type":"event","id":"research","event":{"type":"assistant.delta","payload":{"text":"Comparing results."}}}\n\n');
    send({ malformed, output, revision }); return;
  }
  const authorized = req.headers.authorization === `Bearer ${key}`;
  const record = { method: req.method, path: req.url, authorized };
  if (process.env.NANOCODEX_FIXTURE_LOG) appendFileSync(process.env.NANOCODEX_FIXTURE_LOG, JSON.stringify(record) + "\n");
  if (!authorized) { send({ error: "unauthorized" }, 401); return; }
  if (url.pathname === "/v1/agents") {
    if (req.method === "POST") {
      const token = req.headers["idempotency-key"];
      if (!creations.has(token)) { const id = `019a65fe-a456-7000-8000-${String(ids.length + 1).padStart(12, "0")}`; creations.set(token, id); ids.push(id); }
      send({ agent_id: creations.get(token) }, 201); return;
    }
    send({ data: [ids[2], ids[1], ids[4], ids[3], ids[0], ...ids.slice(5)], summaries: malformed ? [] : summaries() }); return;
  }
  if (url.pathname === "/v1/hands") { send({ data: [] }); return; }
  const match = url.pathname.match(/^\/v1\/agents\/([^/]+)(.*)$/);
  if (match) {
    const [, id, suffix] = match;
    if (!ids.includes(id)) { send({ error: "not_found" }, 404); return; }
    if (suffix === "/events/history") { send({ data: events(id), has_more: false, latest_cursor: id === ids[2] ? "1" : "2" }); return; }
    if (suffix === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(": connected\n\n");
      const values = streams.get(id) ?? new Set(); values.add(res); streams.set(id, values);
      req.on("close", () => values.delete(res));
      return;
    }
    if (suffix === "/triggers") { send({ data: [] }); return; }
    if (suffix === "/prepare") { send({}); return; }
    send({ agent_id: id, latest_event_cursor: ids.indexOf(id) > 4 ? "0" : id === ids[2] ? "1" : "2", active_turns: id === ids[2] ? ["research"] : id === ids[0] && recentStateRunning ? ["remote"] : [], settings: { model: "gpt-6-astra", thinking: "low", reasoning_mode: "standard", fast_mode: false } }); return;
  }
  send({ data: [], records: [], models: [] });
});
server.listen(Number(process.argv[2] ?? 8798), "127.0.0.1", () => process.stdout.write(`Native agents fixture listening on ${server.address().port}\n`));
