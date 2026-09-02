// /api/manual-stats.js
// Gestisce le statistiche personalizzate collegate a un giocatore manuale.
// GET    -> restituisce le statistiche di un giocatore ?playerId=123
// POST   -> aggiunge una statistica { playerId, statName, statValue, sessionLabel, recordedDate }
// DELETE -> elimina una statistica ?id=456

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
  const client = getPool();
  try {
    if (req.method === 'GET') {
      const { playerId } = req.query;
      if (!playerId) return res.status(400).json({ error: 'Parametro playerId mancante.' });
      const { rows } = await client.query(
        'SELECT * FROM manual_stats WHERE player_id = $1 ORDER BY recorded_date DESC NULLS LAST, created_at DESC',
        [playerId]
      );
      return res.status(200).json({ Result: 'OK', Stats: rows });
    }

    if (req.method === 'POST') {
      const { playerId, statName, statValue, sessionLabel, recordedDate } = req.body || {};
      if (!playerId || !statName || statValue === undefined) {
        return res.status(400).json({ error: 'playerId, statName e statValue sono obbligatori.' });
      }
      const { rows } = await client.query(
        `INSERT INTO manual_stats (player_id, stat_name, stat_value, session_label, recorded_date)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [playerId, statName, String(statValue), sessionLabel || null, recordedDate || null]
      );
      return res.status(200).json({ Result: 'OK', Stat: rows[0] });
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'Parametro id mancante.' });
      await client.query('DELETE FROM manual_stats WHERE id = $1', [id]);
      return res.status(200).json({ Result: 'OK' });
    }

    res.status(405).json({ error: 'Metodo non supportato.' });
  } catch (err) {
    res.status(500).json({ error: 'Errore database', details: err.message });
  }
}
