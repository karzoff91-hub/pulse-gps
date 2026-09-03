// /api/rehab-tests.js
// Test di riabilitazione / valutazioni fisiche per un giocatore (GPS o manuale).
// GET    -> ?playerName=... restituisce i test di quel giocatore
// POST   -> crea un test { playerName, testName, value, unit, notes, testDate }
// DELETE -> elimina un test ?id=123

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
    CREATE TABLE IF NOT EXISTS rehab_tests (
      id SERIAL PRIMARY KEY,
      player_name TEXT NOT NULL,
      test_name TEXT NOT NULL,
      value TEXT NOT NULL,
      unit TEXT,
      notes TEXT,
      ai_comment TEXT,
      test_date DATE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await client.query(`ALTER TABLE rehab_tests ADD COLUMN IF NOT EXISTS injury_id INTEGER;`);
}

export default async function handler(req, res) {
  const client = getPool();
  try {
    await ensureTable(client);

    if (req.method === 'GET') {
      const { playerName } = req.query;
      if (!playerName) return res.status(400).json({ error: 'Parametro playerName mancante.' });
      const { rows } = await client.query(
        'SELECT * FROM rehab_tests WHERE player_name = $1 ORDER BY test_date DESC NULLS LAST, created_at DESC',
        [playerName]
      );
      return res.status(200).json({ Result: 'OK', Tests: rows });
    }

    if (req.method === 'POST') {
      const { playerName, testName, value, unit, notes, testDate, injuryId } = req.body || {};
      if (!playerName || !testName || value === undefined) {
        return res.status(400).json({ error: 'playerName, testName e value sono obbligatori.' });
      }
      const { rows } = await client.query(
        `INSERT INTO rehab_tests (player_name, test_name, value, unit, notes, test_date, injury_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [playerName, testName, String(value), unit || null, notes || null, testDate || null, injuryId || null]
      );
      return res.status(200).json({ Result: 'OK', Test: rows[0] });
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'Parametro id mancante.' });
      await client.query('DELETE FROM rehab_tests WHERE id = $1', [id]);
      return res.status(200).json({ Result: 'OK' });
    }

    res.status(405).json({ error: 'Metodo non supportato.' });
  } catch (err) {
    res.status(500).json({ error: 'Errore database', details: err.message });
  }
}
