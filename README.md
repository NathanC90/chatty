# Chatty

A small anonymous 1-on-1 chat in the spirit of [WooTalk 吾聊](https://wootalk.today), made for chatting with a friend without losing the conversation every time the connection drops.

## What it does

- **Matching**: 開始聊天 pairs you with the next person waiting. With a **密語** (secret word) you only meet someone who typed the same word. A link like `/key/秘密` fills it in for you.
- **The conversation survives everything except 離開**: network drops, reloads, closing the tab, rebooting, and server restarts. Your browser keeps a cookie that identifies you, and the server saves every message to disk. A dropped connection retries every 1.5 seconds and fetches only what it missed.
- **Messages typed while offline aren't lost**: they show as 傳送中… and go out automatically once the connection is back, even after a reload.
- **On another device**: 設定 → 在其他裝置繼續這段對話 copies a link that opens the same conversation in another browser. Use it if you switch phones, or before clearing cookies or using private browsing (these lose the cookie, just like on WooTalk).
- Text with clickable links, images (picker or paste), and voice messages.
- 對方正在輸入… typing indicator, 已送出 / 已送達 (delivered to their device, not "read").
- Times, 今日 / 昨日 date dividers, and 載入更早的訊息 for long histories.
- Sound alert for new messages (toggle in 設定), and an unread count in the tab title.
- 離開 asks for confirmation. After 100+ messages you have to type `leave`, so a long chat can't be ended by accident. The other person sees 對方已離開 and can 回報 (report) or start over.
- Light and dark mode, phone-friendly.

## Running it

Needs only Node.js 18 or newer, with no packages to install.

```bash
node server.mjs   # http://localhost:3000 (PORT=8080 to change)
node test.mjs     # self-check (includes killing and restarting the server mid-chat)
```

Everything is stored in `data/`: `state.json` holds users and conversations, `uploads/` holds images and voice clips, and `reports.jsonl` holds reports. Back up that folder to keep your history. When both people have left a chat, the chat and its uploads are deleted.

## Putting it online for you and a friend

Your friend needs to reach the server, so run it somewhere public: a small VPS, or your own computer behind a tunnel such as `cloudflared tunnel --url http://localhost:3000`. Use HTTPS. Browsers only allow the microphone (voice messages) on HTTPS or `localhost`. Run a single server process, since state is kept in that one process.

There's no rate limiting or moderation; it's built for a couple of people who know each other, not a public site.

## Not carried over from WooTalk

- Preset 密語 buttons (台南, 大叔大姐, …).
- The Facebook/fan-page links, the help/contact menu, and the Android app.
- Report review: reports are just written to `data/reports.jsonl`.
