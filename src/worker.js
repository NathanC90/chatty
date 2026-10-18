// Chatty: anonymous 1-on-1 chat in the spirit of WooTalk, on Cloudflare Workers.
// The browser is identified by a cookie. Everything lives in one Durable Object ("Chat"):
// users, conversations, messages and uploads are stored in its SQLite database, so
// reloads, network drops and redeploys all pick up where they left off.
// Server -> browser: WebSocket (hibernating, so idle connections cost nothing).
// Browser -> server: plain POSTs.
import { DurableObject } from "cloudflare:workers";

const PAGE = 100; // messages per history page
const MAX_TEXT = 2000;
const MAX_UPLOAD = 1.9 * 1024 * 1024; // one SQLite row holds at most 2 MB
const TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg"];

const cookieUid = (req) => /(?:^|;\s*)uid=([0-9a-f-]{36})/.exec(req.headers.get("Cookie") || "")?.[1];
const setCookie = (uid) => `uid=${uid}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`;
const empty = (status) => new Response(null, { status });
const hex = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");

export default {
    async fetch(req, env) {
        const url = new URL(req.url);
        if (req.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/key/"))) {
            const page = await env.ASSETS.fetch(new Request(new URL("/", url)));
            const res = new Response(page.body, page);
            if (!cookieUid(req)) res.headers.append("Set-Cookie", setCookie(crypto.randomUUID()));
            return res;
        }
        // Carries your identity (and so your conversation) over to another browser or device.
        const resume = /^\/resume\/([0-9a-f-]{36})$/.exec(url.pathname);
        if (resume) return new Response(null, { status: 302, headers: { "Set-Cookie": setCookie(resume[1]), Location: "/" } });
        if (!cookieUid(req)) return empty(401);
        return env.CHAT.get(env.CHAT.idFromName("chatty")).fetch(req);
    },
};

export class Chat extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;
        this.sql.exec(`
            CREATE TABLE IF NOT EXISTS users (uid TEXT PRIMARY KEY, convo TEXT, waiting TEXT);
            CREATE TABLE IF NOT EXISTS convos (id TEXT PRIMARY KEY, key TEXT, a TEXT, b TEXT, delivered_a INTEGER DEFAULT 0, delivered_b INTEGER DEFAULT 0);
            CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, convo TEXT, sender TEXT, type TEXT,
                text TEXT, file TEXT, cid TEXT, mobile INTEGER, duration REAL, time INTEGER);
            CREATE INDEX IF NOT EXISTS messages_convo ON messages (convo, id);
            CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, convo TEXT, mime TEXT, data BLOB);
            CREATE TABLE IF NOT EXISTS reports (time INTEGER, by TEXT, reasons TEXT, transcript TEXT);
        `);
        // Answers the page's keep-alive pings without waking this object up.
        ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    }

    rows = (q, ...args) => this.sql.exec(q, ...args).toArray();
    row = (q, ...args) => this.rows(q, ...args)[0];

    emit(uid, data) {
        for (const ws of this.ctx.getWebSockets(uid)) {
            try {
                ws.send(JSON.stringify(data));
            } catch {}
        }
    }

    user(uid) {
        this.sql.exec("INSERT OR IGNORE INTO users (uid) VALUES (?)", uid);
        return this.row("SELECT * FROM users WHERE uid = ?", uid);
    }
    convo = (id) => id && this.row("SELECT * FROM convos WHERE id = ?", id);
    partnerOf = (c, uid) => (c.a === uid ? c.b : c.a);
    partnerLeft = (c) => !!this.row("SELECT 1 FROM messages WHERE convo = ? AND type = 'leave'", c.id);

    view = (m, uid) => ({
        id: m.id, type: m.type, text: m.text ?? undefined, cid: m.cid, time: m.time, duration: m.duration,
        mobile: !!m.mobile, mine: m.sender === uid, url: m.file ? `/uploads/${m.convo}/${m.file}` : undefined,
    });

    snapshot(uid, after) {
        const u = this.user(uid);
        const c = this.convo(u.convo);
        if (!c) return { type: "state", state: u.waiting === null ? "idle" : "waiting", key: u.waiting ?? "", me: uid };
        const messages = after
            ? this.rows("SELECT * FROM messages WHERE convo = ? AND id > ? ORDER BY id", c.id, after)
            : this.rows("SELECT * FROM messages WHERE convo = ? ORDER BY id DESC LIMIT ?", c.id, PAGE).reverse();
        return {
            type: "state", state: "chat", me: uid, convo: c.id, key: c.key, reset: !after,
            hasMore: !after && this.row("SELECT COUNT(*) AS n FROM messages WHERE convo = ?", c.id).n > PAGE,
            messages: messages.map((m) => this.view(m, uid)),
            delivered: c.a === uid ? c.delivered_b : c.delivered_a,
            partnerLeft: this.partnerLeft(c),
        };
    }

    addMessage(c, uid, m) {
        const saved = this.row(
            `INSERT INTO messages (convo, sender, type, text, file, cid, mobile, duration, time)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
            c.id, uid, m.type, m.text ?? null, m.file ?? null, m.cid ?? null, m.mobile ? 1 : 0, m.duration ?? 0, Date.now(),
        );
        for (const u of [c.a, c.b]) if (this.user(u).convo === c.id) this.emit(u, { type: "msg", msg: this.view(saved, u) });
    }

    start(uid, key) {
        if (!this.user(uid).convo) {
            key = String(key ?? "").trim().slice(0, 50);
            const other = this.row("SELECT uid FROM users WHERE waiting = ? AND uid != ? ORDER BY rowid LIMIT 1", key, uid)?.uid;
            if (other) {
                const id = hex();
                this.sql.exec("INSERT INTO convos (id, key, a, b) VALUES (?, ?, ?, ?)", id, key, other, uid);
                this.sql.exec("UPDATE users SET waiting = NULL, convo = ? WHERE uid IN (?, ?)", id, other, uid);
                this.emit(other, this.snapshot(other));
            } else {
                this.sql.exec("UPDATE users SET waiting = ? WHERE uid = ?", key, uid);
            }
        }
        this.emit(uid, this.snapshot(uid));
    }

    leave(uid) {
        const c = this.convo(this.user(uid).convo);
        this.sql.exec("UPDATE users SET waiting = NULL, convo = NULL WHERE uid = ?", uid);
        if (c && this.partnerLeft(c)) {
            for (const table of ["messages", "files"]) this.sql.exec(`DELETE FROM ${table} WHERE convo = ?`, c.id);
            this.sql.exec("DELETE FROM convos WHERE id = ?", c.id);
        } else if (c) {
            this.addMessage(c, uid, { type: "leave" });
        }
        this.emit(uid, this.snapshot(uid));
    }

    async fetch(req) {
        const url = new URL(req.url);
        const path = url.pathname;
        const uid = cookieUid(req);
        const u = this.user(uid);
        const c = this.convo(u.convo);

        if (path === "/ws") {
            if (req.headers.get("Upgrade") !== "websocket") return empty(426);
            const [client, server] = Object.values(new WebSocketPair());
            this.ctx.acceptWebSocket(server, [uid]);
            server.send(JSON.stringify(this.snapshot(uid, Number(url.searchParams.get("after")) || 0)));
            return new Response(null, { status: 101, webSocket: client });
        }

        const upload = /^\/uploads\/([0-9a-f]{16})\/([0-9a-f]{16})$/.exec(path);
        if (req.method === "GET" && upload) {
            const f = u.convo === upload[1] && this.row("SELECT * FROM files WHERE id = ? AND convo = ?", upload[2], upload[1]);
            if (!f) return empty(404);
            return new Response(f.data, { headers: { "Content-Type": f.mime, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=31536000" } });
        }

        if (req.method === "GET" && path === "/api/history") {
            if (!c) return empty(404);
            const before = Number(url.searchParams.get("before"));
            const older = this.rows("SELECT * FROM messages WHERE convo = ? AND id < ? ORDER BY id DESC LIMIT ?", c.id, before, PAGE + 1);
            return Response.json({ messages: older.slice(0, PAGE).reverse().map((m) => this.view(m, uid)), hasMore: older.length > PAGE });
        }

        if (req.method !== "POST") return empty(404);
        const isDuplicate = (cid) => !!this.row("SELECT 1 FROM messages WHERE convo = ? AND sender = ? AND cid = ?", c.id, uid, cid);

        if (path === "/api/upload") {
            const type = (req.headers.get("Content-Type") || "").split(";")[0].trim();
            const cid = url.searchParams.get("cid") || "";
            if (!c || this.partnerLeft(c) || !TYPES.includes(type)) return empty(409);
            if (isDuplicate(cid)) return empty(204);
            const data = await req.arrayBuffer();
            if (!data.byteLength || data.byteLength > MAX_UPLOAD) return empty(413);
            const file = hex();
            this.sql.exec("INSERT INTO files (id, convo, mime, data) VALUES (?, ?, ?, ?)", file, c.id, type, data);
            this.addMessage(c, uid, {
                type: type.startsWith("image/") ? "image" : "audio",
                file, cid, duration: Math.min(Number(url.searchParams.get("duration")) || 0, 600),
            });
            return empty(204);
        }

        let body;
        try {
            const text = await req.text();
            if (text.length > 4 * MAX_TEXT + 1000) return empty(413);
            body = JSON.parse(text || "{}");
        } catch {
            return empty(400);
        }

        if (path === "/api/start") this.start(uid, body.key);
        else if (path === "/api/leave") this.leave(uid);
        else if (path === "/api/report") {
            if (c) {
                const reasons = [].concat(body.reasons || []).map((r) => String(r).slice(0, 200)).slice(0, 5);
                const transcript = this.rows("SELECT sender, type, text, time FROM messages WHERE convo = ? ORDER BY id", c.id);
                this.sql.exec("INSERT INTO reports VALUES (?, ?, ?, ?)", Date.now(), uid, JSON.stringify(reasons), JSON.stringify(transcript));
            }
            this.leave(uid);
        } else if (!c || this.partnerLeft(c)) return empty(409);
        else if (path === "/api/send") {
            const text = typeof body.text === "string" ? body.text.slice(0, MAX_TEXT) : "";
            const cid = String(body.cid || "");
            if (!text.trim()) return empty(400);
            // The page retries until it sees its message come back; cid makes retries harmless.
            if (!isDuplicate(cid)) this.addMessage(c, uid, { type: "text", text, cid, mobile: /Mobi/.test(req.headers.get("User-Agent") || "") });
        } else if (path === "/api/typing") this.emit(this.partnerOf(c, uid), { type: "typing" });
        else if (path === "/api/delivered") {
            const id = Number(body.id) || 0;
            const col = c.a === uid ? "delivered_a" : "delivered_b";
            if (id > c[col]) {
                this.sql.exec(`UPDATE convos SET ${col} = ? WHERE id = ?`, id, c.id);
                this.emit(this.partnerOf(c, uid), { type: "delivered", id });
            }
        } else return empty(404);

        return empty(204);
    }

    webSocketMessage() {} // the page only sends pings, which the auto-response answers
    webSocketClose(ws, code) {
        try {
            ws.close(code);
        } catch {}
    }
}
