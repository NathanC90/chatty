// Self-check: npm test
// Runs the real Worker under `wrangler dev` (local, nothing is deployed) so it can be
// stopped and restarted mid-chat with its storage kept.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA_DIR = mkdtempSync(join(tmpdir(), "chatty-"));
const PORT = await new Promise((resolve) => {
    const s = createServer().listen(0, () => {
        const { port } = s.address();
        s.close(() => resolve(port));
    });
});
const base = `http://127.0.0.1:${PORT}`;
let proc;
const STORAGE_LIMIT = 3_000_000; // tiny, so the test can fill it
const STALE_MS = 3000; // a socket silent this long counts as gone (3 minutes in real use)

async function startServer() {
    const bin = new URL("node_modules/.bin/wrangler", import.meta.url).pathname;
    proc = spawn(bin, ["dev", "--ip", "127.0.0.1", "--port", PORT, "--persist-to", DATA_DIR, "--var", `STORAGE_LIMIT:${STORAGE_LIMIT}`, "--var", `STALE_MS:${STALE_MS}`], {
        cwd: new URL(".", import.meta.url).pathname,
        env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
        detached: true, // own process group, so stopping it also stops workerd
    });
    let out = "";
    await new Promise((resolve, reject) => {
        proc.stdout.on("data", (d) => (out += d) && /Ready on/.test(out) && resolve());
        proc.stderr.on("data", (d) => (out += d));
        proc.once("exit", () => reject(new Error(`wrangler dev exited:\n${out}`)));
    });
}
const stopServer = () => new Promise((resolve) => {
    proc.once("exit", resolve);
    process.kill(-proc.pid);
});

async function user() {
    const cookie = (await fetch(base)).headers.get("set-cookie").split(";")[0];
    const post = (path, body) => fetch(base + path, { method: "POST", headers: { cookie }, body: JSON.stringify(body ?? {}) });
    let ws, inbox = [], waiting;
    const listen = (after = 0) => new Promise((resolve, reject) => {
        inbox = [];
        ws = new WebSocket(`${base.replace("http", "ws")}/ws?after=${after}`, { headers: { cookie } });
        ws.onopen = resolve;
        ws.onerror = reject;
        ws.onmessage = (e) => {
            inbox.push(e.data === "pong" ? { type: "pong" } : JSON.parse(e.data));
            waiting?.();
        };
    });
    // Presence updates arrive whenever someone connects, so they're skipped unless asked for.
    const next = async (type) => {
        for (;;) {
            while (!inbox.length) await new Promise((resolve) => (waiting = resolve));
            const m = inbox.shift();
            if (type ? m.type === type : m.type !== "presence") return m;
        }
    };
    return { cookie, post, listen, next, send: (text) => ws.send(text), close: () => ws.close() };
}

try {
    await startServer();
    const a = await user(), b = await user(), stranger = await user();
    for (const u of [a, b, stranger]) await u.listen();
    for (const u of [a, b, stranger]) assert.equal((await u.next()).state, "idle");

    // 密語 matching: a and b share a secret word, the stranger without one is never paired with them.
    await a.post("/api/start", { key: "秘密" });
    assert.equal((await a.next()).state, "waiting");
    await stranger.post("/api/start", { key: "" });
    assert.equal((await stranger.next()).state, "waiting");
    await b.post("/api/start", { key: "秘密" });
    const matched = await a.next();
    assert.equal(matched.state, "chat");
    assert.equal(matched.key, "秘密");
    assert.equal(matched.presence, "online"); // b is connected
    assert.equal((await b.next()).state, "chat");

    // Messages, typing, retry dedup, delivered receipts.
    await a.post("/api/send", { cid: "c1", text: "hello" });
    await a.post("/api/send", { cid: "c1", text: "hello" }); // a retry must not duplicate
    assert.equal((await a.next()).msg.mine, true);
    const got = await b.next();
    assert.deepEqual([got.msg.text, got.msg.mine], ["hello", false]);
    await a.post("/api/typing");
    assert.equal((await b.next()).type, "typing");
    await b.post("/api/delivered", { id: got.msg.id });
    assert.deepEqual(await a.next(), { type: "delivered", id: got.msg.id });
    assert.equal((await a.post("/api/send", { cid: "c2", text: "   " })).status, 400);

    // Reactions: one per person per message, from a fixed set; both sides see who reacted with what.
    await b.post("/api/react", { id: got.msg.id, emoji: "❤️" });
    assert.deepEqual((await a.next()).msg.reactions, { mine: null, theirs: "❤️" });
    assert.deepEqual((await b.next()).msg.reactions, { mine: "❤️", theirs: null });
    await a.post("/api/react", { id: got.msg.id, emoji: "😂" });
    await a.post("/api/react", { id: got.msg.id, emoji: "👍" }); // changing replaces
    await a.next(), await b.next(), await a.next();
    assert.deepEqual((await b.next()).msg.reactions, { mine: "❤️", theirs: "👍" });
    // Any single emoji works, including flags, skin tones and joined ones; text or several emoji don't.
    for (const bad of ["abc", "👍👍", "1", "👍a"]) assert.equal((await b.post("/api/react", { id: got.msg.id, emoji: bad })).status, 400, bad);
    for (const good of ["💩", "🇹🇼", "👍🏽", "❤️‍🔥", "🥹"]) {
        assert.equal((await b.post("/api/react", { id: got.msg.id, emoji: good })).status, 204, good);
        assert.equal((await a.next()).msg.reactions.theirs, good);
        await b.next();
    }
    await b.post("/api/react", { id: got.msg.id, emoji: "❤️" }); // back to ❤️ for the checks below
    await a.next(), await b.next();
    assert.equal((await b.post("/api/react", { id: 999999, emoji: "👍" })).status, 400);

    // Replies quote the message they answer; a message from elsewhere is ignored.
    await b.post("/api/send", { cid: "r1", text: "回你", reply: got.msg.id });
    const reply = (await a.next()).msg;
    await b.next();
    assert.deepEqual(reply.replyTo, { id: got.msg.id, mine: true, type: "text", text: "hello", duration: 0 });
    await b.post("/api/send", { cid: "r2", text: "x", reply: 999999 });
    const x = (await a.next()).msg;
    assert.equal(x.replyTo, undefined);
    await b.next();
    // Unsending: only your own messages; the content is gone for both, and it can't be reacted to.
    assert.equal((await a.post("/api/unsend", { id: reply.id })).status, 400);
    await b.post("/api/unsend", { id: reply.id });
    const gone = (await a.next()).msg;
    await b.next();
    assert.deepEqual([gone.id, gone.type, gone.text], [reply.id, "unsent", undefined]);
    assert.equal((await b.post("/api/react", { id: reply.id, emoji: "👍" })).status, 400);

    // 🚨 Tickets (a joke): one per message with a random penalty; only the accused may appeal, once.
    await b.post("/api/ticket", { id: got.msg.id, reason: "🥶 冷笑話" });
    const ticketed = (await a.next()).msg;
    await b.next();
    assert.deepEqual([ticketed.ticket.reason, ticketed.ticket.byMe, ticketed.ticket.confession, ticketed.ticket.appeal], ["🥶 冷笑話", false, false, null]);
    assert.ok(ticketed.ticket.penalty);
    assert.equal((await b.post("/api/ticket", { id: got.msg.id, reason: "again" })).status, 409);
    assert.equal((await b.post("/api/ticket", { id: x.id, reason: "  " })).status, 400);
    assert.equal((await b.post("/api/appeal", { id: got.msg.id })).status, 400); // not b's to appeal
    await a.post("/api/appeal", { id: got.msg.id });
    const verdict = (await a.next()).msg;
    await b.next();
    assert.ok(verdict.ticket === null || verdict.ticket.appeal === "rejected", JSON.stringify(verdict.ticket));
    assert.equal((await a.post("/api/appeal", { id: got.msg.id })).status, 400); // once
    // Reporting your own message is a confession, which can't be appealed.
    await b.post("/api/ticket", { id: x.id, reason: "自首" });
    assert.equal((await a.next()).msg.ticket.confession, true);
    await b.next();
    assert.equal((await b.post("/api/appeal", { id: x.id })).status, 400);
    // Nine tickets in a row: never the same penalty twice running, and nothing embarrassing.
    const penalties = [];
    for (let i = 0; i < 9; i++) {
        await b.post("/api/send", { cid: `p${i}`, text: `joke ${i}` });
        const joke = (await a.next()).msg;
        await b.next();
        await a.post("/api/ticket", { id: joke.id, reason: "🥶 冷笑話" });
        penalties.push((await a.next()).msg.ticket.penalty);
        await b.next();
    }
    assert.equal(new Set(penalties).size, 9, penalties.join(" / "));
    assert.ok(!penalties.some((p) => p.includes("醜照")));

    // Images: stored, served only to the two people in the chat.
    const img = await fetch(`${base}/api/upload?cid=i1`, { method: "POST", headers: { cookie: a.cookie, "content-type": "image/png" }, body: "png-bytes" });
    assert.equal(img.status, 204);
    const { url, id: imageId } = (await b.next()).msg;
    await a.next();
    assert.equal(await (await fetch(base + url, { headers: { cookie: b.cookie } })).text(), "png-bytes");
    assert.equal((await fetch(base + url, { headers: { cookie: stranger.cookie } })).status, 404);
    assert.equal((await fetch(`${base}/api/upload?cid=x`, { method: "POST", headers: { cookie: a.cookie, "content-type": "image/svg+xml" }, body: "<svg/>" })).status, 409);
    const big = await fetch(`${base}/api/upload?cid=big`, { method: "POST", headers: { cookie: a.cookie, "content-type": "image/png" }, body: new Uint8Array(2 * 1024 * 1024) });
    assert.equal(big.status, 413);

    // Storage: near the limit, the oldest photos and voice clips are deleted to make room.
    // Their messages stay (without a file, shown as expired); text is never touched.
    const upload = (cid) => fetch(`${base}/api/upload?cid=${cid}`, { method: "POST", headers: { cookie: a.cookie, "content-type": "image/jpeg" }, body: new Uint8Array(1_000_000) });
    const both = async (n) => {
        const seen = [];
        for (let i = 0; i < n; i++) seen.push(await a.next());
        for (let i = 0; i < n; i++) await b.next();
        return seen;
    };
    assert.equal((await upload("p1")).status, 204);
    const [p1] = await both(1);
    assert.equal((await upload("p2")).status, 204);
    await both(1);
    assert.equal((await upload("p3")).status, 204); // 3 MB would pass 90%: the two oldest images go
    const [gone1, gone2, p3] = await both(3);
    assert.deepEqual([gone1.msg.id, gone1.msg.url], [imageId, undefined]);
    assert.deepEqual([gone2.msg.id, gone2.msg.url, gone2.msg.type], [p1.msg.id, undefined, "image"]);
    assert.ok(p3.msg.url);
    assert.equal((await fetch(base + p1.msg.url, { headers: { cookie: a.cookie } })).status, 404);
    const usage = await (await fetch(`${base}/api/usage`, { headers: { cookie: a.cookie } })).json();
    assert.ok(usage.limit === STORAGE_LIMIT && usage.used > 2_000_000 && usage.used < 2_400_000, JSON.stringify(usage));

    // Replying with a photo, then unsending it, deletes the file too.
    const tiny = await fetch(`${base}/api/upload?cid=u1&reply=${p3.msg.id}`, { method: "POST", headers: { cookie: a.cookie, "content-type": "image/png" }, body: "tiny" });
    assert.equal(tiny.status, 204);
    const [u1] = await both(1);
    assert.equal(u1.msg.replyTo.id, p3.msg.id);
    await a.post("/api/unsend", { id: u1.msg.id });
    await both(1);
    assert.equal((await fetch(base + u1.msg.url, { headers: { cookie: b.cookie } })).status, 404);

    // Keep-alive pings get answered.
    a.send("ping");
    assert.equal((await a.next()).type, "pong");

    // Presence: what each page reports reaches the other person; closing the page means 已離線.
    for (const state of ["idle", "offline", "online"]) {
        b.send(`presence:${state}`);
        assert.equal((await a.next("presence")).state, state);
    }
    b.close();
    assert.equal((await a.next("presence")).state, "offline");
    await b.listen(p3.msg.id);
    assert.equal((await a.next("presence")).state, "online");

    // A socket that's been quiet too long counts as gone (this test client never pings)...
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const presenceBecomes = async (u, state) => {
        for (;;) if ((await u.next("presence")).state === state) return;
    };
    await sleep(STALE_MS + 500);
    await a.listen(p3.msg.id);
    assert.equal((await a.next()).presence, "offline");
    // ...but anything b sends brings it straight back, even though a's page saw 已離線 in between:
    b.send("presence:online"); // what a page sends when you return to it
    await presenceBecomes(a, "online");
    await sleep(STALE_MS + 500);
    await b.post("/api/typing"); // typing, sending or reacting
    await presenceBecomes(a, "online");

    // Server goes down. b keeps writing; the message is only accepted once it's back.
    const lastSeenByA = u1.msg.id;
    a.close(); b.close();
    await stopServer();
    await assert.rejects(b.post("/api/send", { cid: "c3", text: "you there?" }));
    await startServer();
    await b.post("/api/send", { cid: "c3", text: "you there?" });
    await b.post("/api/react", { id: got.msg.id, emoji: "" }); // b takes its ❤️ back while a is offline

    // a reconnects asking for what came after the last message it saw, and gets exactly that; a fresh page load gets the whole history.
    await a.listen(lastSeenByA);
    const resumed = await a.next();
    assert.deepEqual([resumed.state, resumed.reset, resumed.messages.map((m) => m.text)], ["chat", false, ["you there?"]]);
    assert.deepEqual(resumed.reactions[got.msg.id], { mine: "👍", theirs: null }); // the removal catches up too
    assert.deepEqual(resumed.unsent, [reply.id, u1.msg.id]); // and so do unsent messages
    assert.deepEqual(resumed.tickets[got.msg.id], verdict.ticket); // and tickets, even thrown-out ones
    await b.listen();
    const reload = await b.next();
    assert.deepEqual(reload.messages.map((m) => m.text ?? m.type), ["hello", "unsent", "x", ...Array.from({ length: 9 }, (_, i) => `joke ${i}`), "image", "image", "image", "image", "unsent", "you there?"]);
    assert.equal(reload.delivered, 0); // a hasn't confirmed b's message yet

    // Same identity in another browser via the resume link.
    const res = await fetch(`${base}/resume/${resumed.me}`, { redirect: "manual" });
    assert.equal(res.headers.get("set-cookie").split(";")[0], a.cookie);

    // History paging.
    assert.equal((await (await fetch(`${base}/api/history?before=${got.msg.id + 1}`, { headers: { cookie: a.cookie } })).json()).messages.length, 1);

    // Leaving: b is told, can no longer send, and leaving too deletes the chat and its uploads.
    await a.post("/api/leave");
    assert.equal((await a.next()).state, "idle");
    assert.equal((await b.next()).msg.type, "leave");
    assert.equal((await b.post("/api/send", { cid: "c4", text: "hi" })).status, 409);
    assert.equal((await b.post("/api/react", { id: got.msg.id, emoji: "👍" })).status, 409);
    await b.post("/api/leave");
    assert.equal((await b.next()).state, "idle");
    assert.equal((await fetch(base + url, { headers: { cookie: b.cookie } })).status, 404);

    for (const u of [a, b, stranger]) u.close();
    console.log("chatty self-check passed");
} finally {
    if (proc?.exitCode === null) process.kill(-proc.pid);
    rmSync(DATA_DIR, { recursive: true, force: true });
}
