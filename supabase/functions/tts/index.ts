// Google Cloud Text-to-Speech proxy (Chirp 3 HD). The API key stays in the GOOGLE_TTS_KEY secret.
// Auth is checked by the use_quota RPC with the caller's JWT (owner only), so verify_jwt is off to allow CORS preflight.
import { cors, json, useQuota, refund } from "./common.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const key = Deno.env.get("GOOGLE_TTS_KEY");
  if (!key) return json({ error: "no_key" }, 503);
  let body: { text?: string; voice?: string; lang?: string };
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const text = String(body.text || "").trim();
  const lang = body.lang === "vi" ? "vi-VN" : "en-US";
  const voice = String(body.voice || `${lang}-Chirp3-HD-Aoede`);
  if (!text) return json({ error: "empty" }, 400);
  if (new TextEncoder().encode(text).length > 4800) return json({ error: "too_long" }, 400);
  if (!/^[a-z]{2}-[A-Z]{2}-[A-Za-z0-9-]+$/.test(voice)) return json({ error: "bad_voice" }, 400);

  const kind = /Chirp3-HD/.test(voice) ? "chirp" : /Wavenet|Neural2/.test(voice) ? "wavenet" : "standard";
  const limits: Record<string, number> = { chirp: Number(Deno.env.get("TTS_MONTHLY_LIMIT") || 950000), wavenet: 3900000, standard: 3900000 };
  const q = await useQuota(req, kind, text.length, limits[kind]);
  if (!q.ok) return q.res;

  const g = await fetch("https://texttospeech.googleapis.com/v1/text:synthesize", {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ input: { text }, voice: { languageCode: voice.slice(0, 5), name: voice }, audioConfig: { audioEncoding: "MP3" } }),
  });
  if (!g.ok) {
    await refund(req, kind, text.length);
    const detail = (await g.text()).slice(0, 500);
    return json({ error: g.status === 429 ? "google_rate_limited" : "google_error", status: g.status, detail }, g.status === 429 ? 429 : 502);
  }
  const out = await g.json() as { audioContent?: string };
  if (!out.audioContent) { await refund(req, kind, text.length); return json({ error: "no_audio" }, 502); }
  return json({ audio: out.audioContent, used: q.total, limit: limits[kind], kind });
});
