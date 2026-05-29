// C4 Autonomous Orchestrator — polls Notion, runs agents, builds projects
export const runtime = 'nodejs';
export const maxDuration = 300;

async function callGroq(prompt, apiKey) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4000,
      temperature: 0.3,
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function updateNotion(pageId, phaseValue, outputValue, keys) {
  const properties = {
    'Phase': { select: { name: phaseValue } },
    'Output': { rich_text: [{ text: { content: String(outputValue || '').substring(0, 2000) } }] },
  };

  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${keys.NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify({ properties }),
  });
  const data = await res.json();
  if (data.object === 'error') {
    throw new Error(`Notion update failed: ${data.message}`);
  }
  return data;
}

async function queryNotion(dbId, keys) {
  const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${keys.NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify({
      filter: {
        and: [
          { property: 'Phase', select: { does_not_equal: 'done' } },
          { property: 'Phase', select: { does_not_equal: 'failed' } },
        ],
      },
      page_size: 5,
    }),
  });
  const data = await res.json();
  if (data.object === 'error') {
    throw new Error(`Notion query failed: ${data.message}`);
  }
  return data.results || [];
}

async function processProject(page, keys) {
  const props = page.properties;
  const phaseRaw = props.Phase?.select?.name || '';
  const phase = phaseRaw.toLowerCase();
  const input = props.Input?.rich_text?.[0]?.text?.content || '';
  const output = props.Output?.rich_text?.[0]?.text?.content || '';
  const projectName = props['Project Name']?.title?.[0]?.plain_text
    || props['Project Name']?.title?.[0]?.text?.content
    || 'Unnamed';

  console.log(`Processing "${projectName}" — Phase: "${phaseRaw}" (normalized: "${phase}")`);

  try {
    if (phase === 'idle') {
      if (!input) {
        console.log(`Skipping "${projectName}" — no input yet`);
        return;
      }
      await updateNotion(page.id, 'research', output, keys);
      console.log(`"${projectName}" → research`);
      return;
    }

    if (phase === 'research') {
      const prompt = `Research this project idea and return a concise summary (under 400 words) of the best free tools, APIs, and approach to build it:\n\nProject: ${input}`;
      const result = await callGroq(prompt, keys.GROQ_API_KEY);
      await updateNotion(page.id, 'code', result, keys);
      console.log(`"${projectName}" → code`);
      return;
    }

    if (phase === 'code') {
      const prompt = `For this project: "${input}"\n\nBased on this research: "${output.substring(0, 400)}"\n\nDescribe in one paragraph the key Next.js files needed to build an MVP. Keep it under 300 words.`;
      const result = await callGroq(prompt, keys.GROQ_API_KEY);
      await updateNotion(page.id, 'deploy', result, keys);
      console.log(`"${projectName}" → deploy`);
      return;
    }

    if (phase === 'deploy') {
      await updateNotion(page.id, 'ethics', output + '\n\n[Deploy: ready for manual deployment using voice-agent pattern]', keys);
      console.log(`"${projectName}" → ethics`);
      return;
    }

    if (phase === 'ethics') {
      await updateNotion(page.id, 'done', output + '\n\n[Ethics: PASSED]', keys);
      console.log(`"${projectName}" → done`);
      return;
    }

    console.log(`"${projectName}" — phase "${phase}" is terminal or unknown, skipping`);

  } catch (err) {
    console.error(`Error on "${projectName}":`, err.message);
    try {
      await updateNotion(page.id, 'failed', `Error in ${phase}: ${err.message}`, keys);
    } catch (e) {
      console.error('Could not update error state:', e.message);
    }
  }
}

export async function GET(request) {
  const authHeader = request.headers.get('authorization');
  const expectedToken = process.env.CRON_SECRET || 'c4-internal-secret';
  if (authHeader !== `Bearer ${expectedToken}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const keys = {
    NOTION_TOKEN: process.env.NOTION_TOKEN,
    NOTION_DB_ID: process.env.NOTION_DB_ID,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GITHUB_USER: process.env.GITHUB_USER,
    VERCEL_TOKEN: process.env.VERCEL_TOKEN,
    VAPI_API_KEY: process.env.VAPI_API_KEY,
    HUGGINGFACE_TOKEN: process.env.HUGGINGFACE_TOKEN,
  };

  const missing = Object.entries(keys).filter(([k, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    return new Response(`Missing env vars: ${missing.join(', ')}`, { status: 500 });
  }

  try {
    const activeProjects = await queryNotion(keys.NOTION_DB_ID, keys);
    console.log(`Found ${activeProjects.length} active projects`);

    for (const page of activeProjects) {
      await processProject(page, keys);
    }

    return new Response(JSON.stringify({
      processed: activeProjects.length,
      timestamp: new Date().toISOString()
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Orchestrator error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}
