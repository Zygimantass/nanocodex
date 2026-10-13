// Public renderer protocol + real managed HTTP transport, with synthetic data.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = `${root}/output/gpui/journey`;
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, ["js/account/scripts/preview-gpui.mjs"], {
  cwd: root, env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "", browser, page;
server.stdout.on("data", chunk => { serverLog += chunk; });
server.stderr.on("data", chunk => { serverLog += chunk; });
const observations = [];
const record = message => { observations.push(message); console.log(`PASS: ${message}`); };
try {
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Preview failed to start: ${serverLog}`)), 120000);
    server.once("exit", code => { clearTimeout(timer); reject(new Error(`Preview exited ${code}: ${serverLog}`)); });
    server.stdout.on("data", () => {
      const port = serverLog.match(/GPUI synthetic preview ready on (\d+)/)?.[1];
      if (port) { clearTimeout(timer); resolve(`http://127.0.0.1:${port}`); }
    });
  });
  assert.equal((await (await fetch(`${origin}/__state`)).json()).synthetic, true);
  await fetch(`${origin}/__control`, { method: "POST", body: JSON.stringify({ holdTurns: true, turnDelay: 0 }) });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || chromium.executablePath(), headless: true,
    // Chromium's device-pixel ResizeObserver uses the actual display scale, not
    // the DevTools DPR override. Keep both at 2 for GPUI's physical canvas.
    args: ["--force-device-scale-factor=2"],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  await context.route("**/*", route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await context.addInitScript(() => {
    if (window === window.top) {
      window.snapshots = []; window.actions = [];
      addEventListener("message", event => {
        if (event.data?.type === "gpui:action") window.actions.push(event.data.action);
        if (event.data?.type === "gpui:ready") window.rendererReady = true;
      });
    } else {
      addEventListener("message", event => { if (event.data?.type === "gpui:snapshot") window.top.snapshots.push(event.data.snapshot); });
    }
  });
  page = await context.newPage();
  const requests = [];
  page.on("request", request => { if (request.url().includes("/v1/")) requests.push({ method: request.method(), url: request.url(), body: request.postData() }); });
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const wait = async (predicate, arg) => { await page.waitForFunction(predicate, arg, { timeout: 20000 }); await settle(); };
  const snapshot = () => page.evaluate(() => window.snapshots.at(-1));
  const type = async text => { await page.mouse.click(540, 765); await page.keyboard.type(text); await wait(text => window.snapshots.at(-1)?.draft === text, text); };
  const holdHistory = async id => {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const pattern = `**/v1/agents/${id}/events/history*`;
    const started = page.waitForRequest(request => request.url().includes(`/v1/agents/${id}/events/history`));
    await page.route(pattern, async route => { await held; await route.continue(); });
    return { started, release };
  };
  const control = value => fetch(`${origin}/__control`, { method: "POST", body: JSON.stringify(value) });
  await control({ signedIn: false, authMethods: { sms: false, selfHosted: true, oidc: { label: "Tailscale" } } });
  await page.goto(`${origin}/?entry=root#resume`);
  await page.getByRole("button", { name: "Sign in with Tailscale", exact: true }).waitFor();
  assert.equal(await page.locator(".home-hero").count(), 0);
  await page.screenshot({ path: `${output}/root-sign-in.png` });
  record("self-hosted root renders the real sign-in component without marketing");
  await control({ signedIn: true });
  await page.reload();
  await wait(() => window.snapshots.at(-1)?.connected && window.snapshots.at(-1)?.messages.length === 2);
  assert.equal(new URL(page.url()).search, "?entry=root");
  assert.equal(new URL(page.url()).hash, "#resume");
  assert(new URL(page.url()).pathname.startsWith("/agents/"));
  record("persistent root session reaches GPUI with query and fragment preserved");
  await control({ signedIn: false, authMethods: { sms: true, selfHosted: false } });
  await page.goto(origin);
  await page.locator(".home-hero").waitFor();
  assert.equal(new URL(page.url()).pathname, "/");
  await page.screenshot({ path: `${output}/root-hosted.png` });
  record("hosted control keeps the public marketing root");
  await control({ signedIn: true });
  await page.goto(`${origin}/agents`);
  await wait(() => window.snapshots.at(-1)?.connected && window.snapshots.at(-1)?.messages.length === 2);
  const initial = await snapshot();
  assert.equal(initial.agents.length, 3);
  assert.match(initial.messages[1].text, /migration guide/);
  record("catalog and saved user/assistant history cross the real HTTP boundary");
  await type("Keep this draft");
  const firstVisit = await holdHistory(initial.agents[2].id);
  await page.mouse.click(130, 494);
  await wait(() => window.snapshots.at(-1)?.selectedId?.endsWith("0003") && window.snapshots.at(-1)?.connected);
  try {
    await firstVisit.started;
    assert.equal((await snapshot()).loadingHistory, true, "unloaded history must not look like an empty conversation");
    assert.deepEqual((await snapshot()).messages, [], "another agent's messages must not appear while loading");
    await page.screenshot({ path: `${output}/loading-history.png` });
  } finally { firstVisit.release(); }
  await wait(() => window.snapshots.at(-1)?.messages.length === 2 && !window.snapshots.at(-1)?.loadingHistory);
  record("first visit shows a loading state until real history arrives, without showing another agent's messages");
  assert.equal((await snapshot()).draft, "");
  await type("Other agent draft");
  const beforeRevisit = await page.evaluate(() => window.snapshots.length);
  await page.mouse.click(130, 292);
  await wait(() => window.snapshots.at(-1)?.draft === "Keep this draft");
  const returning = await page.evaluate(start => window.snapshots.slice(start), beforeRevisit);
  assert(returning.every(s => s.selectedId), "switching must not emit a transient unselected workspace");
  for (const s of returning.filter(s => s.selectedId === initial.selectedId)) {
    assert.deepEqual(s.messages, initial.messages, "returning to an agent must retain its own transcript throughout selection");
  }
  await page.screenshot({ path: `${output}/retained-history.png` });
  await wait(() => !window.snapshots.at(-1)?.loadingHistory);
  record("revisiting an agent retains its transcript without an empty-workspace flash");
  record("different agents keep separate unsent drafts across selection changes");
  await page.mouse.click(540, 765);
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await wait(() => window.snapshots.at(-1)?.running);
  await type("Queued follow-up");
  await page.keyboard.press("Enter");
  await wait(() => window.actions.some(a => a.type === "send" && a.mode === "queue" && a.text === "Queued follow-up"));
  await fetch(`${origin}/__control`, { method: "POST", body: JSON.stringify({ holdTurns: false }) });
  await wait(() => window.snapshots.at(-1)?.messages.some(m => m.text === "Synthetic response: Keep this draft"));
  await wait(() => window.snapshots.at(-1)?.messages.some(m => m.text === "Synthetic response: Queued follow-up"));
  record("Enter sends; a second Enter queues behind the running turn and both receive replies");
  await fetch(`${origin}/__control`, { method: "POST", body: JSON.stringify({ holdTurns: true }) });
  await type("Cancel this turn");
  await page.keyboard.press("Enter");
  await wait(() => window.snapshots.at(-1)?.running);
  await page.mouse.click(990, 846);
  await wait(() => !window.snapshots.at(-1)?.running && !window.snapshots.at(-1)?.pending.length);
  assert(requests.some(r => r.method === "POST" && r.url.endsWith("/cancel")));
  record("Stop cancels the running turn through the managed API");
  await page.mouse.click(1220, 72);
  await page.getByRole("button", { name: "Back to Agents" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Back to Agents" }).click();
  await page.locator("iframe").waitFor({ state: "visible" });
  record("secondary web tools remain reachable and return to the same GPUI instance");
  await fetch(`${origin}/__control`, { method: "POST", body: JSON.stringify({ offline: true }) });
  await page.mouse.click(60, 872);
  await wait(() => window.snapshots.at(-1)?.error);
  await page.screenshot({ path: `${output}/error.png` });
  await fetch(`${origin}/__control`, { method: "POST", body: JSON.stringify({ offline: false }) });
  await page.mouse.click(60, 872);
  await wait(() => !window.snapshots.at(-1)?.error && window.snapshots.at(-1)?.connected);
  record("catalog failure is visible; Refresh recovers without losing the workspace");
  await page.mouse.click(247, 872);
  await wait(() => window.snapshots.at(-1)?.theme === "dark");
  await page.screenshot({ path: `${output}/dark.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${output}/narrow.png` });
  await page.mouse.click(52, 71);
  await page.screenshot({ path: `${output}/narrow-list.png` });
  record("dark and narrow layouts render; narrow navigation exposes the catalog");
  await page.setViewportSize({ width: 1280, height: 900 });
  await settle();
  await page.mouse.click(235, 167);
  await wait(() => window.snapshots.at(-1)?.selectedId?.endsWith("0004") && window.snapshots.at(-1)?.connected && !window.snapshots.at(-1)?.loadingHistory);
  assert.deepEqual((await snapshot()).messages, [], "a genuinely empty new agent must finish loading");
  await page.screenshot({ path: `${output}/empty-history.png` });
  record("a genuinely empty new agent finishes loading without inheriting another agent's transcript");
  await writeFile(`${output}/requests.json`, JSON.stringify(requests, null, 2));
  await writeFile(`${output}/snapshots.json`, JSON.stringify(await page.evaluate(() => window.snapshots), null, 2));
  await writeFile(`${output}/actions.json`, JSON.stringify(await page.evaluate(() => window.actions), null, 2));

  // Exercise the renderer's public host protocol with deliberately late draft
  // acknowledgements, without assuming React/stdio scheduling prevents races.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${origin}/gpui/index.html`);
  await wait(() => window.rendererReady);
  const publish = async value => {
    await page.evaluate(snapshot => postMessage({ type: "gpui:snapshot", snapshot }, location.origin), value);
    await settle();
  };
  const base = { ...initial, draft: "", messages: [], pending: [] };
  await publish(base);
  await wait(() => document.querySelector("canvas")?.width === 2560);
  await page.mouse.click(540, 750);
  await page.keyboard.type("ab");
  await wait(() => window.actions.at(-1)?.text === "ab");
  await publish({ ...base, draft: "a" });
  await page.keyboard.type("c");
  await wait(() => window.actions.at(-1)?.text === "abc");
  await page.keyboard.press("Enter");
  await wait(() => window.actions.at(-1)?.type === "send");
  assert.equal((await page.evaluate(() => window.actions.at(-1))).text, "abc");
  await publish(base);
  await page.keyboard.type("d");
  await wait(() => window.actions.at(-1)?.text === "d");
  record("late host echo does not erase newer typing; authoritative send clear still applies");
  const switched = { ...base, selectedId: initial.agents[2].id, draft: "Other" };
  await publish(switched);
  await page.mouse.click(540, 750);
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.insertText("🌍👩‍💻");
  await page.keyboard.press("Backspace");
  await wait(() => window.actions.at(-1)?.text === "Other\n🌍");
  record("selection changes restore the right draft; multiline and grapheme deletion preserve Unicode");
  await writeFile(`${output}/renderer-actions.json`, JSON.stringify(await page.evaluate(() => window.actions), null, 2));

  const failed = await context.newPage();
  await failed.route("**/gpui/**/*.wasm", route => route.abort());
  await failed.goto(`${origin}/agents`);
  await failed.getByRole("button", { name: "Open web tools", exact: true }).waitFor({ state: "visible" });
  assert.match(await failed.getByRole("status").innerText(), /GPUI could not start/);
  await failed.getByRole("button", { name: "Open web tools", exact: true }).click();
  await failed.getByRole("button", { name: "Back to Agents" }).waitFor({ state: "visible" });
  await failed.close();
  record("renderer load failure exposes usable HTML tools instead of a blank page");
} catch (error) {
  if (page) {
    await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
    await writeFile(`${output}/failure-wire.json`, JSON.stringify(await page.evaluate(() => ({ snapshots: window.snapshots, actions: window.actions })), null, 2));
  }
  throw error;
} finally {
  await writeFile(`${output}/server.log`, serverLog);
  await writeFile(`${output}/result.txt`, observations.join("\n") + "\n");
  await browser?.close();
  if (server.exitCode === null) { server.kill("SIGTERM"); await once(server, "exit"); }
}
