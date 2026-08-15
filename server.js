import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const hasGemini = !!process.env.GEMINI_API_KEY;
const hasClaude = !!process.env.ANTHROPIC_API_KEY;
const hasOpenAI = !!process.env.OPENAI_API_KEY;

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const AGENT_SECRET = process.env.AGENT_SECRET;

if (!hasGemini) {
  console.error('\n❌ Missing GEMINI_API_KEY. Copy .env.example to .env and fill it in.\n');
  process.exit(1);
}
if (!DASHBOARD_PASSWORD || !SESSION_SECRET) {
  console.error('\n❌ Missing DASHBOARD_PASSWORD or SESSION_SECRET.');
  console.error('   This app is public now — it MUST be password protected.');
  console.error('   Set both in your .env (see .env.example).\n');
  process.exit(1);
}
if (!AGENT_SECRET) {
  console.warn('⚠️  No AGENT_SECRET set — laptop/phone tool access will be disabled.');
}

// ---------- Auth (simple signed-cookie session, no extra deps) ----------
function signToken(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('hex');
  return `${data}.${sig}`;
}
function verifyToken(token) {
  try {
    const [data, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('hex');
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  const found = header.split(';').map((c) => c.trim()).find((c) => c.startsWith(name + '='));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : null;
}
function requireAuth(req, res, next) {
  const token = getCookie(req, 'jarvis_auth');
  const payload = token && verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Not authenticated.' });
  next();
}
function requireAgentAuth(req, res, next) {
  if (!AGENT_SECRET || req.headers['x-agent-secret'] !== AGENT_SECRET) {
    return res.status(401).json({ error: 'Invalid agent secret.' });
  }
  next();
}

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password.' });
  }
  const token = signToken({ ok: true, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 });
  res.setHeader('Set-Cookie', `jarvis_auth=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax`);
  res.json({ ok: true });
});

app.get('/api/session-check', (req, res) => {
  const token = getCookie(req, 'jarvis_auth');
  res.json({ loggedIn: !!(token && verifyToken(token)) });
});

// This is where your assistant's personality lives. Edit freely.
const SYSTEM_PROMPT = `You are Jarvis, a sharp, efficient personal AI assistant.
Keep replies short and conversational (1-3 sentences) since they will be spoken out loud.
Be a little witty, but always genuinely helpful. Never pad your answers with filler.
You have tools that reach the user's real laptop and phone. Use them when the user's
request clearly calls for it. Never claim to have done something you didn't actually do —
always use the tool and report the real result.`;

let conversationHistory = [];
const MAX_TURNS = 20;

let activityLog = [];
let metrics = {
  messagesToday: 0,
  geminiCalls: 0,
  claudeFallbacks: 0,
  gptFallbacks: 0,
  errors: 0,
  toolCalls: 0,
  startedAt: new Date().toISOString(),
};

function logActivity(entry) {
  activityLog.unshift({ time: new Date().toISOString(), ...entry });
  if (activityLog.length > 50) activityLog = activityLog.slice(0, 50);
}

// ---------- Agent command bridge ----------
// Two device queues: laptop + phone. Each command waits (with a timeout) for the
// matching local agent to poll it up, execute it, and post the result back.
const queues = { laptop: [], phone: [] };
const pendingResults = new Map(); // id -> { resolve, reject, timeout }

function queueCommand(device, type, args) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    queues[device].push({ id, type, args });
    const timeout = setTimeout(() => {
      pendingResults.delete(id);
      reject(new Error(`Timed out waiting for the ${device} agent. Is it running?`));
    }, 25000);
    pendingResults.set(id, { resolve, reject, timeout });
  });
}

app.get('/api/agent/poll', requireAgentAuth, (req, res) => {
  const device = req.query.device;
  if (!queues[device]) return res.status(400).json({ error: 'Unknown device.' });
  const next = queues[device].shift();
  res.json({ command: next || null });
});

app.post('/api/agent/result', requireAgentAuth, (req, res) => {
  const { id, result, error } = req.body;
  const pending = pendingResults.get(id);
  if (!pending) return res.status(404).json({ error: 'Unknown command id.' });
  clearTimeout(pending.timeout);
  pendingResults.delete(id);
  if (error) pending.reject(new Error(error));
  else pending.resolve(result);
  res.json({ ok: true });
});

// ---------- Tool definitions given to Gemini ----------
const TOOLS = [{
  functionDeclarations: [
    {
      name: 'read_file',
      description: "Read a text file from the user's laptop, inside their designated Jarvis Files folder.",
      parameters: { type: 'OBJECT', properties: { path: { type: 'STRING', description: 'Relative path inside the Jarvis Files folder' } }, required: ['path'] },
    },
    {
      name: 'write_file',
      description: "Write or overwrite a text file on the user's laptop, inside their designated Jarvis Files folder.",
      parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' }, content: { type: 'STRING' } }, required: ['path', 'content'] },
    },
    {
      name: 'list_files',
      description: "List files inside a folder within the user's Jarvis Files folder on their laptop.",
      parameters: { type: 'OBJECT', properties: { path: { type: 'STRING', description: 'Relative subfolder, empty string for the root' } } },
    },
    {
      name: 'open_app',
      description: "Open a whitelisted application on the user's laptop. Only apps the user has pre-approved will work.",
      parameters: { type: 'OBJECT', properties: { app: { type: 'STRING', description: 'App name, e.g. notepad, calculator, vscode' } }, required: ['app'] },
    },
    {
      name: 'read_clipboard',
      description: "Read the current text on the user's phone clipboard.",
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'write_clipboard',
      description: "Copy text to the user's phone clipboard.",
      parameters: { type: 'OBJECT', properties: { text: { type: 'STRING' } }, required: ['text'] },
    },
    {
      name: 'read_notifications',
      description: "Read the user's recent phone notifications.",
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'phone_read_file',
      description: "Read a text file from the user's phone, inside their designated Jarvis Files folder.",
      parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' } }, required: ['path'] },
    },
    {
      name: 'phone_write_file',
      description: "Write a text file on the user's phone, inside their designated Jarvis Files folder.",
      parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' }, content: { type: 'STRING' } }, required: ['path', 'content'] },
    },
    {
      name: 'phone_list_files',
      description: "List files inside the user's Jarvis Files folder on their phone.",
      parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' } } },
    },
  ],
}];

const TOOL_DEVICE = {
  read_file: 'laptop', write_file: 'laptop', list_files: 'laptop', open_app: 'laptop',
  read_clipboard: 'phone', write_clipboard: 'phone', read_notifications: 'phone',
  phone_read_file: 'phone', phone_write_file: 'phone', phone_list_files: 'phone',
};

async function executeTool(name, args) {
  const device = TOOL_DEVICE[name];
  if (!device) throw new Error(`Unknown tool: ${name}`);
  if (!AGENT_SECRET) throw new Error('Agent bridge is not configured on the server.');
  metrics.toolCalls += 1;
  logActivity({ type: 'tool', text: `${name}(${JSON.stringify(args)}) → ${device} agent` });
  const result = await queueCommand(device, name, args);
  return result;
}

// ---------- Gemini with tool-calling loop ----------
async function askGemini(history) {
  let contents = history.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent`;

  for (let iteration = 0; iteration < 4; iteration++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        tools: AGENT_SECRET ? TOOLS : undefined,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    const functionCalls = parts.filter((p) => p.functionCall);

    if (functionCalls.length === 0) {
      const text = parts.map((p) => p.text).filter(Boolean).join('\n');
      if (!text) throw new Error('Gemini returned an empty response.');
      return text;
    }

    // Gemini wants to call one or more tools — run them, then continue the conversation.
    contents.push({ role: 'model', parts: functionCalls.map((p) => ({ functionCall: p.functionCall })) });

    const responseParts = [];
    for (const call of functionCalls) {
      let response;
      try {
        response = { result: await executeTool(call.functionCall.name, call.functionCall.args || {}) };
      } catch (err) {
        response = { error: err.message };
      }
      responseParts.push({ functionResponse: { name: call.functionCall.name, response } });
    }
    contents.push({ role: 'function', parts: responseParts });
  }

  throw new Error('Gemini kept calling tools without giving a final answer.');
}

async function askClaude(history) {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 300, system: SYSTEM_PROMPT, messages: history,
  });
  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

async function askGPT(history) {
  const OpenAI = (await import('openai')).default;
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await openai.chat.completions.create({
    model: 'gpt-4o', max_tokens: 300, messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
  });
  return response.choices[0].message.content;
}

app.post('/api/chat', requireAuth, async (req, res) => {
  const userMessage = (req.body.message || '').trim();
  if (!userMessage) return res.status(400).json({ error: 'No message provided.' });

  conversationHistory.push({ role: 'user', content: userMessage });
  if (conversationHistory.length > MAX_TURNS * 2) {
    conversationHistory = conversationHistory.slice(-MAX_TURNS * 2);
  }
  metrics.messagesToday += 1;

  let reply = null;
  let usedModel = null;

  try {
    reply = await askGemini(conversationHistory);
    usedModel = 'gemini';
    metrics.geminiCalls += 1;
  } catch (err) {
    console.error('Gemini failed:', err.message);
    logActivity({ type: 'error', text: `Gemini call failed: ${err.message}` });

    if (hasClaude) {
      try {
        reply = await askClaude(conversationHistory);
        usedModel = 'claude';
        metrics.claudeFallbacks += 1;
        logActivity({ type: 'fallback', text: 'Fell back to Claude successfully.' });
      } catch (err2) {
        logActivity({ type: 'error', text: `Claude fallback failed: ${err2.message}` });
      }
    }
    if (!reply && hasOpenAI) {
      try {
        reply = await askGPT(conversationHistory);
        usedModel = 'gpt';
        metrics.gptFallbacks += 1;
        logActivity({ type: 'fallback', text: 'Fell back to GPT-4o successfully.' });
      } catch (err3) {
        logActivity({ type: 'error', text: `GPT fallback failed: ${err3.message}` });
      }
    }
    if (!reply) metrics.errors += 1;
  }

  if (!reply) {
    return res.status(500).json({ error: 'All models failed to respond. Check the server logs.' });
  }

  conversationHistory.push({ role: 'assistant', content: reply });
  logActivity({ type: 'message', text: userMessage.slice(0, 80), model: usedModel });

  res.json({ reply, model: usedModel });
});

app.post('/api/reset', requireAuth, (req, res) => {
  conversationHistory = [];
  logActivity({ type: 'system', text: 'Conversation memory reset.' });
  res.json({ ok: true });
});

app.get('/api/activity', requireAuth, (req, res) => res.json({ activity: activityLog }));
app.get('/api/metrics', requireAuth, (req, res) => res.json({ metrics, hasGemini, hasClaude, hasOpenAI, hasAgentBridge: !!AGENT_SECRET }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🟢 Jarvis is running: http://localhost:${PORT}`);
  const extras = [hasClaude && 'Claude', hasOpenAI && 'GPT-4o'].filter(Boolean);
  console.log(`   Brain: Gemini (free)${extras.length ? ' + fallback: ' + extras.join(', ') : ''}`);
  console.log(`   Agent bridge: ${AGENT_SECRET ? 'ENABLED' : 'disabled (no AGENT_SECRET)'}\n`);
});
