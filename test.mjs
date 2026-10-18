// Self-check: node chat/test.mjs
import assert from "node:assert/strict";
import { server } from "./server.mjs";

await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

async function connect() {
    const res = await fetch(`${base}/events`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    const next = async () => {
        while (!buf.includes("\n\n")) buf += (await reader.read()).value;
        const [chunk, ...rest] = buf.split("\n\n");
        buf = rest.join("\n\n");
        return JSON.parse(chunk.slice(6));
    };
    const { id } = await next();
    const send = (type, extra) => fetch(`${base}/send`, { method: "POST", body: JSON.stringify({ id, type, ...extra }) });
    return { next, send, close: () => reader.cancel() };
}

const a = await connect();
const b = await connect();
await a.send("find");
assert.equal((await a.next()).type, "waiting");
await b.send("find");
assert.equal((await a.next()).type, "matched");
assert.equal((await b.next()).type, "matched");

await a.send("typing");
assert.equal((await b.next()).type, "typing");
await a.send("msg", { text: "x".repeat(2000) });
assert.equal((await b.next()).text.length, 1000);
await a.send("msg", { text: "   " }); // ignored
await b.send("msg", { text: "hi" });
assert.deepEqual(await a.next(), { type: "msg", text: "hi" });

assert.equal((await fetch(`${base}/send`, { method: "POST", body: "{}" })).status, 400);

a.close(); // closing the tab counts as leaving
assert.equal((await b.next()).type, "left");
await b.send("find");
assert.equal((await b.next()).type, "waiting");

b.close();
server.close();
server.closeAllConnections();
console.log("chat self-check passed");
