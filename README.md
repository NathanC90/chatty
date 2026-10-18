# Stranger Chat

A WooTalk-style anonymous chat: click 開始聊天 to be randomly paired with a stranger for a 1-on-1 text chat, with a typing indicator and leave/rematch.

No dependencies: a small Node server pushes events to the browser with Server-Sent Events, and the browser sends messages back with plain POSTs.

```bash
node server.mjs   # http://localhost:3000 (set PORT to change)
node test.mjs     # self-check
```

Matching state lives in memory, so run a single server instance. Before opening it to the public, add rate limiting, moderation/reporting, and HTTPS.
