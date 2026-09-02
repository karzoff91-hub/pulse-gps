// /api/gym-logs.js
// Scheletro iniziale per l'analisi dei lavori da palestra (forza/pesi).
// GET    -> ?playerName=... restituisce le sessioni palestra di quel giocatore
// POST   -> crea una sessione { playerName, exercise, load, sets, reps, notes, sessionDate }
// DELETE -> elimina una voce ?id=123

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

async function ensureTable(client){
  await client.query(`
    CREATE TABLE IF NOT EXISTS gym_logs (
      id SERIAL PRIMARY KEY,
      player_name TEXT NOT NULL,
      exercise TEXT NOT NULL,
      load_kg NUMERIC,
      sets INTEGER,
      reps INTEGER,
      notes TEXT,
      session_date DATE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

export default async function handler(req, res) {
  const client = getPool();
  try {
    await ensureTable(client);

    if (req.method === 'GET') {
      const { playerName } = req.query;
      if (!playerName) return res.status(400).json({ error: 'Parametro playerName mancante.' });
      const { rows } = await client.query(
        'SELECT * FROM gym_logs WHERE player_name = $1 ORDER BY session_date DESC NULLS LAST, created_at DESC',
        [playerName]
      );
      return res.status(200).json({ Result: 'OK', Logs: rows });
    }

    if (req.method === 'POST') {
      const { playerName, exercise, load, sets, reps, notes, sessionDate } = req.body || {};
      if (!playerName || !exercise) {
        return res.status(400).json({ error: 'playerName ed exercise sono obbligatori.' });
      }
      const { rows } = await client.query(
        `INSERT INTO gym_logs (player_name, exercise, load_kg, sets, reps, notes, session_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [playerName, exercise, load || null, sets || null, reps || null, notes || null, sessionDate || null]
      );
      return res.status(200).json({ Result: 'OK', Log: rows[0] });
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'Parametro id mancante.' });
      await client.query('DELETE FROM gym_logs WHERE id = $1', [id]);
      return res.status(200).json({ Result: 'OK' });
    }

    res.status(405).json({ error: 'Metodo non supportato.' });
  } catch (err) {
    res.status(500).json({ error: 'Errore database', details: err.message });
  }
}
