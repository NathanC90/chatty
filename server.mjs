// Anonymous 1-on-1 stranger chat (WooTalk-style). Zero dependencies:
// Server-Sent Events push to the browser, plain POSTs come back.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const MAX_MSG = 1000;
const clients = new Map(); // id -> { res, partner }
let waiting = null; // id of the one stranger waiting for a match

const push = (id, data) => clients.get(id)?.res.write(`data: ${JSON.stringify(data)}\n\n`);

function find(id) {
    leave(id);
    if (waiting && waiting !== id && clients.has(waiting)) {
        const other = waiting;
        waiting = null;
        clients.get(id).partner = other;
        clients.get(other).partner = id;
        push(id, { type: "matched" });
        push(other, { type: "matched" });
    } else {
        waiting = id;
        push(id, { type: "waiting" });
    }
}

function leave(id) {
    if (waiting === id) waiting = null;
    const me = clients.get(id);
    if (!me?.partner) return;
    const other = clients.get(me.partner);
    if (other) {
        other.partner = null;
        push(me.partner, { type: "left" });
    }
    me.partner = null;
}

function readJson(req) {
    return new Promise((resolve) => {
        let body = "";
        req.on("data", (c) => {
            body += c;
            if (body.length > 4 * MAX_MSG) req.destroy();
        });
        req.on("end", () => {
            try { resolve(JSON.parse(body)); } catch { resolve(null); }
        });
    });
}

export const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(await readFile(new URL("index.html", import.meta.url)));
    }

    if (req.method === "GET" && req.url === "/events") {
        const id = randomUUID();
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        clients.set(id, { res, partner: null });
        push(id, { type: "hello", id });
        const ping = setInterval(() => res.write(": ping\n\n"), 25000);
        req.on("close", () => {
            clearInterval(ping);
            leave(id);
            clients.delete(id);
        });
        return;
    }

    if (req.method === "POST" && req.url === "/send") {
        const msg = await readJson(req);
        const me = msg && clients.get(msg.id);
        if (!me) return res.writeHead(400).end();
        if (msg.type === "find") find(msg.id);
        else if (msg.type === "leave") leave(msg.id);
        else if (me.partner && msg.type === "typing") push(me.partner, { type: "typing" });
        else if (me.partner && msg.type === "msg" && typeof msg.text === "string" && msg.text.trim()) {
            push(me.partner, { type: "msg", text: msg.text.slice(0, MAX_MSG) });
        }
        return res.writeHead(204).end();
    }

    res.writeHead(404).end();
});

if (import.meta.url === `file://${process.argv[1]}`) {
    const port = process.env.PORT || 3000;
    server.listen(port, () => console.log(`Chat running at http://localhost:${port}`));
}
