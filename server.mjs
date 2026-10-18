// Chatty: anonymous 1-on-1 chat in the spirit of WooTalk. Zero dependencies.
// The browser is identified by a cookie and every conversation is saved to disk,
// so reloads, network drops and server restarts all pick up where they left off.
// Server -> browser: Server-Sent Events (auto-reconnect, replays missed messages).
// Browser -> server: plain POSTs.
import http from "node:http";
import { readFile, writeFile, mkdir, rm, appendFile } from "node:fs/promises";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { randomUUID, randomBytes } from "node:crypto";

const DATA = process.env.DATA_DIR || new URL("data/", import.meta.url).pathname;
const STATE_FILE = `${DATA}/state.json`;
const PAGE = 100; // messages per history page
const MAX_TEXT = 2000;
const MAX_UPLOAD = 15 * 1024 * 1024;
const TYPES = {
    "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
    "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/mpeg": "mp3",
};
const MIME = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [v, k]));

mkdirSync(DATA, { recursive: true });
const state = existsSync(STATE_FILE)
    ? JSON.parse(readFileSync(STATE_FILE, "utf8"))
    : { nextId: 1, users: {}, convos: {} };

// Written synchronously on every change (write, then rename), so a crash never loses a message.
function save() {
    writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(state));
    renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
}

const clients = new Map(); // uid -> Set of open SSE responses (one per tab)

const frame = (data, id) => `${id ? `id: ${id}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
const emit = (uid, data, id) => clients.get(uid)?.forEach((res) => res.write(frame(data, id)));

const partnerOf = (c, uid) => c.users.find((u) => u !== uid);
const partnerLeft = (c) => c.messages.some((m) => m.type === "leave");
const view = (m, uid) => ({ ...m, from: undefined, mine: m.from === uid });

function snapshot(uid, after) {
    const u = state.users[uid];
    const c = state.convos[u.convo];
    if (!c) return { type: "state", state: typeof u.waiting === "string" ? "waiting" : "idle", key: u.waiting ?? "", me: uid };
    const messages = after ? c.messages.filter((m) => m.id > after) : c.messages.slice(-PAGE);
    return {
        type: "state", state: "chat", me: uid, convo: c.id, key: c.key, reset: !after,
        hasMore: !after && c.messages.length > PAGE,
        messages: messages.map((m) => view(m, uid)),
        delivered: c.delivered[partnerOf(c, uid)] || 0,
        partnerLeft: partnerLeft(c),
    };
}

function addMessage(c, uid, msg) {
    const m = { id: state.nextId++, from: uid, time: Date.now(), ...msg };
    c.messages.push(m);
    save();
    for (const u of c.users) if (state.users[u]?.convo === c.id) emit(u, { type: "msg", msg: view(m, u) }, m.id);
}

function start(uid, key) {
    const u = state.users[uid];
    if (!u.convo) {
        key = String(key ?? "").trim().slice(0, 50);
        const other = Object.keys(state.users).find((id) => id !== uid && state.users[id].waiting === key);
        if (other) {
            const id = randomBytes(8).toString("hex");
            state.convos[id] = { id, key, users: [other, uid], messages: [], delivered: {} };
            Object.assign(state.users[other], { waiting: null, convo: id });
            Object.assign(u, { waiting: null, convo: id });
            emit(other, snapshot(other));
        } else {
            u.waiting = key;
        }
        save();
    }
    emit(uid, snapshot(uid));
}

function leave(uid) {
    const u = state.users[uid];
    const c = state.convos[u.convo];
    Object.assign(u, { waiting: null, convo: null });
    if (c && partnerLeft(c)) {
        delete state.convos[c.id];
        rm(`${DATA}/uploads/${c.id}`, { recursive: true, force: true }).catch(() => {});
    } else if (c) {
        addMessage(c, uid, { type: "leave" });
    }
    save();
    emit(uid, snapshot(uid));
}

function readBody(req, limit) {
    return new Promise((resolve) => {
        const chunks = [];
        let size = 0;
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > limit) {
                resolve(null);
                req.destroy();
            } else chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
    });
}

const cookieUid = (req) => /(?:^|;\s*)uid=([0-9a-f-]{36})/.exec(req.headers.cookie || "")?.[1];
const setCookie = (uid) => `uid=${uid}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`;

export const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;

    if (req.method === "GET" && (path === "/" || path.startsWith("/key/"))) {
        const headers = { "Content-Type": "text/html; charset=utf-8" };
        if (!cookieUid(req)) headers["Set-Cookie"] = setCookie(randomUUID());
        res.writeHead(200, headers);
        return res.end(await readFile(new URL("index.html", import.meta.url)));
    }

    // Carries your identity (and so your conversation) over to another browser or device.
    const resume = /^\/resume\/([0-9a-f-]{36})$/.exec(path);
    if (req.method === "GET" && resume) {
        return res.writeHead(302, { "Set-Cookie": setCookie(resume[1]), Location: "/" }).end();
    }

    const uid = cookieUid(req);
    if (!uid) return res.writeHead(401).end();
    const u = (state.users[uid] ??= { convo: null, waiting: null });
    const c = state.convos[u.convo];

    if (req.method === "GET" && path === "/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
        res.write("retry: 1500\n\n");
        if (!clients.has(uid)) clients.set(uid, new Set());
        clients.get(uid).add(res);
        // Last-Event-ID on the browser's own reconnects; ?after= when the page reconnects by hand.
        const after = Number(req.headers["last-event-id"] || url.searchParams.get("after")) || 0;
        const snap = snapshot(uid, after);
        res.write(frame(snap, snap.messages?.at(-1)?.id));
        const ping = setInterval(() => res.write(": ping\n\n"), 20000);
        req.on("close", () => {
            clearInterval(ping);
            clients.get(uid).delete(res);
        });
        return;
    }

    const upload = /^\/uploads\/([0-9a-f]{16})\/([0-9a-f]{16}\.([a-z0-9]+))$/.exec(path);
    if (req.method === "GET" && upload) {
        if (u.convo !== upload[1] || !MIME[upload[3]]) return res.writeHead(404).end();
        try {
            const file = await readFile(`${DATA}/uploads/${upload[1]}/${upload[2]}`);
            res.writeHead(200, { "Content-Type": MIME[upload[3]], "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=31536000" });
            return res.end(file);
        } catch {
            return res.writeHead(404).end();
        }
    }

    if (req.method === "GET" && path === "/api/history") {
        if (!c) return res.writeHead(404).end();
        const older = c.messages.filter((m) => m.id < Number(url.searchParams.get("before")));
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ messages: older.slice(-PAGE).map((m) => view(m, uid)), hasMore: older.length > PAGE }));
    }

    if (req.method !== "POST") return res.writeHead(404).end();

    if (path === "/api/upload") {
        const type = (req.headers["content-type"] || "").split(";")[0].trim();
        const cid = url.searchParams.get("cid") || "";
        if (!c || partnerLeft(c) || !TYPES[type]) return res.writeHead(409).end();
        if (c.messages.some((m) => m.from === uid && m.cid === cid)) return res.writeHead(204).end();
        const body = await readBody(req, MAX_UPLOAD);
        if (!body?.length) return res.writeHead(413).end();
        const name = `${randomBytes(8).toString("hex")}.${TYPES[type]}`;
        await mkdir(`${DATA}/uploads/${c.id}`, { recursive: true });
        await writeFile(`${DATA}/uploads/${c.id}/${name}`, body);
        if (state.convos[c.id]) {
            addMessage(c, uid, {
                type: type.startsWith("image/") ? "image" : "audio",
                url: `/uploads/${c.id}/${name}`,
                duration: Math.min(Number(url.searchParams.get("duration")) || 0, 600),
                cid,
            });
        }
        return res.writeHead(204).end();
    }

    let body;
    try {
        body = JSON.parse((await readBody(req, 4 * MAX_TEXT + 1000)) || "{}");
    } catch {
        return res.writeHead(400).end();
    }

    if (path === "/api/start") start(uid, body.key);
    else if (path === "/api/leave") leave(uid);
    else if (path === "/api/report") {
        if (c) {
            const reasons = [].concat(body.reasons || []).map((r) => String(r).slice(0, 200)).slice(0, 5);
            await appendFile(`${DATA}/reports.jsonl`, JSON.stringify({ time: Date.now(), by: uid, reasons, convo: c }) + "\n");
        }
        leave(uid);
    } else if (!c || partnerLeft(c)) return res.writeHead(409).end();
    else if (path === "/api/send") {
        const text = typeof body.text === "string" ? body.text.slice(0, MAX_TEXT) : "";
        const cid = String(body.cid || "");
        if (!text.trim()) return res.writeHead(400).end();
        // The browser retries until it sees its message come back; cid makes retries harmless.
        if (!c.messages.some((m) => m.from === uid && m.cid === cid)) {
            addMessage(c, uid, { type: "text", text, cid, mobile: /Mobi/.test(req.headers["user-agent"] || "") });
        }
    } else if (path === "/api/typing") emit(partnerOf(c, uid), { type: "typing" });
    else if (path === "/api/delivered") {
        const id = Number(body.id) || 0;
        if (id > (c.delivered[uid] || 0)) {
            c.delivered[uid] = id;
            save();
            emit(partnerOf(c, uid), { type: "delivered", id });
        }
    } else return res.writeHead(404).end();

    res.writeHead(204).end();
});

if (import.meta.url === `file://${process.argv[1]}`) {
    server.listen(process.env.PORT ?? 3000, () => console.log(`Chatty running at http://localhost:${server.address().port}`));
}
