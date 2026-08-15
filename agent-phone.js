// Phone Agent — run this INSIDE Termux on your Android phone.
// Requires: Termux app + Termux:API app (both from F-Droid, not Play Store — the
// Play Store versions are outdated and don't talk to each other properly).
//
// One-time Termux setup:
//   pkg install nodejs
//   pkg install termux-api
//   termux-setup-storage      (grants access to your phone's shared storage)
//
// Then:
//   npm install                (in this folder, just needs node-fetch built-ins — none extra)
//   Set JARVIS_SERVER_URL and AGENT_SECRET in a .env file here (see .env.example)
//   node agent-phone.js

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import os from 'os';

const SERVER_URL = process.env.JARVIS_SERVER_URL;
const AGENT_SECRET = process.env.AGENT_SECRET;
const SAFE_ROOT = path.join(os.homedir(), 'storage', 'shared', 'JarvisFiles');

if (!SERVER_URL || !AGENT_SECRET) {
  console.error('❌ Missing JARVIS_SERVER_URL or AGENT_SECRET in .env. See .env.example.');
  process.exit(1);
}

await fs.mkdir(SAFE_ROOT, { recursive: true });
console.log(`🟢 Phone agent running.`);
console.log(`   Safe folder: ${SAFE_ROOT}`);
console.log(`   Polling: ${SERVER_URL}\n`);

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

function resolveSafePath(relativePath) {
  const resolved = path.resolve(SAFE_ROOT, relativePath || '.');
  if (!resolved.startsWith(SAFE_ROOT)) throw new Error('Path escapes the Jarvis Files folder — refused.');
  return resolved;
}

async function handleCommand(cmd) {
  const { type, args } = cmd;
  switch (type) {
    case 'read_clipboard':
      return await run('termux-clipboard-get');

    case 'write_clipboard': {
      const safeText = (args.text || '').replace(/"/g, '\\"');
      await run(`termux-clipboard-set "${safeText}"`);
      return 'Copied to clipboard.';
    }

    case 'read_notifications': {
      const raw = await run('termux-notification-list');
      const list = JSON.parse(raw);
      // Keep it short — just the last 10, title + text only.
      return list.slice(0, 10).map((n) => `${n.title || '(no title)'}: ${n.content || ''}`).join('\n') || '(no notifications)';
    }

    case 'phone_read_file': {
      const p = resolveSafePath(args.path);
      return await fs.readFile(p, 'utf8');
    }

    case 'phone_write_file': {
      const p = resolveSafePath(args.path);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, args.content, 'utf8');
      return `Wrote ${args.content.length} characters to ${args.path}`;
    }

    case 'phone_list_files': {
      const p = resolveSafePath(args.path || '.');
      const entries = await fs.readdir(p, { withFileTypes: true });
      return entries.map((e) => (e.isDirectory() ? e.name + '/' : e.name)).join(', ') || '(empty folder)';
    }

    default:
      throw new Error(`Unknown command type: ${type}`);
  }
}

async function pollLoop() {
  while (true) {
    try {
      const res = await fetch(`${SERVER_URL}/api/agent/poll?device=phone`, {
        headers: { 'x-agent-secret': AGENT_SECRET },
      });
      const data = await res.json();

      if (data.command) {
        const { id, type, args } = data.command;
        console.log(`→ ${type}`, args);
        let payload;
        try {
          const result = await handleCommand({ type, args });
          payload = { id, result };
        } catch (err) {
          payload = { id, error: err.message };
        }
        await fetch(`${SERVER_URL}/api/agent/result`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-agent-secret': AGENT_SECRET },
          body: JSON.stringify(payload),
        });
      }
    } catch (err) {
      console.error('Poll error:', err.message);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

pollLoop();
