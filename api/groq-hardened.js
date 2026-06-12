// groq-hardened.js - drop-in Groq caller for C4 cron.js
// Fixes: 429 rate limit on llama-3.1-8b-instant
// Strategy: exponential backoff (2s/4s/8s) -> model fallback (separate
// rate-limit bucket on Groq free tier) -> hard cap of 3 LLM calls per cron run.

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const PRIMARY  = "llama-3.1-8b-instant";
const FALLBACK = "llama-3.3-70b-versatile";
const MAX_CALLS_PER_RUN = 3;
const MAX_TOKENS = 400;

let callsThisRun = 0;
export function resetCallBudget() { callsThisRun = 0; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rawCall(model, messages) {
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages, max_tokens: MAX_TOKENS, temperature: 0.3 }),
  });
  if (res.status === 429) { const e = new Error("429"); e.code = 429; throw e; }
  if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

export async function groqCall(messages) {
  if (callsThisRun >= MAX_CALLS_PER_RUN) {
    console.warn(`[groq] call budget (${MAX_CALLS_PER_RUN}/run) exhausted - skipping`);
    return null;
  }
  callsThisRun++;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await rawCall(PRIMARY, messages);
    } catch (err) {
      if (err.code !== 429) throw err;
      const wait = 2000 * 2 ** attempt;
      console.warn(`[groq] 429 on ${PRIMARY}, backoff ${wait}ms (attempt ${attempt + 1}/3)`);
      await sleep(wait);
    }
  }

  console.warn(`[groq] primary exhausted, falling back to ${FALLBACK}`);
  try {
    return await rawCall(FALLBACK, messages);
  } catch (err) {
    console.error(`[groq] fallback failed too: ${err.message} - returning null, cron continues`);
    return null;
  }
}
