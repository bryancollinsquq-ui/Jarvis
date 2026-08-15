// Laptop Agent — run this on your laptop (separate terminal, separate from the server).
// It reaches OUT to your cloud Jarvis (no firewall ports need opening) and executes
// whatever file/app commands Jarvis asks for, scoped to a safe folder + app whitelist.

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SERVER_URL = process.env.JARVIS_SERVER_URL; // e.g. https://jarvis-xxxx.onrender.com
const AGENT_SECRET = process.env.AGENT_SECRET;
const SAFE_ROOT = path.resolve(__dirname, process.env.JARVIS_SAFE_FOLDER || 'JarvisFiles');

if (!SERVER_URL || !AGENT_SECRET) {
  console.error('❌ Missing JARVIS_SERVER_URL or AGENT_SECRET in .env. See .env.example.');
  process.exit(1);
}

// Load the app whitelist — only apps listed here can ever be opened.
let appsWhitelist = {};
try {
  appsWhitelist = JSON.parse(await fs.readFile(path.join(__dirname, 'apps.json'), 'utf8'));
} catch {
  console.warn('⚠️  No apps.json found — open_app will refuse everything until you create one.');
}

await fs.mkdir(SAFE_ROOT, { recursive: true });
console.log(`🟢 Laptop agent running.`);
console.log(`   Safe folder: ${SAFE_ROOT}`);
console.log(`   Whitelisted apps: ${Object.keys(appsWhitelist).join(', ') || '(none configured)'}`);
console.log(`   Polling: ${SERVER_URL}\n`);

function resolveSafePath(relativePath) {
  const resolved = path.resolve(SAFE_ROOT, relativePath || '.');
  if (!resolved.startsWith(SAFE_ROOT)) {
    throw new Error('Path escapes the Jarvis Files folder — refused.');
  }
  return resolved;
}

async function handleCommand(cmd) {
  const { type, args } = cmd;
  switch (type) {
    case 'read_file': {
      const p = resolveSafePath(args.path);
      return await fs.readFile(p, 'utf8');
    }
    case 'write_file': {
      const p = resolveSafePath(args.path);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, args.content, 'utf8');
      return `Wrote ${args.content.length} characters to ${args.path}`;
    }
    case 'list_files': {
      const p = resolveSafePath(args.path || '.');
      const entries = await fs.readdir(p, { withFileTypes: true });
      return entries.map((e) => (e.isDirectory() ? e.name + '/' : e.name)).join(', ') || '(empty folder)';
    }
    case 'open_app': {
      const exePath = appsWhitelist[args.app?.toLowerCase()];
      if (!exePath) throw new Error(`"${args.app}" is not in your whitelist (apps.json). Add it first.`);
      return await new Promise((resolve, reject) => {
        exec(`start "" "${exePath}"`, (err) => {
          if (err) reject(err);
          else resolve(`Opened ${args.app}`);
        });
      });
    }
    default:
      throw new Error(`Unknown command type: ${type}`);
  }
}

async function pollLoop() {
  while (true) {
    try {
      const res = await fetch(`${SERVER_URL}/api/agent/poll?device=laptop`, {
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
