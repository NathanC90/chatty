// Self-check: node test.mjs
// Runs the real server as a child process so it can be killed and restarted mid-chat.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA_DIR = mkdtempSync(join(tmpdir(), "chatty-"));
let PORT = 0; // first start picks a free port, restarts reuse it
let base, proc;

async function startServer() {
    proc = spawn(process.execPath, [new URL("server.mjs", import.meta.url).pathname], { env: { ...process.env, PORT, DATA_DIR } });
    base = /http:\S+/.exec(await new Promise((resolve) => proc.stdout.once("data", resolve)))[0];
    PORT = new URL(base).port;
}
const stopServer = () => new Promise((resolve) => proc.once("exit", resolve).kill());

async function user() {
    const cookie = (await fetch(base)).headers.get("set-cookie").split(";")[0];
    const post = (path, body) => fetch(base + path, { method: "POST", headers: { cookie }, body: JSON.stringify(body ?? {}) });
    let reader, buf = "";
    const listen = async (lastEventId) => {
        const headers = { cookie, ...(lastEventId && { "last-event-id": String(lastEventId) }) };
        reader = (await fetch(`${base}/events`, { headers })).body.pipeThrough(new TextDecoderStream()).getReader();
        buf = "";
    };
    const next = async () => {
        for (;;) {
            const i = buf.indexOf("\n\n");
            if (i >= 0) {
                const frame = buf.slice(0, i);
                buf = buf.slice(i + 2);
                const data = /^data: (.*)$/m.exec(frame)?.[1];
                if (data) return JSON.parse(data);
            } else buf += (await reader.read()).value;
        }
    };
    return { cookie, post, listen, next, close: () => reader.cancel().catch(() => {}) };
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

    // Server goes down. b keeps writing; the message is only accepted once it's back.
    const lastSeenByA = got.msg.id + 1; // the image
    a.close(); b.close();
    await stopServer();
    await assert.rejects(b.post("/api/send", { cid: "c3", text: "you there?" }));
    await startServer();
    await b.post("/api/send", { cid: "c3", text: "you there?" });

    // a reconnects with Last-Event-ID and gets exactly what it missed; a fresh page load gets the whole history.
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
    proc?.kill();
    rmSync(DATA_DIR, { recursive: true, force: true });
}
