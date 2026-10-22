// Gemini proxy for translation, code explanations, mind maps and flashcards (GEMINI_API_KEY secret, AI Studio free tier).
// Auth is checked by the use_quota RPC with the caller's JWT (owner only), so verify_jwt is off to allow CORS preflight.
// Speed: thinking is turned off (these are summarise/translate jobs), `fast` tries Flash-Lite first,
// and `stream` passes Gemini's server-sent events straight through so the app can show progress.
import { cors, json, useQuota } from "./common.ts";

const models = (fast: boolean) => {
  const list = fast
    ? [Deno.env.get("GEMINI_FAST_MODEL"), "gemini-flash-lite-latest", Deno.env.get("GEMINI_MODEL"), "gemini-flash-latest"]
    : [Deno.env.get("GEMINI_MODEL"), "gemini-flash-latest", "gemini-flash-lite-latest"];
  return [...new Set(list.filter(Boolean) as string[])];
};

function call(model: string, key: string, prompt: string, asJson: boolean, noThinking: boolean, stream: boolean) {
  const verb = stream ? "streamGenerateContent?alt=sse" : "generateContent";
  return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:${verb}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        ...(asJson ? { responseMimeType: "application/json" } : {}),
        ...(noThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      },
    }),
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return json({ error: "no_key" }, 503);
  let body: { prompt?: string; json?: boolean; fast?: boolean; stream?: boolean };
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const prompt = String(body.prompt || "");
  if (!prompt.trim()) return json({ error: "empty" }, 400);
  if (prompt.length > 400000) return json({ error: "too_long" }, 400);
  const q = await useQuota(req, "ai", 1, Number(Deno.env.get("AI_MONTHLY_LIMIT") || 20000));
  if (!q.ok) return q.res;

  const fast = !!body.fast, asJson = !!body.json, stream = !!body.stream;
  let last = "";
  for (const model of models(fast)) {
    let r = await call(model, key, prompt, asJson, true, stream);
    if (r.status === 400) {
      const t = await r.text();
      last = `400 ${t.slice(0, 200)}`;
      if (/thinking/i.test(t)) r = await call(model, key, prompt, asJson, false, stream); // model does not accept a thinking budget
      else continue;
    }
    if (r.ok && stream && r.body) {
      return new Response(r.body, { headers: { ...cors, "content-type": "text/event-stream", "cache-control": "no-cache", "x-model": model } });
    }
    if (r.ok) {
      const d = await r.json() as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[] };
      const text = (d.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
      if (text) return json({ text, model });
      last = "empty_answer"; continue;
    }
    last = `${r.status} ${(await r.text()).slice(0, 300)}`;
    if (r.status === 429) return json({ error: "rate_limited", detail: last }, 429);
    if (r.status !== 404 && r.status !== 400) break;
  }
  return json({ error: "ai_error", detail: last }, 502);
});
