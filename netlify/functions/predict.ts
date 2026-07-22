import { structuralAnalysis, type Odds } from "./lib/clusterEngine";

/**
 * GET /predict?matchId=<uuid>
 *
 * Legge la partita da Supabase (tabella `matches`) via REST diretto
 * (nessuna dipendenza npm, solo fetch nativo) e calcola il pronostico
 * strutturale con il motore Poisson portato in TypeScript.
 *
 * Non scrive nulla su `predictions` — è solo lettura, pensato per
 * verificare che l'intera catena Netlify -> Supabase -> motore funzioni,
 * senza toccare Emergent in alcun modo.
 */
export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const matchId = url.searchParams.get("matchId");

  if (!matchId) {
    return json({ error: "Parametro 'matchId' mancante. Uso: /predict?matchId=<uuid>" }, 400);
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return json({ error: "Variabili SUPABASE non configurate su Netlify" }, 500);
  }

  let row: any;
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/matches?id=eq.${encodeURIComponent(matchId)}&select=*`,
      {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
        },
      }
    );
    if (!res.ok) {
      return json({ error: `Errore Supabase: ${res.status} ${await res.text()}` }, 502);
    }
    const rows = await res.json();
    if (!rows.length) {
      return json({ error: `Nessuna partita trovata con id=${matchId}` }, 404);
    }
    row = rows[0];
  } catch (e: any) {
    return json({ error: `Errore di rete verso Supabase: ${e.message}` }, 502);
  }

  const odds: Odds = {
    odd_1: row.odd_1,
    odd_X: row.odd_x,
    odd_2: row.odd_2,
    odd_1X: row.odd_1x,
    odd_X2: row.odd_x2,
    odd_12: row.odd_12,
    odd_O15: row.odd_o15,
    odd_U15: row.odd_u15,
    odd_O25: row.odd_o25,
    odd_U25: row.odd_u25,
    odd_O35: row.odd_o35,
    odd_U35: row.odd_u35,
    odd_GG: row.odd_gg,
    odd_NG: row.odd_ng,
  };

  const result = structuralAnalysis(odds);

  return json({
    match: {
      id: row.id,
      day: row.day,
      time: row.time,
      manifestazione: row.manifestazione,
      squadra1: row.squadra1,
      squadra2: row.squadra2,
      result: row.result,
    },
    structure: result.structure,
    pick: result.pick,
    ranking: result.ranking,
    explanation: result.explanation,
    source: "netlify-function + supabase (nessuna dipendenza da Emergent)",
  });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
