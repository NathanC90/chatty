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
// The smallest per-object storage limit Cloudflare's free-plan docs mention. Overridable for tests.
const STORAGE_LIMIT = 1024 ** 3;
const PRESENCE = ["offline", "idle", "online"]; // worst to best
// The page pings every 25 s, but browsers slow timers in background tabs to about once a minute,
// so a socket only counts as gone after 3 silent minutes. Overridable for tests.
const STALE_MS = 180_000;
// Any single emoji (one grapheme made only of emoji code points), not text or several emoji.
const isEmoji = (s) =>
    s.length <= 32 && /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\u200d|\ufe0f)+$/u.test(s) &&
    /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s) && [...new Intl.Segmenter().segment(s)].length === 1;
// Reporting a message is a joke between friends: the "judge" hands down a random penalty.
// Nothing embarrassing: playful, doable right there in the chat.
const PENALTIES = [
    "罰請對方喝一杯珍奶 🧋", "罰講一個更好笑的笑話 🎤", "罰用語音唱一句歌 🎶", "罰誇對方三句，不能重複 💐",
    "罰下次吃飯你請 🍜", "罰學貓叫一聲（要錄音）🐱", "罰接下來五則訊息句尾都要加「喵」", "罰十分鐘內不准說「哈哈」😶",
    "罰用台語說「我錯了」並錄音 🗣️", "罰幫對方取一個新綽號 🏷️", "罰作一首兩句的打油詩 📜", "罰推薦一首最近在聽的歌 🎧",
    "罰分享今天最開心的一件事 ☀️", "罰用三個表情符號形容今天 🎭", "罰傳一張你現在窗外的照片 🪟", "罰講一個冷知識 🧠",
    "罰說出對方的三個優點 ✨", "罰用注音文講話三句 ㄅㄆㄇ", "罰下一則訊息要用倒裝句 🔄", "罰今晚睡前要跟對方說晚安 🌙",
    "罰傳你相簿裡最新的一張美食照 🍰", "罰下次見面負責拍照 📸",
];
const CONFESSION_PENALTIES = [
    "從輕量刑：罰喝一杯水 💧", "從輕量刑：罰對自己說聲加油 💪", "自首有功，緩刑一天 ⚖️",
    "從輕量刑：罰伸個懶腰 🙆", "坦白從寬：這次只記一個小過 📝",
];
const APPEAL_ODDS = 0.35; // chance an appeal gets the ticket thrown out
// Random, but never one of the penalties handed down most recently in this chat.
const pickFresh = (list, recent) => {
    const fresh = list.filter((p) => !recent.slice(0, Math.floor(list.length / 2.5)).includes(p));
    return fresh[Math.floor(Math.random() * fresh.length)];
};
const TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg"];

const cookieUid = (req) => /(?:^|;\s*)uid=([0-9a-f-]{36})/.exec(req.headers.get("Cookie") || "")?.[1];
const setCookie = (uid) => `uid=${uid}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`;
const empty = (status) => new Response(null, { status });
const hex = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");

// For pages: only Chatty's own code and connections, no framing by other sites (clickjacking),
// no Referer to other sites (it could carry a /key/密語 address), and the microphone as the only device.
const pageHeaders = (url) => ({
    "Content-Security-Policy": `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' wss://${url.host}; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin", // ("no-referrer" would also hide our own origin from our own forms)
    "Permissions-Policy": "camera=(), geolocation=(), microphone=(self)",
});

// The /resume/... confirmation page: switching identity drops this browser's current chat,
// so it's never done by just opening a link (someone could send a link to their own identity).
const resumePage = (url) => new Response(`<!doctype html><html lang="zh-Hant"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Chatty</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:360px;margin:15vh auto;padding:0 20px;text-align:center;color-scheme:light dark}
button,a{display:block;width:100%;margin-top:10px;padding:12px;border:0;border-radius:12px;font:inherit;text-decoration:none;box-sizing:border-box}
button{background:#5b5bf7;color:#fff}a{color:inherit}</style>
<h2>在這個瀏覽器打開這段對話？</h2>
<p>這會把這個瀏覽器切換成連結裡的身分。只打開你自己的「在其他裝置繼續」連結；這個瀏覽器原本的對話，之後要用它自己的連結才能回去。</p>
<form method="post"><button>切換並打開對話</button></form><a href="/">取消</a></html>`, { headers: { "Content-Type": "text/html; charset=utf-8", ...pageHeaders(url) } });

export default {
    async fetch(req, env) {
        const url = new URL(req.url);
        if (req.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/key/"))) {
            const page = await env.ASSETS.fetch(new Request(new URL("/", url)));
            const res = new Response(page.body, page);
            for (const [k, v] of Object.entries(pageHeaders(url))) res.headers.set(k, v);
            if (!cookieUid(req)) res.headers.append("Set-Cookie", setCookie(crypto.randomUUID()));
            return res;
        }
        // Anything that changes state, and the live connection, must come from Chatty's own page.
        // Browsers say so with Sec-Fetch-Site (or, older ones, Origin); scripts and tests send neither.
        const origin = req.headers.get("Origin"), site = req.headers.get("Sec-Fetch-Site");
        const ownPage = site === "same-origin" || origin === url.origin;
        if (!ownPage && (site || origin) && (req.method !== "GET" || url.pathname === "/ws")) return empty(403);
        // Carries your identity (and so your conversation) over to another browser or device, after a confirmation.
        const resume = /^\/resume\/([0-9a-f-]{36})$/.exec(url.pathname);
        if (resume && req.method === "GET") return resumePage(url);
        if (resume && req.method === "POST") {
            if (!ownPage) return empty(403);
            return new Response(null, { status: 303, headers: { "Set-Cookie": setCookie(resume[1]), Location: "/" } });
        }
        if (!cookieUid(req)) return empty(401);
        try {
            return await env.CHAT.get(env.CHAT.idFromName("chatty")).fetch(req);
        } catch (e) {
            // Say what went wrong (e.g. a Cloudflare free-plan limit) instead of a bare "error code: 1101".
            console.error("Durable Object failed:", e);
            return new Response(`Chatty 暫時無法連線：${e?.message || e}`, { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
        }
    },
};

export class Chat extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;
        this.limit = Number(env.STORAGE_LIMIT) || STORAGE_LIMIT;
        this.staleMs = Number(env.STALE_MS) || STALE_MS;
        this.sql.exec(`
            CREATE TABLE IF NOT EXISTS users (uid TEXT PRIMARY KEY, convo TEXT, waiting TEXT);
            CREATE TABLE IF NOT EXISTS convos (id TEXT PRIMARY KEY, key TEXT, a TEXT, b TEXT, delivered_a INTEGER DEFAULT 0, delivered_b INTEGER DEFAULT 0);
            CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, convo TEXT, sender TEXT, type TEXT,
                text TEXT, file TEXT, cid TEXT, mobile INTEGER, duration REAL, time INTEGER);
            CREATE INDEX IF NOT EXISTS messages_convo ON messages (convo, id);
            CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, convo TEXT, mime TEXT, data BLOB);
            CREATE TABLE IF NOT EXISTS reports (time INTEGER, by TEXT, reasons TEXT, transcript TEXT);
        `);
        // Columns added after launch: existing databases get them, their messages are kept.
        // name_a / name_b: what a and b are called in this chat (shown to the other), null = 陌生人.
        const convoColumns = this.sql.exec("SELECT * FROM convos LIMIT 0").columnNames;
        for (const name of ["name_a", "name_b"]) {
            if (!convoColumns.includes(name)) this.sql.exec(`ALTER TABLE convos ADD COLUMN ${name} TEXT`);
        }
        const columns = this.sql.exec("SELECT * FROM messages LIMIT 0").columnNames;
        for (const [name, type] of [["reactions", "TEXT"], ["reply_to", "INTEGER"], ["ticket", "TEXT"]]) {
            // reactions: JSON { uid: emoji }; ticket: JSON { by, reason, penalty, appeal }, or "null" once thrown out
            if (!columns.includes(name)) this.sql.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`);
        }
        // The free plan caps rows read per day. Without these, every message, typing signal and
        // reconnect scanned the whole chat, so a long chat ran out of reads within a day; with
        // them each lookup reads only the rows it needs.
        this.sql.exec(`
            CREATE INDEX IF NOT EXISTS messages_type ON messages (convo, type);
            CREATE INDEX IF NOT EXISTS messages_cid ON messages (convo, cid);
            CREATE INDEX IF NOT EXISTS messages_reacted ON messages (convo) WHERE reactions IS NOT NULL;
            CREATE INDEX IF NOT EXISTS messages_ticketed ON messages (convo) WHERE ticket IS NOT NULL;
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

    reactionsOf(m, uid) {
        const r = JSON.parse(m.reactions || "{}");
        return { mine: r[uid] || null, theirs: Object.entries(r).find(([k]) => k !== uid)?.[1] || null };
    }

    // What a reply shows of the message it answers (the page prefers its own copy when it has one).
    quoteOf(id, uid) {
        const q = id && this.row("SELECT id, sender, type, text, duration FROM messages WHERE id = ?", id);
        if (!q) return undefined;
        return { id: q.id, mine: q.sender === uid, type: q.type, text: q.text?.slice(0, 120) ?? undefined, duration: q.duration };
    }

    view = (m, uid) => ({
        id: m.id, type: m.type, text: m.text ?? undefined, cid: m.cid, time: m.time, duration: m.duration,
        mobile: !!m.mobile, mine: m.sender === uid, url: m.file ? `/uploads/${m.convo}/${m.file}` : undefined,
        reactions: this.reactionsOf(m, uid), replyTo: this.quoteOf(m.reply_to, uid), ticket: this.ticketOf(m, uid),
    });

    ticketOf(m, uid) {
        const t = JSON.parse(m.ticket || "null");
        return t && { reason: t.reason, penalty: t.penalty, appeal: t.appeal ?? null, confession: t.by === m.sender, byMe: t.by === uid };
    }

    snapshot(uid, after) {
        const u = this.user(uid);
        const c = this.convo(u.convo);
        if (!c) return { type: "state", state: u.waiting === null ? "idle" : "waiting", key: u.waiting ?? "", me: uid };
        // One row past the page tells whether there's more, without counting the whole chat.
        const latest = !after && this.rows("SELECT * FROM messages WHERE convo = ? ORDER BY id DESC LIMIT ?", c.id, PAGE + 1);
        const messages = after
            ? this.rows("SELECT * FROM messages WHERE convo = ? AND id > ? ORDER BY id", c.id, after)
            : latest.slice(0, PAGE).reverse();
        return {
            type: "state", state: "chat", me: uid, convo: c.id, key: c.key, reset: !after,
            hasMore: !after && latest.length > PAGE,
            messages: messages.map((m) => this.view(m, uid)),
            delivered: c.a === uid ? c.delivered_b : c.delivered_a,
            presence: this.presenceOf(this.partnerOf(c, uid)),
            partnerLeft: this.partnerLeft(c),
            ...this.namesFor(c, uid),
            // Every reacted message, so reactions changed on older messages while offline catch up too.
            reactions: Object.fromEntries(
                this.rows("SELECT * FROM messages WHERE convo = ? AND reactions IS NOT NULL", c.id).map((m) => [m.id, this.reactionsOf(m, uid)]),
            ),
            // Likewise every unsent message, so ones taken back while this page was offline disappear too.
            unsent: this.rows("SELECT id FROM messages WHERE convo = ? AND type = 'unsent'", c.id).map((m) => m.id),
            // And tickets, including ones thrown out on appeal (null) while this page was offline.
            tickets: Object.fromEntries(
                this.rows("SELECT * FROM messages WHERE convo = ? AND ticket IS NOT NULL", c.id).map((m) => [m.id, this.ticketOf(m, uid)]),
            ),
        };
    }

    addMessage(c, uid, m) {
        const saved = this.row(
            `INSERT INTO messages (convo, sender, type, text, file, cid, mobile, duration, time, reply_to)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
            c.id, uid, m.type, m.text ?? null, m.file ?? null, m.cid ?? null, m.mobile ? 1 : 0, m.duration ?? 0, Date.now(),
            this.row("SELECT id FROM messages WHERE id = ? AND convo = ? AND type NOT IN ('leave', 'unsent')", Number(m.reply) || 0, c.id)?.id ?? null,
        );
        this.broadcast(c, saved);
    }

    // Sends a new or changed message to whoever is still in the chat; the page replaces it by id.
    broadcast(c, m) {
        for (const u of [c.a, c.b]) if (this.user(u).convo === c.id) this.emit(u, { type: "msg", msg: this.view(m, u) });
    }

    start(uid, key) {
        key = String(key ?? "").trim().slice(0, 50);
        // Optional lock: with ALLOWED_KEYS set (a Cloudflare secret, comma-separated), only those
        // 密語 can start a chat, so strangers who find the site can't use it or its free allowance.
        const allowed = (this.env.ALLOWED_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
        if (allowed.length && !allowed.includes(key) && !this.user(uid).convo) return false;
        if (!this.user(uid).convo) {
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
        return true;
    }

    // Someone's status across all their open tabs: the most present one wins.
    presenceOf(uid) {
        let best = 0;
        for (const ws of this.ctx.getWebSockets(uid)) {
            const { state, since = 0, lastSeen = 0 } = ws.deserializeAttachment() || {};
            const lastPing = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
            if (ws.readyState !== WebSocket.OPEN || Date.now() - Math.max(lastPing, since, lastSeen) > this.staleMs) continue;
            best = Math.max(best, PRESENCE.indexOf(state));
        }
        return PRESENCE[best];
    }

    // The names in a chat as uid sees them: what the other person is called, and what uid is called.
    namesFor = (c, uid) => (c.a === uid ? { partnerName: c.name_b, myName: c.name_a } : { partnerName: c.name_a, myName: c.name_b });

    // Tells the other person in uid's chat uid's current status. Always sent, never deduplicated:
    // the other page may have reconnected and seen a different status in its snapshot since.
    sendPresence(uid) {
        const c = this.convo(this.user(uid).convo);
        const partner = c && this.partnerOf(c, uid);
        if (partner && this.user(partner).convo === c.id) this.emit(partner, { type: "presence", state: this.presenceOf(uid) });
    }

    // Sending, typing or reacting proves someone is here, whatever their page last reported.
    touch(uid) {
        for (const ws of this.ctx.getWebSockets(uid)) {
            ws.serializeAttachment({ ...ws.deserializeAttachment(), state: "online", lastSeen: Date.now() });
        }
        this.sendPresence(uid);
    }

    // Once a minute while anyone is connected: catches phones that lost signal without closing the socket.
    async alarm() {
        const uids = new Set(this.ctx.getWebSockets().flatMap((ws) => this.ctx.getTags(ws)));
        for (const uid of uids) this.sendPresence(uid);
        if (uids.size) await this.ctx.storage.setAlarm(Date.now() + 60_000);
    }

    // Roughly what's stored: uploads plus a little per message.
    // Kept in memory and recomputed only after files change: uploads, plus ~300 bytes per message
    // (estimated from the newest id, which reads one row instead of every message).
    usage() {
        if (!this.usageCache) {
            const { files } = this.row("SELECT COALESCE(SUM(length(data)), 0) AS files FROM files");
            const { n } = this.row("SELECT COALESCE(MAX(id), 0) AS n FROM messages");
            this.usageCache = { used: files + n * 300, limit: this.limit };
        }
        return this.usageCache;
    }

    // Before an upload would bring storage near the limit, delete the oldest photos and voice clips.
    // Their messages stay and show as expired; text and reactions are never deleted.
    makeRoom(size) {
        let { used } = this.usage();
        if (used + size <= this.limit * 0.9) return;
        for (const f of this.rows("SELECT id, convo, length(data) AS size FROM files ORDER BY rowid")) {
            if (used + size <= this.limit * 0.8) break;
            this.sql.exec("DELETE FROM files WHERE id = ?", f.id);
            this.usageCache = null;
            used -= f.size;
            const m = this.row("UPDATE messages SET file = NULL WHERE file = ? RETURNING *", f.id);
            const c = this.convo(f.convo);
            if (m && c) this.broadcast(c, m);
        }
    }

    leave(uid) {
        const c = this.convo(this.user(uid).convo);
        this.sql.exec("UPDATE users SET waiting = NULL, convo = NULL WHERE uid = ?", uid);
        if (c && this.partnerLeft(c)) {
            for (const table of ["messages", "files"]) this.sql.exec(`DELETE FROM ${table} WHERE convo = ?`, c.id);
            this.usageCache = null;
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
            server.serializeAttachment({ state: "online", since: Date.now() }); // the page reports its real state right after
            server.send(JSON.stringify(this.snapshot(uid, Number(url.searchParams.get("after")) || 0)));
            this.sendPresence(uid);
            if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 60_000);
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

        if (req.method === "GET" && path === "/api/usage") return Response.json(this.usage());

        if (req.method !== "POST") return empty(404);
        const isDuplicate = (cid) => !!this.row("SELECT 1 FROM messages WHERE convo = ? AND sender = ? AND cid = ?", c.id, uid, cid);
        if (["/api/send", "/api/upload", "/api/typing", "/api/react", "/api/unsend", "/api/ticket", "/api/appeal"].includes(path)) this.touch(uid);

        if (path === "/api/upload") {
            const type = (req.headers.get("Content-Type") || "").split(";")[0].trim();
            const cid = url.searchParams.get("cid") || "";
            if (!c || this.partnerLeft(c) || !TYPES.includes(type)) return empty(409);
            if (isDuplicate(cid)) return empty(204);
            const data = await req.arrayBuffer();
            if (!data.byteLength || data.byteLength > MAX_UPLOAD) return empty(413);
            this.makeRoom(data.byteLength);
            if (this.usage().used + data.byteLength > this.limit) return empty(507);
            const file = hex();
            this.sql.exec("INSERT INTO files (id, convo, mime, data) VALUES (?, ?, ?, ?)", file, c.id, type, data);
            this.usageCache = null;
            this.addMessage(c, uid, {
                type: type.startsWith("image/") ? "image" : "audio",
                file, cid, duration: Math.min(Number(url.searchParams.get("duration")) || 0, 600), reply: url.searchParams.get("reply"),
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

        if (path === "/api/start") {
            if (!this.start(uid, body.key)) return new Response("這個聊天室只限受邀的人使用，請確認密語是否正確。", { status: 403 });
        }
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
            if (!isDuplicate(cid)) this.addMessage(c, uid, { type: "text", text, cid, reply: body.reply, mobile: /Mobi/.test(req.headers.get("User-Agent") || "") });
        } else if (path === "/api/ticket") {
            // Report a message (your own counts as a confession): one ticket per message.
            const m = this.row("SELECT * FROM messages WHERE id = ? AND convo = ? AND type NOT IN ('leave', 'unsent')", Number(body.id) || 0, c.id);
            const reason = String(body.reason || "").trim().slice(0, 30);
            if (!m || !reason) return empty(400);
            if (m.ticket && m.ticket !== "null") return empty(409);
            const recent = this.rows("SELECT ticket FROM messages WHERE convo = ? AND ticket IS NOT NULL", c.id)
                .map((r) => JSON.parse(r.ticket))
                .filter(Boolean)
                .sort((x, y) => (y.time || 0) - (x.time || 0))
                .map((t) => t.penalty);
            const penalty = pickFresh(m.sender === uid ? CONFESSION_PENALTIES : PENALTIES, recent);
            const ticket = JSON.stringify({ by: uid, reason, penalty, time: Date.now() });
            this.broadcast(c, this.row("UPDATE messages SET ticket = ? WHERE id = ? RETURNING *", ticket, m.id));
        } else if (path === "/api/appeal") {
            // Only the person who got the ticket, once, and not for a confession.
            const m = this.row("SELECT * FROM messages WHERE id = ? AND convo = ? AND sender = ?", Number(body.id) || 0, c.id, uid);
            const t = JSON.parse(m?.ticket || "null");
            if (!t || t.by === uid || t.appeal) return empty(400);
            const ticket = Math.random() < APPEAL_ODDS ? "null" : JSON.stringify({ ...t, appeal: "rejected" });
            this.broadcast(c, this.row("UPDATE messages SET ticket = ? WHERE id = ? RETURNING *", ticket, m.id));
        } else if (path === "/api/unsend") {
            // Only your own messages. The content (and any photo or voice clip) is deleted for good;
            // what's left is a marker both sides show as "…已收回一則訊息".
            const m = this.row("SELECT * FROM messages WHERE id = ? AND convo = ? AND sender = ? AND type NOT IN ('leave', 'unsent')", Number(body.id) || 0, c.id, uid);
            if (!m) return empty(400);
            if (m.file) this.sql.exec("DELETE FROM files WHERE id = ?", m.file);
            this.usageCache = null;
            this.broadcast(c, this.row("UPDATE messages SET type = 'unsent', text = NULL, file = NULL, reactions = NULL, ticket = NULL WHERE id = ? RETURNING *", m.id));
        } else if (path === "/api/react") {
            // One reaction per person per message; an empty emoji removes yours.
            const m = this.row("SELECT * FROM messages WHERE id = ? AND convo = ? AND type NOT IN ('leave', 'unsent')", Number(body.id) || 0, c.id);
            const emoji = body.emoji ? String(body.emoji) : "";
            if (!m || (emoji && !isEmoji(emoji))) return empty(400);
            const r = JSON.parse(m.reactions || "{}");
            if (emoji) r[uid] = emoji;
            else delete r[uid];
            this.broadcast(c, this.row("UPDATE messages SET reactions = ? WHERE id = ? RETURNING *", JSON.stringify(r), m.id));
        } else if (path === "/api/names") {
            // Either person can name both: "partner" is what they call the other, "me" what they're called.
            // An empty name goes back to 陌生人; up to 12 characters.
            const clean = (v) => (typeof v === "string" ? v.trim().slice(0, 12) || null : undefined);
            const [mine, theirs] = c.a === uid ? ["name_a", "name_b"] : ["name_b", "name_a"];
            for (const [col, value] of [[theirs, clean(body.partner)], [mine, clean(body.me)]]) {
                if (value !== undefined) this.sql.exec(`UPDATE convos SET ${col} = ? WHERE id = ?`, value, c.id);
            }
            const updated = this.convo(c.id);
            for (const u of [c.a, c.b]) this.emit(u, { type: "names", ...this.namesFor(updated, u) });
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

    // Pings are answered by the auto-response; the only other thing the page sends is its status.
    webSocketMessage(ws, msg) {
        const state = /^presence:(online|idle|offline)$/.exec(msg)?.[1];
        if (!state) return;
        ws.serializeAttachment({ ...ws.deserializeAttachment(), state, lastSeen: Date.now() }); // a message also proves it's alive
        this.sendPresence(this.ctx.getTags(ws)[0]);
    }

    webSocketClose(ws, code) {
        try {
            ws.close(code);
        } catch {}
        this.sendPresence(this.ctx.getTags(ws)[0]);
    }
}
