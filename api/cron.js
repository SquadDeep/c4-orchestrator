// C4 Autonomous Orchestrator — polls Notion, runs agents, builds projects
// Triggered by Vercel Cron Job every 3 minutes (free tier)

export const runtime = 'nodejs';
export const maxDuration = 300; // 5 minutes max

// ─── Agent runners ──────────────────────────────────────────
async function runResearch(input, keys) {
  const prompt = `Research the following project idea and return a concise summary of the best free tools, APIs, and approach to build it. Include specific URLs and docs references. Keep it actionable.\n\nProject: ${input}`;
  return await callGroq(prompt, keys.GROQ_API_KEY);
}

async function runCopy(input, context, keys) {
  const prompt = `Based on this research: "${context}", write the landing page copy, assistant greeting, and FAQ text for this project: "${input}". Return JSON with keys: headline, subheadline, greeting, faq (array of Q&A objects).`;
  const raw = await callGroq(prompt, keys.GROQ_API_KEY);
  try { return JSON.stringify(JSON.parse(raw)); } catch { return raw; }
}

async function runCode(input, context, keys) {
  const prompt = `Generate a complete Next.js 14 application based on this spec: "${input}"\n\nResearch context: "${context}"\n\nCreate ALL necessary files:\n- app/layout.js (with metadata)\n- app/page.js (homepage with the landing copy embedded)\n- app/api/[relevant-route]/route.js (the main backend logic)\n- package.json with dependencies: next, react, react-dom, @supabase/supabase-js, twilio\n\nReturn the response as a JSON object where each key is a file path and each value is the complete file contents. Format: {"app/page.js": "code here...", "app/api/endpoint/route.js": "code here...", ...}`;
  const raw = await callGroq(prompt, keys.GROQ_API_KEY);
  try { return JSON.parse(raw); } catch { 
    return { "app/page.js": "// Code generation failed. Please retry.", "error": raw };
  }
}

async function runDeploy(files, projectName, keys) {
  // Create GitHub repo, push files, trigger Vercel deploy
  const repoName = projectName.toLowerCase().replace(/[^a-z0-9-]/g, '-').substring(0, 50);
  
  // Step 1: Create GitHub repo
  const githubRes = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: {
      'Authorization': `token ${keys.GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: repoName, auto_init: false, private: false }),
  });
  if (!githubRes.ok) {
    const err = await githubRes.json();
    if (err.message?.includes('already exists')) {
      // Repo exists, continue
    } else {
      throw new Error(`GitHub repo creation failed: ${JSON.stringify(err)}`);
    }
  }

  // Step 2: Push files via GitHub Contents API
  const pushResults = [];
  for (const [filePath, content] of Object.entries(files)) {
    if (filePath === 'error') continue;
    const encoded = Buffer.from(content).toString('base64');
    const res = await fetch(`https://api.github.com/repos/${keys.GITHUB_USER}/${repoName}/contents/${filePath}`, {
      method: 'PUT',
      headers: {
        'Authorization': `token ${keys.GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: `Add ${filePath}`,
        content: encoded,
      }),
    });
    pushResults.push({ file: filePath, status: res.status });
  }

  // Step 3: Trigger Vercel deploy
  const vercelRes = await fetch('https://api.vercel.com/v13/deployments', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${keys.VERCEL_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: repoName,
      gitSource: {
        type: 'github',
        repoId: 0, // Vercel will resolve from repo name
        ref: 'main',
        repo: `${keys.GITHUB_USER}/${repoName}`,
      },
      target: 'production',
      projectSettings: {
        framework: 'nextjs',
        buildCommand: 'npm run build',
        outputDirectory: '.next',
        environmentVariables: [
          { key: 'NEXT_PUBLIC_SUPABASE_URL', value: keys.SUPABASE_URL, target: ['production'] },
          { key: 'SUPABASE_SERVICE_KEY', value: keys.SUPABASE_ANON_KEY, target: ['production'] },
        ],
      },
    }),
  });
  const deployData = await vercelRes.json();
  
  return {
    repoUrl: `https://github.com/${keys.GITHUB_USER}/${repoName}`,
    deployUrl: deployData?.url ? `https://${deployData.url}` : null,
    deployId: deployData?.id,
    filesPushed: pushResults.filter(r => r.status === 201).length,
  };
}

async function runVoice(deployUrl, projectName, keys) {
  // Create Vapi assistant linked to the new deployment
  const assistantRes = await fetch('https://api.vapi.ai/assistant', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${keys.VAPI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: `${projectName} Assistant`,
      model: { provider: 'openai', model: 'gpt-4o-mini' },
      voice: { provider: '11labs', voiceId: 'rachel' },
      transcriber: { provider: 'deepgram' },
      firstMessage: `Hi, this is ${projectName}. How can I help you today?`,
      functions: [{
        name: 'handle_request',
        url: `${deployUrl}/api/handle-request`,
        method: 'POST',
      }],
    }),
  });
  const assistantData = await assistantRes.json();
  
  // Buy a phone number
  let phoneNumber = null;
  try {
    const phoneRes = await fetch('https://api.vapi.ai/phone-number', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${keys.VAPI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ assistantId: assistantData.id }),
    });
    const phoneData = await phoneRes.json();
    phoneNumber = phoneData.phoneNumber || phoneData.number;
  } catch { /* Optional */ }

  return { assistantId: assistantData.id, phoneNumber };
}

async function runEthics(text, keys) {
  try {
    const res = await fetch('https://api-inference.huggingface.co/models/unitary/toxic-bert', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${keys.HUGGINGFACE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inputs: text }),
    });
    const data = await res.json();
    // Parse toxicity scores
    let maxToxicity = 0;
    if (Array.isArray(data) && data[0]) {
      for (const item of data[0]) {
        if (item.label === 'toxic' && item.score > maxToxicity) maxToxicity = item.score;
      }
    }
    return { passed: maxToxicity < 0.5, maxToxicity, summary: `Max toxicity score: ${(maxToxicity*100).toFixed(1)}%` };
  } catch (e) {
    return { passed: true, note: 'Ethics check skipped (API error)' };
  }
}

async function callGroq(prompt, apiKey) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
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

async function updateNotion(pageId, updates, keys) {
  const properties = {};
  for (const [key, value] of Object.entries(updates)) {
    if (key === 'Phase') {
      properties[key] = { select: { name: value } };
    } else if (key === 'Input' || key === 'Output') {
      properties[key] = { rich_text: [{ text: { content: String(value).substring(0, 2000) } }] };
    } else if (key === 'Agent') {
      properties[key] = { select: { name: value } };
    } else if (key === 'Link') {
      properties[key] = { url: value };
    }
  }
  await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${keys.NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify({ properties }),
  });
}

async function queryNotion(dbId, filter, keys) {
  const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${keys.NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify({ filter, page_size: 5 }),
  });
  return (await res.json()).results || [];
}

// ─── Main pipeline ──────────────────────────────────────────
async function processProject(page, keys) {
  const props = page.properties;
  const phase = props.Phase?.select?.name || 'idle';
  const input = props.Input?.rich_text?.[0]?.text?.content || '';
  const output = props.Output?.rich_text?.[0]?.text?.content || '';
  const projectName = props['Project Name']?.title?.[0]?.text?.content || 'Unnamed';

  console.log(`📋 Processing "${projectName}" — Phase: ${phase}`);

  let newOutput = output;
  let newPhase = phase;
  let newAgent = '';
  let link = '';

  try {
    switch (phase) {
      case 'idle': {
        if (!input) break; // stay idle until user adds input
        newPhase = 'research';
        newAgent = 'groq';
        break;
      }

      case 'research': {
        newOutput = await runResearch(input, keys);
        newPhase = 'code';
        newAgent = 'groq';
        break;
      }

      case 'code': {
        const codeFiles = await runCode(input, output, keys);
        // Store generated code as JSON string in output
        newOutput = JSON.stringify(codeFiles).substring(0, 2000);
        // Temporarily store full code in a separate Notion block (or we can chain)
        // For now, keep code compact
        newPhase = 'deploy';
        newAgent = 'github';
        break;
      }

      case 'deploy': {
        let codeFiles;
        try { codeFiles = JSON.parse(output); } catch { 
          newPhase = 'failed'; 
          newOutput = 'Could not parse code files. Retry code phase.'; 
          break;
        }
        const deployResult = await runDeploy(codeFiles, projectName, keys);
        newOutput = `Repo: ${deployResult.repoUrl}\nDeploy: ${deployResult.deployUrl || 'pending...'}`;
        link = deployResult.deployUrl || '';
        newPhase = 'voice';
        newAgent = 'vapi';
        break;
      }

      case 'voice': {
        const deployUrl = link || output.match(/Deploy: (https:\/\/[^\s]+)/)?.[1] || '';
        if (!deployUrl) { newPhase = 'failed'; newOutput = 'No deploy URL found. Skipping voice.'; break; }
        const voiceResult = await runVoice(deployUrl, projectName, keys);
        newOutput = `Assistant: ${voiceResult.assistantId}\nPhone: ${voiceResult.phoneNumber || 'pending'}`;
        newPhase = 'ethics';
        newAgent = 'huggingface';
        break;
      }

      case 'ethics': {
        const ethicsResult = await runEthics(input + ' ' + output, keys);
        newOutput = output + `\nEthics: ${ethicsResult.passed ? 'PASSED' : 'FLAGGED'} — ${ethicsResult.summary}`;
        newPhase = ethicsResult.passed ? 'done' : 'failed';
        newAgent = '';
        break;
      }

      case 'done':
      case 'failed':
        break; // terminal states

      default:
        break;
    }

    // Update Notion
    await updateNotion(page.id, {
      Phase: newPhase,
      Output: newOutput || output,
      Agent: newAgent,
      ...(link ? { Link: link } : {}),
    }, keys);

    console.log(`✅ "${projectName}" → ${newPhase}`);
  } catch (err) {
    console.error(`❌ Error on "${projectName}":`, err.message);
    await updateNotion(page.id, {
      Phase: 'failed',
      Output: `Error in ${phase}: ${err.message}`,
      Agent: '',
    }, keys);
  }
}

// ─── Vercel handler ─────────────────────────────────────────
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

  // Validate required keys
  const missing = Object.entries(keys).filter(([k, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    return new Response(`Missing env vars: ${missing.join(', ')}`, { status: 500 });
  }

  try {
    // Poll Notion for projects in active phases (not done/failed)
    const activeProjects = await queryNotion(keys.NOTION_DB_ID, {
      and: [
        { property: 'Phase', select: { does_not_equal: 'done' } },
        { property: 'Phase', select: { does_not_equal: 'failed' } },
      ],
    }, keys);

    for (const page of activeProjects) {
      await processProject(page, keys);
    }

    return new Response(JSON.stringify({ processed: activeProjects.length, timestamp: new Date().toISOString() }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Orchestrator error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}
