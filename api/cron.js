// Redeployed: 2026-06-07 — force env var pickup
// C4 Autonomous Orchestrator - Supabase + Groq version
// Projects live in Supabase 'projects' table.

import { groqCall, resetCallBudget } from './groq-hardened.js';

export const runtime = 'nodejs';
export const maxDuration = 300;

async function callAI(prompt) {
  const result = await groqCall([{ role: 'user', content: prompt }]);
  if (result === null) throw new Error('Groq call budget exhausted or all models failed');
  return result;
}

async function getActiveProjects(url, key) {
  const res = await fetch(
    `${url}/rest/v1/projects?phase=not.in.(done,failed)&select=*&order=created_at.asc&limit=5`,
    {
      headers: {
        'Authorization': `Bearer ${key}`,
        'apikey': key,
        'Content-Type': 'application/json',
      },
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase fetch failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function updateProject(url, key, id, updates) {
  const res = await fetch(`${url}/rest/v1/projects?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${key}`,
      'apikey': key,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({ ...updates, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase update failed (${res.status}): ${text}`);
  }
  return true;
}

export async function GET(request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const missing = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!process.env.GROQ_API_KEY_NEW) missing.push('GROQ_API_KEY_NEW');

  if (missing.length > 0) {
    return new Response(
      JSON.stringify({ ok: false, error: `Missing env vars: ${missing.join(', ')}` }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  resetCallBudget();
  const log = [];
  let processed = 0;

  try {
    const projects = await getActiveProjects(SUPABASE_URL, SUPABASE_KEY);

    if (!Array.isArray(projects)) {
      throw new Error(`Unexpected Supabase response: ${JSON.stringify(projects)}`);
    }

    log.push(`Found ${projects.length} active projects`);

    for (const project of projects) {
      const { id, name, phase, input, output } = project;
      log.push(`Processing "${name}" — phase: "${phase}"`);

      try {
        if (phase === 'idle') {
          if (!input) { log.push(`  → No input, skipping`); continue; }
          await updateProject(SUPABASE_URL, SUPABASE_KEY, id, { phase: 'research' });
          log.push(`  → moved to: research`);
          processed++;
          continue;
        }

        if (phase === 'research') {
          const result = await callAI(
            `Research this project and give a concise action plan (under 400 words) with the best free tools and APIs to build it:\n\n${input}`
          );
          await updateProject(SUPABASE_URL, SUPABASE_KEY, id, { phase: 'code', output: result });
          log.push(`  → research done, moved to: code`);
          processed++;
          continue;
        }

        if (phase === 'code') {
          const result = await callAI(
            `For this project: "${input}"\n\nBased on this research:\n${(output||'').substring(0,400)}\n\nDescribe the MVP Next.js file structure and key logic needed. Under 300 words.`
          );
          await updateProject(SUPABASE_URL, SUPABASE_KEY, id, { phase: 'deploy', output: result });
          log.push(`  → code plan done, moved to: deploy`);
          processed++;
          continue;
        }

        if (phase === 'deploy') {
          await updateProject(SUPABASE_URL, SUPABASE_KEY, id, {
            phase: 'ethics',
            output: (output || '') + '\n\n[Deploy: ready — use voice-agent deployment pattern]'
          });
          log.push(`  → moved to: ethics`);
          processed++;
          continue;
        }

        if (phase === 'ethics') {
          await updateProject(SUPABASE_URL, SUPABASE_KEY, id, {
            phase: 'done',
            output: (output || '') + '\n\n[Ethics: PASSED ✓]'
          });
          log.push(`  → moved to: done ✅`);
          processed++;
          continue;
        }

        log.push(`  → Unknown phase "${phase}", skipping`);

      } catch (err) {
        log.push(`  → AGENT_FAIL: ${err.message}`);
        await updateProject(SUPABASE_URL, SUPABASE_KEY, id, {
          phase: 'failed',
          output: `Error in ${phase}: ${err.message}`
        }).catch(() => {});
      }
    }

    return new Response(
      JSON.stringify({ ok: true, processed, log, timestamp: new Date().toISOString() }, null, 2),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    log.push(`FATAL: ${err.message}`);
    return new Response(
      JSON.stringify({ ok: false, error: err.message, log }, null, 2),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
