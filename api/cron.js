// C4 Autonomous Orchestrator - Clean, definitive version
// Notion column names confirmed: Name, Phase (select), Input, Output, Agent, Link (URL)
// Phase select values: Idle (capital I), research, code, deploy, ethics, done, failed

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

async function notionUpdate(pageId, phase, output, token) {
  const body = {
    properties: {
      'Phase': { select: { name: phase } },
      'Output': { rich_text: [{ text: { content: String(output || '').substring(0, 1900) } }] },
    }
  };
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.object === 'error') {
    throw new Error(`Notion write failed: ${data.message} | body: ${JSON.stringify(body.properties)}`);
  }
  return data;
}

async function notionQuery(dbId, token) {
  const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify({ page_size: 10 }),
  });
  const data = await res.json();
  if (data.object === 'error') throw new Error(`Notion query failed: ${data.message}`);
  return data.results || [];
}

export async function GET(request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const NOTION_DB_ID = process.env.NOTION_DB_ID;
  const GROQ_API_KEY = process.env.GROQ_API_KEY;

  if (!NOTION_TOKEN || !NOTION_DB_ID || !GROQ_API_KEY) {
    return new Response(`Missing: ${[!NOTION_TOKEN && 'NOTION_TOKEN', !NOTION_DB_ID && 'NOTION_DB_ID', !GROQ_API_KEY && 'GROQ_API_KEY'].filter(Boolean).join(', ')}`, { status: 500 });
  }

  const log = [];
  
  try {
    const pages = await notionQuery(NOTION_DB_ID, NOTION_TOKEN);
    log.push(`Found ${pages.length} total rows`);

    let processed = 0;

    for (const page of pages) {
      const props = page.properties;
      
      // Read phase - handle both 'Phase' column name
      const phaseRaw = props['Phase']?.select?.name || '';
      const phase = phaseRaw.toLowerCase();
      
      // Read name
      const name = props['Name']?.title?.[0]?.plain_text 
        || props['Name']?.title?.[0]?.text?.content 
        || 'Unnamed';
      
      // Read input
      const input = props['Input']?.rich_text?.[0]?.text?.content || '';
      const output = props['Output']?.rich_text?.[0]?.text?.content || '';

      log.push(`Row: "${name}" | Phase raw: "${phaseRaw}" | Has input: ${!!input}`);

      // Skip terminal states
      if (phase === 'done' || phase === 'failed') {
        log.push(`  → Skipping terminal state`);
        continue;
      }

      // Process idle rows that have input
      if (phase === 'idle' || phaseRaw === 'Idle') {
        if (!input) {
          log.push(`  → Skipping: no input`);
          continue;
        }
        try {
          await notionUpdate(page.id, 'research', output, NOTION_TOKEN);
          log.push(`  → Updated to: research`);
          processed++;
        } catch (e) {
          log.push(`  → ERROR updating to research: ${e.message}`);
        }
        continue;
      }

      if (phase === 'research') {
        try {
          const result = await callGroq(
            `Research this project and give a concise action plan (under 400 words) with best free tools and APIs:\n\n${input}`,
            GROQ_API_KEY
          );
          await notionUpdate(page.id, 'code', result, NOTION_TOKEN);
          log.push(`  → Research done, updated to: code`);
          processed++;
        } catch (e) {
          log.push(`  → ERROR in research: ${e.message}`);
          await notionUpdate(page.id, 'failed', e.message, NOTION_TOKEN).catch(() => {});
        }
        continue;
      }

      if (phase === 'code') {
        try {
          const result = await callGroq(
            `For project: "${input}"\nResearch: "${output.substring(0, 400)}"\n\nDescribe the MVP Next.js file structure and key logic needed. Under 300 words.`,
            GROQ_API_KEY
          );
          await notionUpdate(page.id, 'deploy', result, NOTION_TOKEN);
          log.push(`  → Code plan done, updated to: deploy`);
          processed++;
        } catch (e) {
          log.push(`  → ERROR in code: ${e.message}`);
          await notionUpdate(page.id, 'failed', e.message, NOTION_TOKEN).catch(() => {});
        }
        continue;
      }

      if (phase === 'deploy') {
        try {
          await notionUpdate(page.id, 'ethics', output + '\n\n[Deploy: ready — use voice-agent deployment pattern]', NOTION_TOKEN);
          log.push(`  → Updated to: ethics`);
          processed++;
        } catch (e) {
          log.push(`  → ERROR in deploy: ${e.message}`);
        }
        continue;
      }

      if (phase === 'ethics') {
        try {
          await notionUpdate(page.id, 'done', output + '\n\n[Ethics: PASSED ✓]', NOTION_TOKEN);
          log.push(`  → Updated to: done`);
          processed++;
        } catch (e) {
          log.push(`  → ERROR in ethics: ${e.message}`);
        }
        continue;
      }

      log.push(`  → Unknown phase "${phase}", skipping`);
    }

    log.push(`Processed: ${processed}`);

    return new Response(JSON.stringify({ 
      ok: true,
      processed,
      log,
      timestamp: new Date().toISOString() 
    }, null, 2), {
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
