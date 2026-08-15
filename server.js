import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const hasGemini = !!process.env.GEMINI_API_KEY;
const hasClaude = !!process.env.ANTHROPIC_API_KEY;
const hasOpenAI = !!process.env.OPENAI_API_KEY;

if (!hasGemini) {
  console.error('\n❌ Missing GEMINI_API_KEY.');
  console.error('   Copy .env.example to .env and paste your free Gemini key in.');
  console.error('   Get one at https://aistudio.google.com/apikey\n');
  process.exit(1);
}

// This is where your assistant's personality lives. Edit freely.
const SYSTEM_PROMPT = `You are Jarvis, a sharp, efficient personal AI assistant.
Keep replies short and conversational (1-3 sentences) since they will be spoken out loud.
Be a little witty, but always genuinely helpful. Never pad your answers with filler.`;

// Simple in-memory conversation history (resets when the server restarts)
let conversationHistory = [];
const MAX_TURNS = 20;

// In-memory activity log + metrics for the dashboard (not persisted)
let activityLog = [];
let metrics = {
  messagesToday: 0,
  geminiCalls: 0,
  claudeFallbacks: 0,
  gptFallbacks: 0,
  errors: 0,
  startedAt: new Date().toISOString(),
};

function logActivity(entry) {
  activityLog.unshift({ time: new Date().toISOString(), ...entry });
  if (activityLog.length > 50) activityLog = activityLog.slice(0, 50);
}

// ---------- Gemini (free, primary) ----------
async function askGemini(history) {
  const contents = history.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('\n');
  if (!text) throw new Error('Gemini returned an empty response.');
  return text;
}

// ---------- Claude (optional paid fallback) ----------
async function askClaude(history) {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: history,
  });
  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

// ---------- GPT (optional paid fallback) ----------
async function askGPT(history) {
  const OpenAI = (await import('openai')).default;
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 300,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
  });
  return response.choices[0].message.content;
}

app.post('/api/chat', async (req, res) => {
  const userMessage = (req.body.message || '').trim();
  if (!userMessage) return res.status(400).json({ error: 'No message provided.' });

  conversationHistory.push({ role: 'user', content: userMessage });
  if (conversationHistory.length > MAX_TURNS * 2) {
    conversationHistory = conversationHistory.slice(-MAX_TURNS * 2);
  }
  metrics.messagesToday += 1;

  let reply = null;
  let usedModel = null;

  // 1. Try Gemini (free)
  try {
    reply = await askGemini(conversationHistory);
    usedModel = 'gemini';
    metrics.geminiCalls += 1;
  } catch (err) {
    const detail = err.cause ? `${err.message} (cause: ${err.cause.message || err.cause})` : err.message;
    console.error('Gemini failed:', detail);
    logActivity({ type: 'error', text: `Gemini call failed: ${detail}` });

    // 2. Fall back to Claude if configured
    if (hasClaude) {
      try {
        reply = await askClaude(conversationHistory);
        usedModel = 'claude';
        metrics.claudeFallbacks += 1;
        logActivity({ type: 'fallback', text: 'Fell back to Claude successfully.' });
      } catch (err2) {
        console.error('Claude fallback failed:', err2.message);
        logActivity({ type: 'error', text: `Claude fallback failed: ${err2.message}` });
      }
    }

    // 3. Fall back to GPT if still no reply and configured
    if (!reply && hasOpenAI) {
      try {
        reply = await askGPT(conversationHistory);
        usedModel = 'gpt';
        metrics.gptFallbacks += 1;
        logActivity({ type: 'fallback', text: 'Fell back to GPT-4o successfully.' });
      } catch (err3) {
        console.error('GPT fallback failed:', err3.message);
        logActivity({ type: 'error', text: `GPT fallback failed: ${err3.message}` });
      }
    }

    if (!reply) metrics.errors += 1;
  }

  if (!reply) {
    return res.status(500).json({ error: 'Gemini failed and no working fallback is configured. Check your terminal for details.' });
  }

  conversationHistory.push({ role: 'assistant', content: reply });
  logActivity({ type: 'message', text: userMessage.slice(0, 80), model: usedModel });

  res.json({ reply, model: usedModel });
});

app.post('/api/reset', (req, res) => {
  conversationHistory = [];
  logActivity({ type: 'system', text: 'Conversation memory reset.' });
  res.json({ ok: true });
});

app.get('/api/activity', (req, res) => {
  res.json({ activity: activityLog });
});

app.get('/api/metrics', (req, res) => {
  res.json({ metrics, hasGemini, hasClaude, hasOpenAI });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🟢 Jarvis is running: http://localhost:${PORT}`);
  const extras = [hasClaude && 'Claude', hasOpenAI && 'GPT-4o'].filter(Boolean);
  console.log(`   Brain: Gemini (free)${extras.length ? ' + fallback: ' + extras.join(', ') : ''}\n`);
});
