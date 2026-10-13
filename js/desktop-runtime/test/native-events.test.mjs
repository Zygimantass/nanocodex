import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { NativeThreadEvents } from "../src/native-events.mjs";

const envelope = (cursor, text = "hello") => Object.freeze({
  cursor: String(cursor), turnId: "turn-1", createdAt: cursor,
  data: Object.freeze({ type: "event", event: Object.freeze({ type: "assistant.delta", payload: Object.freeze({ text }) }) }),
});
const snapshot = (events, metadata = {}) => Object.freeze({
  type: "thread", thread: Object.freeze({ id: "agent-1", events: Object.freeze(events), connected: true,
    hasMore: false, activeTurns: ["turn-1"], acceptedTurns: 1, settings: { model: "gpt-6.1-sol" }, ...metadata }),
});

test("native JSONL streams exact suffixes and metadata without retransmitting history", () => {
  const encoder = new NativeThreadEvents();
  const history = Array.from({ length: 800 }, (_, index) => envelope(index + 1));
  const initial = snapshot(history);
  const first = encoder.encode(initial);
  assert.equal(first.thread, initial.thread);
  const appended = snapshot([...history, envelope(801)]);
  const patch = JSON.parse(JSON.stringify(encoder.encode(appended)));
  assert.equal(patch.type, "threadPatch");
  assert.equal(patch.eventOffset, 800);
  assert.equal(patch.eventGeneration, first.eventGeneration);
  assert.deepEqual({ ...patch.thread, events: [...history, ...patch.thread.events] }, appended.thread);
  assert.ok(JSON.stringify(patch).length < JSON.stringify(appended).length / 100);
  const completed = encoder.encode(snapshot([...appended.thread.events], { activeTurns: [], connected: false, error: "Offline" }));
  assert.equal(completed.eventOffset, 801);
  assert.deepEqual(completed.thread.events, []);
  assert.deepEqual(completed.thread.activeTurns, []);
  assert.equal(completed.thread.error, "Offline");
  assert.equal(initial.thread.events.length, 800);
});

test("older, reordered, replaced, and pruned history always reset the native event ledger", () => {
  for (const change of [
    events => [envelope(0), ...events],
    events => [events[1], events[0], events[2]],
    events => [events[0], envelope(2, "replacement"), events[2]],
    events => [events[0], events[2]],
    events => [events[0], events[2], envelope(4)],
  ]) {
    const encoder = new NativeThreadEvents();
    const history = [envelope(1), envelope(2), envelope(3)];
    const first = encoder.encode(snapshot(history));
    const changed = snapshot(change(history));
    const replacement = encoder.encode(changed);
    assert.equal(replacement.type, "thread");
    assert.equal(replacement.thread, changed.thread);
    assert.notEqual(replacement.eventGeneration, first.eventGeneration);
    assert.equal(encoder.encode(snapshot([...changed.thread.events, envelope(5)])).eventOffset, changed.thread.events.length);
  }
});

test("close/reopen and account changes cannot reuse another native event prefix", () => {
  const encoder = new NativeThreadEvents();
  const firstAccount = { type: "state", state: { accountScope: "one" } };
  assert.equal(encoder.encode(firstAccount), firstAccount);
  const first = snapshot([envelope(1)]);
  encoder.encode(first);
  encoder.encode(firstAccount);
  assert.equal(encoder.encode(first).type, "threadPatch");
  encoder.forget("agent-1");
  const reopened = encoder.encode(first);
  assert.equal(reopened.type, "thread");
  assert.equal(reopened.thread, first.thread);
  encoder.encode({ type: "state", state: { accountScope: "two" } });
  const switched = encoder.encode(first);
  assert.equal(switched.thread, first.thread);
  assert.notEqual(switched.eventGeneration, reopened.eventGeneration);
  const second = snapshot([], { id: "agent-2" });
  assert.equal(encoder.encode(second).thread, second.thread);
  assert.equal(encoder.encode(first).eventOffset, 1);
});

test("the JSONL host emits suffixes and a full recovery frame in stream order", { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "nanocodex-native-wire-"));
  const agentID = "019a65fe-a456-7000-8000-000000000008";
  let stream;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url.includes("/events/history")) response.end(JSON.stringify({ data: [], latest_cursor: "0", has_more: false }));
    else if (request.url.includes("/events?")) {
      response.setHeader("content-type", "text/event-stream"); response.flushHeaders(); stream = response;
    } else if (request.url === `/v1/agents/${agentID}`) response.end(JSON.stringify({ active_turns: [] }));
    else response.end(JSON.stringify({ data: [] }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const frames = [];
  const child = spawn(process.execPath, [new URL("../src/host.mjs", import.meta.url).pathname], {
    env: { PATH: process.env.PATH, HOME: directory, NANOCODEX_DESKTOP_DATA: directory,
      NANOCODEX_API_KEY: `ncx_live_${"a".repeat(12)}_${"b".repeat(43)}`,
      NANOCODEX_MANAGED_URL: `http://127.0.0.1:${server.address().port}` },
    stdio: ["pipe", "pipe", "ignore"],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  createInterface({ input: child.stdout }).on("line", line => frames.push(JSON.parse(line)));
  async function waitFor(predicate) {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
      assert(Date.now() < deadline, JSON.stringify(frames));
      await delay(5, undefined, { signal: t.signal });
    }
  }
  const request = id => child.stdin.write(JSON.stringify({ id, method: "openThread", args: [agentID] }) + "\n");
  await waitFor(() => frames.some(frame => frame.event?.type === "state" && frame.event.state.connected));
  request("first"); await waitFor(() => frames.some(frame => frame.id === "first") && stream);
  const first = frames.find(frame => frame.event?.type === "thread").event;
  assert.equal(first.thread.events.length, 0);
  const event = { cursor: "1", created_at: 1, turn_id: "turn", type: "turn_accepted", id: "turn", input: "hello" };
  stream.write(`id: 1\nevent: message\ndata: ${JSON.stringify(event)}\n\n`);
  await waitFor(() => frames.some(frame => frame.event?.type === "threadPatch" && frame.event.thread.events.length));
  const patch = frames.find(frame => frame.event?.type === "threadPatch" && frame.event.thread.events.length).event;
  assert.equal(patch.eventGeneration, first.eventGeneration); assert.equal(patch.eventOffset, 0);
  assert.equal(patch.thread.events[0].cursor, "1");
  request("recover"); await waitFor(() => frames.some(frame => frame.id === "recover"));
  const responseIndex = frames.findIndex(frame => frame.id === "recover");
  const recovery = frames[responseIndex - 1].event;
  assert.equal(recovery.type, "thread");
  assert.notEqual(recovery.eventGeneration, first.eventGeneration);
  assert.deepEqual(recovery.thread, frames[responseIndex].result);
  const exit = once(child, "exit"); child.stdin.end(); assert.equal((await exit)[0], 0);
});

test("native catalog keeps web conversation order and presentation across connection and refresh", { timeout: 15_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "nanocodex-native-catalog-"));
  const ids = [1, 2, 3, 4].map(value => `019a65fe-a456-7000-8000-${String(value).padStart(12, "0")}`);
  const summaries = {
    [ids[0]]: { title: "Older request, active output", created_at: 1, updated_at: 9000, last_user_message_at: 1000, turn_count: 1,
      presentation: { revision: 1, status: "running", activeTurnIds: ["turn-a"], activity: "Reading files", activityTurnId: "turn-a", lastUserPrompt: "Read the project", updatedAt: 9000 } },
    [ids[1]]: { title: "Recent request", created_at: 2, updated_at: 4000, last_user_message_at: 2000, turn_count: 1,
      presentation: { revision: 2, status: "failed", activeTurnIds: [], lastUserPrompt: "Check the build", updatedAt: 4000 } },
    [ids[2]]: { title: "Same-time request", created_at: 3, updated_at: 3000, last_user_message_at: 2000, turn_count: 1,
      presentation: { revision: 3, status: "completed", activeTurnIds: [], done: true, updatedAt: 3000 } },
  };
  let malformed = false;
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [ids[0], ids[2], ids[3], ids[1]], summaries: malformed ? [] : summaries }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const key = `ncx_live_${"a".repeat(12)}_${"b".repeat(43)}`;
  const frames = [], errors = [];
  const child = spawn(process.execPath, [new URL("../src/host.mjs", import.meta.url).pathname], {
    env: { PATH: process.env.PATH, HOME: directory, NANOCODEX_DESKTOP_DATA: directory,
      NANOCODEX_API_KEY: key, NANOCODEX_MANAGED_URL: baseUrl, NANOCODEX_COMPUTER: "off" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", chunk => errors.push(String(chunk)));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  createInterface({ input: child.stdout }).on("line", line => frames.push(JSON.parse(line)));
  async function waitFor(predicate) {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
      assert(Date.now() < deadline, JSON.stringify({ frames, errors }));
      await delay(5, undefined, { signal: t.signal });
    }
  }
  async function call(id, method, args = []) {
    child.stdin.write(JSON.stringify({ id, method, args }) + "\n");
    await waitFor(() => frames.some(frame => frame.id === id));
    const frame = frames.find(frame => frame.id === id);
    assert.equal(frame.error, undefined);
    return frame.result;
  }
  await waitFor(() => frames.some(frame => frame.event?.type === "state" && frame.event.state.connected));
  const initial = await call("initial", "state");
  assert.deepEqual(initial.threads.map(thread => thread.id), [ids[1], ids[2], ids[0], ids[3]]);
  assert.deepEqual(initial.threads.map(thread => thread.lastUserMessageAt), [2000, 2000, 1000, 0]);
  assert.deepEqual(initial.threads[2].presentation, summaries[ids[0]].presentation);
  assert.equal(initial.threads[1].presentation.done, true, "Completed or marked-done agents remain in the same list as the web");
  assert.equal(initial.threads[3].presentation, undefined, "Legacy lists do not invent activity");
  const connected = await call("connect", "connect", [{ baseUrl, apiKey: key }]);
  assert.deepEqual(connected.threads, initial.threads, "Sign-in and refresh expose the same catalog contract");
  summaries[ids[0]].updated_at = 12000;
  summaries[ids[0]].presentation = { ...summaries[ids[0]].presentation, revision: 4, status: "stopping", updatedAt: 12000 };
  const refreshed = await call("refresh", "refresh");
  assert.deepEqual(refreshed.threads.map(thread => thread.id), initial.threads.map(thread => thread.id), "Agent output does not promote an older user request");
  assert.deepEqual(refreshed.threads[2].presentation, summaries[ids[0]].presentation);
  malformed = true;
  const failed = await call("failed", "refresh");
  assert.match(failed.error, /malformed/);
  assert.deepEqual(failed.threads, refreshed.threads, "A failed refresh preserves the last usable catalog");
  malformed = false;
  const recovered = await call("recovered", "refresh");
  assert.equal(recovered.error, undefined);
  assert.deepEqual(recovered.threads, refreshed.threads);
  assert.equal(JSON.stringify(frames).includes(key), false, "Catalog frames never contain credentials");
  t.diagnostic(JSON.stringify({ requests, threads: recovered.threads, recovery: "catalog retained on malformed response, then refreshed" }));
  const exit = once(child, "exit"); child.stdin.end(); assert.equal((await exit)[0], 0);
});
