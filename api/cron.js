import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: "C4 heartbeat. Reply: ALIVE" }],
        max_tokens: 10
      })
    });
    if (!groqRes.ok) throw new Error(`Groq error: ${await groqRes.text()}`);
    const data = await groqRes.json();
    const pulse = data.choices?.[0]?.message?.content ?? "NO_RESPONSE";
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
    await supabase.from("episodic_log").insert({
      event: "cron_heartbeat", content: pulse, timestamp: new Date().toISOString()
    });
    return res.status(200).json({ success: true, pulse });
  } catch (err) {
    console.error("CRON FAIL:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
