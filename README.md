# Jarvis — Voice Assistant with Laptop + Phone Bridge

Runs in the cloud (reachable from anywhere), powered by the free Gemini API,
now with a password-protected dashboard and optional "agent bridge" that lets
Jarvis read/write files and open apps on your real laptop, and read
clipboard/notifications/files on your real phone.

## Part 1 — The server (deploy this to Render, as before)

1. `npm install`
2. Copy `.env.example` to `.env`. Fill in:
   - `GEMINI_API_KEY` — required, free, from https://aistudio.google.com/apikey
   - `DASHBOARD_PASSWORD` — **required now**. Pick a real password — this is
     what locks your public URL so strangers can't use it.
   - `SESSION_SECRET` — any long random string (mash your keyboard, 40+ characters).
   - `AGENT_SECRET` — a **different** long random string. This is what lets your
     laptop/phone agents talk to the server. Never share it, never put it in
     the browser, never commit it to GitHub.
3. Push these env vars to Render's Environment Variables settings (same as
   before) — never commit your real `.env` to GitHub.
4. Deploy as usual. Opening your URL will now show a password screen first.

## Part 2 — The laptop agent (run this on your actual laptop, separately)

This is a second, independent script — it does NOT run on Render. It runs on
your laptop and reaches out to your Render server.

1. In the same project folder, on your laptop:
   ```
   npm install
   ```
2. Edit `apps.json` — add any apps you want Jarvis allowed to open. Format:
   ```json
   { "notepad": "notepad.exe", "vscode": "C:\\path\\to\\Code.exe" }
   ```
   Only apps listed here can ever be opened — this is your safety whitelist.
3. In `.env` on your laptop, add:
   ```
   JARVIS_SERVER_URL=https://your-app.onrender.com
   AGENT_SECRET=(the exact same value you set on Render)
   ```
4. Run it:
   ```
   npm run agent:laptop
   ```
   Leave this terminal running whenever you want Jarvis to have laptop access.
   Closing it just disables laptop tools — chat still works fine without it.
5. A `JarvisFiles` folder is created automatically next to the project —
   that's the ONLY folder Jarvis can read/write on your laptop.

## Part 3 — The phone agent (runs inside Termux on Android)

Your phone can't run a background agent like a laptop can — Android sandboxes
apps for your safety. Termux is a terminal app that gets around this in a
controlled way, one permission at a time.

1. Install **Termux** and **Termux:API** — get both from **F-Droid**, not the
   Play Store (the Play Store versions are outdated and don't work together).
2. Inside Termux:
   ```
   pkg install nodejs termux-api
   termux-setup-storage
   ```
   (This last command will prompt for storage permission — allow it.)
3. Get the project files onto your phone (easiest: `git clone` your GitHub
   repo inside Termux, or use Termux's file access to copy them over).
4. Create a `.env` file next to `agent-phone.js`:
   ```
   JARVIS_SERVER_URL=https://your-app.onrender.com
   AGENT_SECRET=(the exact same value you set on Render)
   ```
5. Run it:
   ```
   node agent-phone.js
   ```
   Leave Termux running in the background (Android may kill it if you're
   aggressive about battery optimization — exclude Termux from battery
   optimization in Android settings if it keeps stopping).
6. A `JarvisFiles` folder appears in your phone's normal shared storage —
   that's the only folder Jarvis can touch on your phone.

## What Jarvis can now do

Once both agents are running, just ask naturally:
- "Read my notes.txt file" / "Save this as todo.txt: ..."
- "What's on my clipboard?" / "Copy this to my clipboard: ..."
- "What notifications do I have?"
- "Open notepad" (or any app you added to apps.json)

If an agent isn't running, Jarvis will tell you it timed out waiting — that's
expected, just start the relevant agent.

## Security notes (please actually read this)

- `AGENT_SECRET` is as sensitive as a password to your computer. Never paste
  it into a chat, screenshot, or public repo.
- File access is hard-limited to the `JarvisFiles` folder on each device —
  even if Jarvis tried to escape that folder, the agent code refuses.
- App launching only works for apps you've explicitly whitelisted in
  `apps.json` — Jarvis cannot run arbitrary commands.
- If you ever suspect a secret leaked, change `AGENT_SECRET` and
  `SESSION_SECRET` in both Render's settings and your local `.env` files.

## Troubleshooting

- **Login screen won't accept my password** — check for typos in `DASHBOARD_PASSWORD`
  on Render vs. what you're typing; they must match exactly.
- **"Timed out waiting for the laptop agent"** — the agent script isn't running,
  or `AGENT_SECRET` doesn't match between server and agent.
- **Termux commands not found** — make sure you installed `termux-api` (the
  package) AND the separate Termux:API app from F-Droid; both are required.
