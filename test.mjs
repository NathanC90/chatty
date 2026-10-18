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

async function startServer() {
    const bin = new URL("node_modules/.bin/wrangler", import.meta.url).pathname;
    proc = spawn(bin, ["dev", "--ip", "127.0.0.1", "--port", PORT, "--persist-to", DATA_DIR], {
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
    const next = async () => {
        while (!inbox.length) await new Promise((resolve) => (waiting = resolve));
        return inbox.shift();
    };
    return { cookie, post, listen, next, ping: () => ws.send("ping"), close: () => ws.close() };
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

    // Images: stored, served only to the two people in the chat.
    const img = await fetch(`${base}/api/upload?cid=i1`, { method: "POST", headers: { cookie: a.cookie, "content-type": "image/png" }, body: "png-bytes" });
    assert.equal(img.status, 204);
    const { url } = (await b.next()).msg;
    await a.next();
    assert.equal(await (await fetch(base + url, { headers: { cookie: b.cookie } })).text(), "png-bytes");
    assert.equal((await fetch(base + url, { headers: { cookie: stranger.cookie } })).status, 404);
    assert.equal((await fetch(`${base}/api/upload?cid=x`, { method: "POST", headers: { cookie: a.cookie, "content-type": "image/svg+xml" }, body: "<svg/>" })).status, 409);
    const big = await fetch(`${base}/api/upload?cid=big`, { method: "POST", headers: { cookie: a.cookie, "content-type": "image/png" }, body: new Uint8Array(2 * 1024 * 1024) });
    assert.equal(big.status, 413);

    // Keep-alive pings get answered.
    a.ping();
    assert.equal((await a.next()).type, "pong");

    // Server goes down. b keeps writing; the message is only accepted once it's back.
    const lastSeenByA = got.msg.id + 1; // the image
    a.close(); b.close();
    await stopServer();
    await assert.rejects(b.post("/api/send", { cid: "c3", text: "you there?" }));
    await startServer();
    await b.post("/api/send", { cid: "c3", text: "you there?" });

    // a reconnects asking for what came after the last message it saw, and gets exactly that; a fresh page load gets the whole history.
    await a.listen(lastSeenByA);
    const resumed = await a.next();
    assert.deepEqual([resumed.state, resumed.reset, resumed.messages.map((m) => m.text)], ["chat", false, ["you there?"]]);
    await b.listen();
    const reload = await b.next();
    assert.deepEqual(reload.messages.map((m) => m.text ?? m.type), ["hello", "image", "you there?"]);
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
    await b.post("/api/leave");
    assert.equal((await b.next()).state, "idle");
    assert.equal((await fetch(base + url, { headers: { cookie: b.cookie } })).status, 404);

    for (const u of [a, b, stranger]) u.close();
    console.log("chatty self-check passed");
} finally {
    if (proc?.exitCode === null) process.kill(-proc.pid);
    rmSync(DATA_DIR, { recursive: true, force: true });
}
