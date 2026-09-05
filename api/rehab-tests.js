// /api/rehab-tests.js
// Test di riabilitazione E test di performance (metabolici/forza) per un
// giocatore. Distinti dal campo "category": 'rehab' (default, invariato per
// compatibilità con l'Area Medica) o 'performance' (nuovo, Sezione Test).
// I "Team Test" sono semplicemente più righe con lo stesso team_test_id.
//
// GET    -> ?playerName=...[&category=rehab|performance] test di un giocatore
//        -> ?category=performance (senza playerName) TUTTI i test performance,
//           di ogni giocatore — usato dalla vista Team Test
// POST   -> { playerName, testName, value, unit, notes, testDate, injuryId,
//              category, testKey, teamTestId, details, source }
// PATCH  -> { id, testName, value, unit, notes, details } modifica un test
// DELETE -> ?id=123 elimina un test singolo
//        -> ?teamTestId=xxx elimina tutte le righe di quell'evento team test

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
  await client.query(`ALTER TABLE rehab_tests ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'rehab';`);
  await client.query(`ALTER TABLE rehab_tests ADD COLUMN IF NOT EXISTS test_key TEXT;`);
  await client.query(`ALTER TABLE rehab_tests ADD COLUMN IF NOT EXISTS team_test_id TEXT;`);
  await client.query(`ALTER TABLE rehab_tests ADD COLUMN IF NOT EXISTS details JSONB;`);
  await client.query(`ALTER TABLE rehab_tests ADD COLUMN IF NOT EXISTS source TEXT;`);
}

export default async function handler(req, res) {
  const client = getPool();
  try {
    await ensureTable(client);

    if (req.method === 'GET') {
      const { playerName, category } = req.query;

      if (!playerName) {
        // Solo consentito per i test performance: tutti i giocatori insieme
        // (usato dalla vista Team Test).
        if (category !== 'performance') {
          return res.status(400).json({ error: 'Parametro playerName mancante.' });
        }
        const { rows } = await client.query(
          `SELECT * FROM rehab_tests WHERE category = 'performance' ORDER BY test_date DESC NULLS LAST, created_at DESC`
        );
        return res.status(200).json({ Result: 'OK', Tests: rows });
      }

      const cat = category || 'rehab'; // default invariato per compatibilità con l'Area Medica
      const { rows } = await client.query(
        'SELECT * FROM rehab_tests WHERE player_name = $1 AND category = $2 ORDER BY test_date DESC NULLS LAST, created_at DESC',
        [playerName, cat]
      );
      return res.status(200).json({ Result: 'OK', Tests: rows });
    }

    if (req.method === 'POST') {
      const { playerName, testName, value, unit, notes, testDate, injuryId, category, testKey, teamTestId, details, source } = req.body || {};
      if (!playerName || !testName || value === undefined) {
        return res.status(400).json({ error: 'playerName, testName e value sono obbligatori.' });
      }
      const { rows } = await client.query(
        `INSERT INTO rehab_tests (player_name, test_name, value, unit, notes, test_date, injury_id, category, test_key, team_test_id, details, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [
          playerName, testName, String(value), unit || null, notes || null, testDate || null, injuryId || null,
          category || 'rehab', testKey || null, teamTestId || null, details ? JSON.stringify(details) : null, source || null,
        ]
      );
      return res.status(200).json({ Result: 'OK', Test: rows[0] });
    }

    if (req.method === 'PATCH') {
      const { id, testName, value, unit, notes, details } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Parametro id mancante.' });
      const { rows } = await client.query(
        `UPDATE rehab_tests SET
           test_name = COALESCE($2, test_name),
           value = COALESCE($3, value),
           unit = $4,
           notes = $5,
           details = COALESCE($6, details)
         WHERE id = $1 RETURNING *`,
        [id, testName || null, value !== undefined ? String(value) : null, unit || null, notes || null, details ? JSON.stringify(details) : null]
      );
      return res.status(200).json({ Result: 'OK', Test: rows[0] });
    }

    if (req.method === 'DELETE') {
      const { id, teamTestId } = req.query;
      if (teamTestId) {
        await client.query('DELETE FROM rehab_tests WHERE team_test_id = $1', [teamTestId]);
        return res.status(200).json({ Result: 'OK' });
      }
      if (!id) return res.status(400).json({ error: 'Parametro id mancante.' });
      await client.query('DELETE FROM rehab_tests WHERE id = $1', [id]);
      return res.status(200).json({ Result: 'OK' });
    }

    res.status(405).json({ error: 'Metodo non supportato.' });
  } catch (err) {
    res.status(500).json({ error: 'Errore database', details: err.message });
  }
}
