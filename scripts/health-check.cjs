'use strict';

/**
 * IdeaForge Health Check
 * Run: node scripts/health-check.cjs [--port 3333]
 */

const port = process.argv.includes('--port')
  ? process.argv[process.argv.indexOf('--port') + 1]
  : '3333';

const fs = require('fs');
const path = require('path');

const pass = (msg) => console.log(`  ✅ ${msg}`);
const fail = (msg) => console.log(`  ❌ ${msg}`);
const warn = (msg) => console.log(`  ⚠️  ${msg}`);
const section = (msg) => console.log(`\n${msg}`);

async function run() {
  console.log('🔍 IdeaForge Health Check\n');

  // 1. Node version
  section('[ Node.js ]');
  const [major] = process.versions.node.split('.').map(Number);
  if (major >= 18) pass(`Node.js ${process.version}`);
  else fail(`Node.js ${process.version} — need 18+`);

  // 2. Env keys
  section('[ Environment ]');
  const env = {};
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.+)$/);
      if (m) env[m[1]] = m[2].trim();
    }
  }
  const openaiKey = env.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const anthropicKey = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  const geminiKey = env.GEMINI_API_KEY || process.env.GEMINI_API_KEY;

  if (openaiKey) pass(`OPENAI_API_KEY set (${openaiKey.slice(0, 12)}...)`);
  else fail('OPENAI_API_KEY not set — required for images + audio');

  if (anthropicKey) pass(`ANTHROPIC_API_KEY set — Claude will handle concept extraction`);
  else warn('ANTHROPIC_API_KEY not set — falling back to GPT-4o-mini (fine)');

  if (geminiKey) pass('GEMINI_API_KEY set — Gemini image fallback available');
  else warn('GEMINI_API_KEY not set — Gemini fallback disabled (fine)');

  // 3. OpenAI API reachable
  section('[ OpenAI API ]');
  if (openaiKey) {
    try {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${openaiKey}` },
      });
      if (res.ok) pass('OpenAI API reachable + key valid');
      else fail(`OpenAI API returned ${res.status} — check your key`);
    } catch (e) {
      fail(`OpenAI API unreachable — ${e.message}`);
    }
  } else {
    fail('Skipped — no key');
  }

  // 4. Server running
  section(`[ Server (port ${port}) ]`);
  try {
    const res = await fetch(`http://localhost:${port}/api/status`);
    if (res.ok) {
      const data = await res.json();
      pass(`Server running — ${data.clients} client(s) connected`);
      if (data.hasAudioHandler) pass('Audio handler registered');
      else warn('No audio handler — start a session first');
    } else {
      fail(`Server returned ${res.status}`);
    }
  } catch {
    fail(`Server not running on port ${port} — start it first`);
  }

  // 5. Board state
  section('[ Board ]');
  try {
    const res = await fetch(`http://localhost:${port}/api/board`);
    if (res.ok) {
      const board = await res.json();
      const elements = (board.sections || []).reduce((n, s) => n + (s.elements || []).length, 0);
      pass(`Board loaded: "${board.title}"`);
      pass(`${board.sections?.length || 0} section(s), ${elements} element(s)`);
    } else {
      warn('Board endpoint returned error');
    }
  } catch {
    warn('Could not reach board endpoint');
  }

  // 6. Network interfaces
  section('[ Network ]');
  const os = require('os');
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter(n => n.family === 'IPv4' && !n.internal)
    .map(n => n.address);
  if (ips.length) {
    ips.forEach(ip => pass(`Accessible at http://${ip}:${port}`));
  } else {
    warn('No external network interfaces found');
  }

  console.log('\n');
}

run().catch(e => { console.error(e); process.exit(1); });
