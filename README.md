# Activity Logger

Reminds you at a set interval (default: every 10 minutes) during the time
frames you choose, even when the app is closed. It asks what you're doing and
logs each answer with when you were asked and when you answered.

There are two parts:

- **The app** (`index.html`, `sw.js`, `manifest.webmanifest`): an
  installable web app served by GitHub Pages.
- **The reminder server** (`worker/`): a Cloudflare Worker (free tier) that
  checks the schedule every minute, sends push notifications and stores the log.

## Using it on iPhone

1. Open the GitHub Pages address in Safari.
2. Tap **Share → Add to Home Screen**, then open **Activity** from the Home Screen.
3. Enter the server address and app key, then tap **Turn on reminders**.
4. When a reminder arrives, tap it: the app opens on the answer box.

iOS 16.4 or later is needed for web app notifications.

## How it behaves

- Reminders land on the interval from each time frame's start (09:00, 09:10, …),
  in your phone's time zone.
- A question stays open until you answer. If the next reminder arrives first,
  the unanswered one is logged as **Missed**.
- **Ask me now** sends a reminder immediately. **Export CSV** downloads the log.
- The log is kept on the server, so every device you connect sees the same one.

## Setting up the reminder server

Needs a free Cloudflare account and Node.js 20+.

```sh
cd worker
npm install
npx wrangler login
npm run vapid                              # prints two keys
npx wrangler secret put VAPID_PUBLIC_KEY   # paste the first
npx wrangler secret put VAPID_PRIVATE_KEY  # paste the second
npx wrangler secret put APP_KEY            # choose a long password for the app
npx wrangler deploy                        # prints the server address
```

Put the printed address in `config.js` (or type it into the app's Connect
screen).

## Development

```sh
cd worker
npm test        # unit tests: push encryption, VAPID, schedule, full flow
npm run dev     # local server; needs a .dev.vars file with the secrets above
```
