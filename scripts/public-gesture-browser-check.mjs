/**
 * Gesture feedback UI check against the isolated fixture (FIXTURE_GESTURES=1
 * npx tsx scripts/public-viewer-fixture.ts) in a headless Firefox with a new
 * profile and a WebDriver BiDi port. Loopback fixtures only.
 *   node scripts/public-gesture-browser-check.mjs <fixture-url> <bidi-port> <output-dir>
 * Covers idle, submitting, sent (not "confirmed"), cooldown, busy/unsafe,
 * disabled, refusal, uncertain and lost delivery without retry, keyboard
 * reachability and a phone-width layout. Writes results.json and screenshots.
 */
import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const target = new URL(process.argv[2]);
if (target.protocol !== "http:" || target.hostname !== "127.0.0.1") throw Error("Use an isolated loopback fixture only");
const outDir = process.argv[4];
fs.mkdirSync(outDir, { recursive: true });
const ws = new WebSocket(`ws://127.0.0.1:${Number(process.argv[3] ?? 9223)}/session`);
let id = 0; const pending = new Map(); const errors = [];
ws.on("message", raw => { const m = JSON.parse(raw); if (m.id) { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); if (m.type === "error") p.reject(Error(JSON.stringify(m))); else p.resolve(m.result); } else if (m.method === "log.entryAdded" && m.params.level === "error") { if (errors.length < 50) errors.push(m.params.text); } });
const command = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
const results = {};
await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
await command("session.new", { capabilities: { alwaysMatch: {} } });
process.on("uncaughtException", async error => { console.error(error); await command("session.end").catch(() => undefined); process.exit(1); });
const context = (await command("browsingContext.getTree")).contexts[0].context;
await command("session.subscribe", { events: ["log.entryAdded"] });
const evaluate = async expression => { const r = await command("script.evaluate", { expression: "JSON.stringify(" + expression + ")", target: { context }, awaitPromise: true }); if (r.type === "exception") throw Error(JSON.stringify(r)); return r.result.value === undefined || r.result.value === "undefined" ? undefined : JSON.parse(r.result.value); };
const waitFor = async (expression, what = expression) => { for (let n = 0; n < 100; n++) { if (await evaluate(expression)) return; await new Promise(r => setTimeout(r, 100)); } throw Error("UI wait: " + what + " " + JSON.stringify(await ui().catch(() => null))); };
const shot = async name => { const r = await command("browsingContext.captureScreenshot", { context }); fs.writeFileSync(path.join(outDir, name + ".png"), Buffer.from(r.data, "base64")); };
const ui = () => evaluate('({reply:document.getElementById("publicReply").textContent,delivery:document.getElementById("publicReply").dataset.delivery,note:document.getElementById("actionNote").hidden?null:document.getElementById("actionNote").textContent,disabled:[...document.querySelectorAll("#publicActions button")].map(b=>b.disabled),hello:document.querySelector("#publicActions [data-action=hello]").textContent})');
// Count every gesture POST the page makes, and let the check substitute responses/state.
const instrument = `(()=>{window.fixtureFetch=window.fixtureFetch||window.fetch;window.gesturePosts=0;window.fetch=async(url,options)=>{const u=String(url);
  if(u.includes("/api/public/action")){window.gesturePosts++;if(window.actionReply==="lost")throw new TypeError("network");if(window.actionReply==="hold")return new Promise(r=>{window.releaseAction=()=>r(new Response(JSON.stringify({code:"ok",delivery:"sent",text:"Sent to Bob's game client. Minecraft hasn't independently confirmed it."}),{status:200}));});
    if(window.actionReply)return new Response(JSON.stringify(window.actionReply.body),{status:window.actionReply.status});}
  const response=await window.fixtureFetch(url,options);
  if(window.actionState&&u.includes("/api/state")){const s=await response.json();s.interactions={...s.interactions,...window.actionState};return new Response(JSON.stringify(s),{status:200,headers:{"content-type":"application/json"}});}
  return response;};return true})()`;

await command("browsingContext.setViewport", { context, viewport: { width: 1440, height: 1000 }, devicePixelRatio: 1 });
await command("browsingContext.navigate", { context, url: target.href, wait: "complete" });
await waitFor('document.getElementById("connectionText").textContent === "Online"');
await evaluate(instrument);
await waitFor('[...document.querySelectorAll("#publicActions button")].every(b=>!b.disabled)', "idle: gestures enabled");
results.idle = await ui();
await shot("desktop-idle");

// Keyboard reachability: native <button>s in Tab order. (Synthetic BiDi Enter/Space reach the
// focused button but headless Firefox did not fire native activation, so dispatch uses click.)
await evaluate('(()=>{document.querySelector("#publicActions [data-action=hello]").focus();return true})()');
await command("input.performActions", { context, actions: [{ type: "key", id: "keyboard", actions: [{ type: "keyDown", value: "\uE004" }, { type: "keyUp", value: "\uE004" }] }] });
results.keyboard = await evaluate('({tabbedTo:document.activeElement.dataset.action,native:[...document.querySelectorAll("#publicActions button")].every(b=>b.tagName==="BUTTON"&&b.type==="button"&&b.tabIndex===0),describedBy:document.querySelector("#publicActions [data-action=wave]").getAttribute("aria-describedby")})');
assert.equal(results.keyboard.tabbedTo, "wave"); assert.equal(results.keyboard.native, true);
// Dispatch through the real fixture handler: "sent", never labelled as confirmed.
await evaluate('(()=>{document.querySelector("#publicActions [data-action=wave]").click();return true})()');
await waitFor('document.getElementById("publicReply").dataset.delivery==="sent"', "sent");
results.sent = await ui();
assert.match(results.sent.reply, /hasn't independently confirmed/);
assert.doesNotMatch(results.sent.reply, /\bdone\b|verified/i);
await shot("desktop-sent");

// Submitting: every gesture button is disabled while one request is pending.
await evaluate('(()=>{window.actionReply="hold";return true})()');
await waitFor('[...document.querySelectorAll("#publicActions button")].some(b=>!b.disabled)', "ready again");
await evaluate('(()=>{document.querySelector("#publicActions [data-action=look_left]").click();return true})()');
await waitFor('document.getElementById("publicReply").dataset.delivery==="pending"', "pending");
results.submitting = await ui();
assert(results.submitting.disabled.every(Boolean), "buttons disabled while pending");
assert.equal(results.submitting.reply, "Sending…");
await evaluate('(()=>{window.releaseAction();window.actionReply=null;return true})()');
await waitFor('document.getElementById("publicReply").dataset.delivery==="sent"');

// Refusal (nothing sent), uncertain (quarantine), lost response: exactly one POST each, no retry.
const cases = {
  refused: { status: 503, body: { code: "unavailable", delivery: "not_sent", text: "Bob couldn't do that right now. Nothing was sent." } },
  uncertain: { status: 503, body: { code: "action_timeout", delivery: "uncertain", text: "Delivery could not be confirmed. Gestures are paused until an operator checks." } },
  interrupted: { status: 503, body: { code: "unconfirmed", delivery: "sent", text: "Sent, but Bob was interrupted right after. It may or may not have shown in the game." } },
  lost: "lost",
};
for (const [name, reply] of Object.entries(cases)) {
  await waitFor('[...document.querySelectorAll("#publicActions button")].some(b=>!b.disabled)', `${name}: ready`);
  await evaluate(`(()=>{window.gesturePosts=0;window.actionReply=${JSON.stringify(reply)};document.querySelector("#publicActions [data-action=look_right]").click();return true})()`);
  await waitFor('document.getElementById("publicReply").dataset.delivery!=="pending"&&window.gesturePosts===1', name);
  await new Promise(r => setTimeout(r, 1500));
  results[name] = { ...(await ui()), posts: await evaluate("window.gesturePosts") };
  assert.equal(results[name].posts, 1, `${name}: no automatic retry`);
  await shot(`desktop-${name}`);
}
assert.equal(results.refused.delivery, "not_sent"); assert.equal(results.uncertain.delivery, "uncertain");
assert.equal(results.lost.delivery, "uncertain"); assert.equal(results.lost.reply, "Delivery could not be confirmed.");
assert.equal(results.interrupted.delivery, "sent"); assert.match(results.interrupted.reply, /may or may not/);
await evaluate('(()=>{window.actionReply=null;return true})()');

// Cooldown after a refusal carrying the visitor's wait, then the hello-only cooldown label.
await evaluate('(()=>{window.actionReply={status:429,body:{code:"limited",delivery:"not_sent",text:"Please wait before trying again. Shared public limits apply.",retryAfterMs:9000}};document.querySelector("#publicActions [data-action=wave]").click();return true})()');
await waitFor('!document.getElementById("actionNote").hidden && /again in/.test(document.getElementById("actionNote").textContent)', "cooldown note");
results.cooldown = await ui();
assert(results.cooldown.disabled.every(Boolean));
await evaluate('(()=>{window.actionReply=null;window.actionState={helloCooldownMs:25000};return true})()');
await waitFor('/Hello \\(/.test(document.querySelector("#publicActions [data-action=hello]").textContent)', "hello cooldown");
results.helloCooldown = await ui();

// Busy/unsafe and disabled states come from public availability, with plain explanations.
for (const [name, state] of [["busy", { actions: false, actionsReason: "busy" }], ["disabled", { actions: false, actionsReason: "disabled" }]]) {
  await evaluate(`(()=>{window.actionState=${JSON.stringify(state)};return true})()`);
  await waitFor(`/${name === "busy" ? "idle and safe" : "switched off"}/.test(document.getElementById("actionNote").textContent)`, name);
  results[name] = await ui();
  assert(results[name].disabled.every(Boolean));
}
await shot("desktop-busy");

// Phone width: gesture controls stay inside the viewport without horizontal scrolling.
await command("browsingContext.setViewport", { context, viewport: { width: 390, height: 844 }, devicePixelRatio: 2 });
await evaluate('(()=>{window.actionState={actions:false,actionsReason:"busy"};document.getElementById("publicActions").scrollIntoView();return true})()');
await new Promise(r => setTimeout(r, 800));
results.mobile = await evaluate('({scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,buttons:[...document.querySelectorAll("#publicActions button")].map(b=>{const r=b.getBoundingClientRect();return {left:Math.round(r.left),right:Math.round(r.right),height:Math.round(r.height)}}),note:document.getElementById("actionNote").textContent})');
assert(results.mobile.scrollWidth <= results.mobile.clientWidth + 1, "no horizontal scroll at 390 px");
assert(results.mobile.buttons.every(b => b.left >= 0 && b.right <= 390 && b.height >= 32), "buttons inside viewport and tappable");
await shot("mobile-busy");
results.consoleErrors = errors;
fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify({ ok: true, states: Object.keys(results), consoleErrors: errors.length }));
await command("session.end").catch(() => undefined);
ws.close();
