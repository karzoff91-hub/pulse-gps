// /api/manual-stats.js
// Gestisce le statistiche personalizzate collegate a un giocatore manuale.
// GET    -> restituisce le statistiche di un giocatore ?playerId=123
// POST   -> aggiunge una statistica { playerId, statName, statValue, sessionLabel, recordedDate }
// DELETE -> elimina una statistica ?id=456

import { sql } from '@vercel/postgres';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const { playerId } = req.query;
      if (!playerId) return res.status(400).json({ error: 'Parametro playerId mancante.' });
      const { rows } = await sql`
        SELECT * FROM manual_stats
        WHERE player_id = ${playerId}
        ORDER BY recorded_date DESC NULLS LAST, created_at DESC;
      `;
      return res.status(200).json({ Result: 'OK', Stats: rows });
    }

    if (req.method === 'POST') {
      const { playerId, statName, statValue, sessionLabel, recordedDate } = req.body || {};
      if (!playerId || !statName || statValue === undefined) {
        return res.status(400).json({ error: 'playerId, statName e statValue sono obbligatori.' });
      }
      const { rows } = await sql`
        INSERT INTO manual_stats (player_id, stat_name, stat_value, session_label, recorded_date)
        VALUES (${playerId}, ${statName}, ${String(statValue)}, ${sessionLabel || null}, ${recordedDate || null})
        RETURNING *;
      `;
      return res.status(200).json({ Result: 'OK', Stat: rows[0] });
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'Parametro id mancante.' });
      await sql`DELETE FROM manual_stats WHERE id = ${id};`;
      return res.status(200).json({ Result: 'OK' });
    }

    res.status(405).json({ error: 'Metodo non supportato.' });
  } catch (err) {
    res.status(500).json({ error: 'Errore database', details: err.message });
  }
}
