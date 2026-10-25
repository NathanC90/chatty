# Chatty

A small anonymous 1-on-1 chat in the spirit of [WooTalk 吾聊](https://wootalk.today), made for chatting with a friend without losing the conversation every time the connection drops. Runs free on Cloudflare Workers.

## What it does

- **Matching**: 開始聊天 pairs you with the next person waiting. With a **密語** (secret word) you only meet someone who typed the same word. A link like `/key/秘密` fills it in for you.
- **The conversation survives everything except 離開**: network drops, reloads, closing the tab, rebooting, and redeploys. Your browser keeps a cookie that identifies you, and every message is stored in Cloudflare (a Durable Object's database). A dropped connection retries every 1.5 seconds and fetches only what it missed.
- **Messages typed while offline aren't lost**: they show as 傳送中… and go out automatically once the connection is back, even after a reload.
- **On another device**: 設定 → 在其他裝置繼續這段對話 copies a link that opens the same conversation in another browser. Use it if you switch phones, or before clearing cookies or using private browsing (these lose the cookie, just like on WooTalk).
- Text with clickable links, and images (picker or paste; shrunk to 1280 px before upload). Tapping an image opens it full screen over the chat, with a download button; ✕, Esc, a tap beside it or the phone's back button return to the chat.
- **Voice messages** up to 1 minute: tap the mic and a recording bar replaces the text box, with a timer, a live level meter, 🗑 to discard and a send button (Enter / Esc on a computer). The timer turns red for the last 10 seconds, and the clip sends itself at 1:00.
- **Emoji reactions**: long-press a message on a phone, or hover / right-click it on a computer. A row of 7 quick emoji (😘 😡 👍 ❤️ 🤮 😂 🙈 to start) plus **+**, which opens about 200 more or takes any emoji typed on the keyboard (flags, skin tones…). Ones picked there move to the front of your quick row, like WhatsApp. One reaction per person per message; tap yours again to remove it.
- The same menu offers **回覆** (reply: the answer shows the quoted message above it; tap the quote to jump to the original), **複製** (copy text) and, on your own messages, **收回** (unsend: the content, including any photo or voice clip, is deleted for both of you and replaced by 「…已收回一則訊息」).
- **🚨 Chatty police** (a joke between friends): the same menu's 🚨 檢舉 lets you charge a message with a silly crime (冷笑話, 太肉麻, …) or one you write. Both screens get a short scene: red and blue beacon light over a blurred chat, a citation card with the charge and a random penalty from the judge (罰請珍奶, 罰唱一句歌, …), a stamp slamming down (with a siren and thud if sounds are on, and a buzz on Android phones; iPhone browsers can't vibrate), then the card flies onto the message as a ticket. The accused can appeal once: the court deliberates for a moment, then 上訴駁回 or 無罪釋放 with confetti. A tap skips the scene, and it's toned down for people who turn off animations. Reporting your own message is 🙋 自首, with a lighter sentence.
- **Names**: 設定 → 名字 sets what you call the other person and what they see you as, for this chat only (up to 12 characters; blank means 陌生人). It replaces 陌生人 / 對方 in the header, the typing indicator, replies and notices, for both of you, and is kept on the server.
- **The other person's status** next to their name: 🟢 線上 while they're using the page; 🟠 待機 after 10 minutes without activity, or when they switch to another tab on a computer; ⚪ 已離線 when they close the page or put their phone on the home screen. Sending, typing or reacting shows them as 線上 straight away. If a phone loses signal without closing anything, it shows 已離線 within about 4 minutes (browsers slow background tabs' timers, so a quieter limit would wrongly mark them offline).
- 對方正在輸入… typing indicator, 已送出 / 已送達 (delivered to their device, not "read").
- Times, 今日 / 昨日 date dividers, and 載入更早的訊息 for long histories.
- Sound alert for new messages (toggle in 設定), and an unread count in the tab title.
- 離開 always asks for confirmation first: one tap on 離開對話, nothing to type. The other person sees 對方已離開 and can 回報 (report) or leave too, which also asks first, since the chat is then deleted for good.
- Light and dark mode, phone-friendly.

## Deploying (free)

You need [Node.js](https://nodejs.org) (the LTS version) on your computer, and a free Cloudflare account. No credit card is needed.

1. Sign up at <https://dash.cloudflare.com/sign-up> and confirm your email.
2. Get the code and its tools:
   ```bash
   git clone https://github.com/NathanC90/chatty.git
   cd chatty
   npm install
   ```
3. Log in. This opens your browser so you can allow access:
   ```bash
   npx wrangler login
   ```
4. Deploy:
   ```bash
   npm run deploy
   ```
   The first time, it may ask you to pick a `workers.dev` subdomain. When it finishes it prints your address, such as `https://chatty.<your-subdomain>.workers.dev`.
5. Send your friend `https://chatty.<your-subdomain>.workers.dev/key/<your secret word>` and open the same link yourself.

To update later: `git pull`, then `npm run deploy`. Redeploying keeps all conversations.

### Staying free

On the free plan, going over a limit makes requests fail until the daily reset (00:00 UTC). You are never charged. Two people chatting use a tiny fraction of the allowance (about 100,000 requests per day).

The database also has a daily cap on rows read (about 5 million). Every lookup uses an index, so an action reads a handful of rows however long the chat gets: sending a message reads about 10, opening the chat about 110. (Before that fix, each action re-read the whole chat and a long chat hit the cap within a day.) If a limit is ever hit, the page says so instead of going blank and retries more and more slowly, up to every 30 seconds, until the reset.

Storage is the one limit you could reach. Cloudflare's docs mention 5 GB per account but also 1 GB per Durable Object on the free plan, and Chatty keeps everything in one, so it assumes 1 GB: roughly 3,000–5,000 photos. 設定 shows how much is used. With 20% or less left, a banner suggests re-pairing (both press 離開, then meet again with the same 密語; the current chat is deleted), with a 重新配對 button that opens the usual leave confirmation. From 90%, each new upload first deletes the oldest photos and voice clips (down to 80%). Their messages stay and show 圖片已過期 / 語音已過期; text and reactions are never deleted.

## Security

- **No secrets in the code.** Chatty uses no API keys. Cloudflare deploys it with its own GitHub connection, so nothing needs to be stored in this repository.
- **Your identity is a cookie** (HttpOnly, Secure, SameSite=Lax). The 在其他裝置繼續 link carries it, so treat that link like a password. Opening such a link asks for confirmation before switching, so nobody can log your browser out of your chat by sending you their link.
- **Only Chatty's own page can act:** state-changing requests and the live connection from other sites are refused (checked with Sec-Fetch-Site / Origin).
- **Pages send security headers:** a Content-Security-Policy (own code only, no framing), X-Frame-Options DENY, Referrer-Policy same-origin (a `/key/密語` address never leaks to other sites), and Permissions-Policy (microphone only).
- **Optional lock.** By default anyone who finds the address can start a chat and use your free allowance. To allow only your own 密語: Cloudflare dashboard → Workers & Pages → chatty → Settings → Variables and Secrets → add a **Secret** named `ALLOWED_KEYS` with your 密語 (several can be separated by commas). Others then see 「這個聊天室只限受邀的人使用」. Existing chats are unaffected.
- **Not end-to-end encrypted:** messages are encrypted in transit (HTTPS) and stored in your Cloudflare account, where Cloudflare could technically read them.

## Developing

```bash
npm run dev    # local copy at http://localhost:8787 (data kept in .wrangler/)
npm test       # self-check: runs the Worker locally and restarts it mid-chat
```

- `public/index.html`: the whole page.
- `src/worker.js`: the Worker plus the Durable Object holding users, chats, messages, uploads and reports.
- `wrangler.toml`: Cloudflare configuration.

When both people have left a chat, its messages and uploads are deleted. Reports are saved in the Durable Object's `reports` table; there's no screen for reading them.

There's no rate limiting or moderation; it's built for a couple of people who know each other, not a public site.

## Not carried over from WooTalk

- Preset 密語 buttons (台南, 大叔大姐, …).
- The Facebook/fan-page links, the help/contact menu, and the Android app.
