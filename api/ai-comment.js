// /api/ai-comment.js
// Genera un commento AI su un test di riabilitazione/diagnosi, e lo salva
// sul record in rehab_tests. Usa Google Gemini (piano gratuito) — richiede
// la variabile d'ambiente GEMINI_API_KEY su Vercel (ottenibile gratis su
// ai.google.dev).

import pg from 'pg';
const { Pool } = pg;

let pool;
function getPool(){
  if(!pool){
    pool = new Pool({
      connectionString: process.env.POSTGRES_URL,
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo non supportato.' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY non configurata su Vercel.' });
  }

  const { testId, playerName, testName, value, unit, notes } = req.body || {};
  if (!testId || !testName || value === undefined) {
    return res.status(400).json({ error: 'testId, testName e value sono obbligatori.' });
  }

  const prompt = `Sei un assistente per uno staff medico/atletico sportivo. Analizza brevemente (massimo 4-5 frasi, in italiano) questo test di riabilitazione/valutazione fisica, evidenziando eventuali punti di attenzione, senza fare diagnosi mediche formali e ricordando che è solo un supporto informativo, non un parere medico:

Giocatore: ${playerName}
Test: ${testName}
Valore: ${value} ${unit || ''}
Note: ${notes || 'nessuna'}`;

  try {
    const aiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );
    const aiData = await aiRes.json();
    if (!aiRes.ok) {
      return res.status(502).json({
        error: 'Errore dal servizio AI',
        details: aiData.error?.message || 'sconosciuto',
        debug_keyPreview: apiKey ? `${apiKey.slice(0,6)}...(${apiKey.length} caratteri)` : 'CHIAVE ASSENTE',
      });
    }
    const comment = (aiData.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();

    const client = getPool();
    await client.query('UPDATE rehab_tests SET ai_comment = $1 WHERE id = $2', [comment, testId]);

    res.status(200).json({ Result: 'OK', comment });
  } catch (err) {
    res.status(500).json({ error: 'Errore nella generazione del commento AI', details: err.message });
  }
}
