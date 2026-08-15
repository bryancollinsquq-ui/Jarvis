import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('\n❌ Missing ANTHROPIC_API_KEY.');
  console.error('   Copy .env.example to .env and paste your real key in.\n');
  process.exit(1);
}

const hasOpenAI = !!process.env.OPENAI_API_KEY;
if (!hasOpenAI) {
  console.warn('⚠️  No OPENAI_API_KEY found — running Claude-only, no fallback model.');
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = hasOpenAI ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// This is where your assistant's personality lives. Edit freely.
const SYSTEM_PROMPT = `You are Jarvis, a sharp, efficient personal AI assistant.
Keep replies short and conversational (1-3 sentences) since they will be spoken out loud.
Be a little witty, but always genuinely helpful. Never pad your answers with filler.`;

// Simple in-memory conversation history (resets when the server restarts)
let conversationHistory = [];
const MAX_TURNS = 20;

// In-memory activity log + metrics for the dashboard (mock/local — not persisted)
let activityLog = [];
let metrics = {
  messagesToday: 0,
  claudeCalls: 0,
  gptFallbacks: 0,
  errors: 0,
  startedAt: new Date().toISOString(),
};

function logActivity(entry) {
  activityLog.unshift({ time: new Date().toISOString(), ...entry });
  if (activityLog.length > 50) activityLog = activityLog.slice(0, 50);
}

async function askClaude(history) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: history,
  });
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

async function askGPT(history) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 300,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
  });
  return response.choices[0].message.content;
}

app.post('/api/chat', async (req, res) => {
  const userMessage = (req.body.message || '').trim();
  if (!userMessage) {
    return res.status(400).json({ error: 'No message provided.' });
  }

  conversationHistory.push({ role: 'user', content: userMessage });
  if (conversationHistory.length > MAX_TURNS * 2) {
    conversationHistory = conversationHistory.slice(-MAX_TURNS * 2);
  }
  metrics.messagesToday += 1;

  let reply = null;
  let usedModel = null;

  // Try Claude first
  try {
    reply = await askClaude(conversationHistory);
    usedModel = 'claude';
    metrics.claudeCalls += 1;
  } catch (err) {
    console.error('Claude failed:', err.message);
    logActivity({ type: 'error', text: `Claude call failed: ${err.message}` });

    // Fall back to GPT if available
    if (hasOpenAI) {
      try {
        reply = await askGPT(conversationHistory);
        usedModel = 'gpt';
        metrics.gptFallbacks += 1;
        logActivity({ type: 'fallback', text: 'Fell back to GPT-4o successfully.' });
      } catch (err2) {
        console.error('GPT fallback also failed:', err2.message);
        metrics.errors += 1;
        logActivity({ type: 'error', text: `GPT fallback also failed: ${err2.message}` });
      }
    } else {
      metrics.errors += 1;
    }
  }

  if (!reply) {
    return res.status(500).json({ error: 'Both Claude and GPT failed to respond. Check your terminal for details.' });
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
  res.json({ metrics, hasOpenAI });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🟢 Jarvis is running: http://localhost:${PORT}`);
  console.log(hasOpenAI ? '   Models: Claude (primary) + GPT-4o (fallback)\n' : '   Models: Claude only\n');
});
