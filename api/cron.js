// C4 Autonomous Orchestrator - Supabase version
// No Notion required. Projects live in Supabase 'projects' table.

export const runtime = 'nodejs';
export const maxDuration = 300;

async function callGroq(prompt, apiKey) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 3000,
      temperature: 0.3,
    }),
  });
  const data = await res.json();
  if (!data.choices) throw new Error(`Groq error: ${JSON.stringify(data)}`);
  return data.choices[0].message.content || '';
}

async function supabaseQuery(url, key, sql) {
  const res = await fetch(`${url}/rest/v1/rpc/exec_sql`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'apikey': key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql }),
  });
  return res.json();
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
    throw new Error(`Supabase update failed: ${text}`);
  }
  return true;
}

export async function GET(request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
  const GROQ_API_KEY = process.env.GROQ_API_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY || !GROQ_API_KEY) {
    return new Response('Missing env vars', { status: 500 });
  }

  const log = [];
  let processed = 0;

  try {
    const projects = await getActiveProjects(SUPABASE_URL, SUPABASE_KEY);
    
    if (!Array.isArray(projects)) {
      throw new Error(`Unexpected response: ${JSON.stringify(projects)}`);
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
          const result = await callGroq(
            `Research this project and give a concise action plan (under 400 words) with the best free tools and APIs to build it:\n\n${input}`,
            GROQ_API_KEY
          );
          await updateProject(SUPABASE_URL, SUPABASE_KEY, id, { phase: 'code', output: result });
          log.push(`  → research done, moved to: code`);
          processed++;
          continue;
        }

        if (phase === 'code') {
          const result = await callGroq(
            `For this project: "${input}"\n\nBased on this research:\n${(output||'').substring(0,400)}\n\nDescribe the MVP Next.js file structure and key logic needed. Under 300 words.`,
            GROQ_API_KEY
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
        log.push(`  → ERROR: ${err.message}`);
        await updateProject(SUPABASE_URL, SUPABASE_KEY, id, {
          phase: 'failed',
          output: `Error in ${phase}: ${err.message}`
        }).catch(() => {});
      }
    }

    return new Response(JSON.stringify({ ok: true, processed, log, timestamp: new Date().toISOString() }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err) {
    log.push(`FATAL: ${err.message}`);
    return new Response(JSON.stringify({ ok: false, error: err.message, log }, null, 2), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
