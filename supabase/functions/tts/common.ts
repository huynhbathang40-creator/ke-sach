// Shared helpers for the Kệ Sách edge functions.
export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

/** Charges `amount` to this month's counter for `kind` as the signed-in caller (owner only, capped at `limit`). */
export async function useQuota(req: Request, kind: string, amount: number, limit: number) {
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return { ok: false as const, res: json({ error: "not_signed_in" }, 401) };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/use_quota`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({ p_kind: kind, p_amount: amount, p_limit: limit }),
  });
  if (r.ok) return { ok: true as const, total: Number(await r.json()) };
  const t = await r.text();
  if (/quota_exceeded/.test(t)) return { ok: false as const, res: json({ error: "quota_exceeded" }, 429) };
  if (/not_owner/.test(t)) return { ok: false as const, res: json({ error: "not_owner" }, 403) };
  if (r.status === 401 || /JWT|jwt/.test(t)) return { ok: false as const, res: json({ error: "not_signed_in" }, 401) };
  return { ok: false as const, res: json({ error: "quota_check_failed", detail: t.slice(0, 300) }, 500) };
}
export async function refund(req: Request, kind: string, amount: number) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/use_quota`, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, authorization: req.headers.get("authorization") || "", "content-type": "application/json" },
      body: JSON.stringify({ p_kind: kind, p_amount: -amount, p_limit: 0 }),
    });
  } catch { /* best effort */ }
}
