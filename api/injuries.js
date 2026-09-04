// /api/injuries.js
// Storico infortuni per giocatore, con tipologia per l'aggregazione a torta.
// GET    -> ?playerName=... infortuni di un giocatore, oppure senza parametro
//           per tutti gli infortuni della squadra (per i grafici aggregati)
// POST   -> { playerName, injuryType, bodyPart, bodyZone, injuryDate, daysOut, notes }
// PATCH  -> { id, daysOut, bodyPart, bodyZone, notes } modifica un infortunio esistente
//           (usato per aggiornare la prognosi durante la riabilitazione)
// DELETE -> ?id=123

import pg from 'pg';
const { Pool } = pg;

let pool;
function getPool(){
  if(!pool){
    pool = new Pool({ connectionString: process.env.POSTGRES_URL, ssl: { rejectUnauthorized: false } });
  }
  return pool;
}

async function ensureTable(client){
  await client.query(`
    CREATE TABLE IF NOT EXISTS injuries (
      id SERIAL PRIMARY KEY,
      player_name TEXT NOT NULL,
      injury_type TEXT NOT NULL,
      body_part TEXT,
      injury_date DATE,
      days_out INTEGER,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await client.query(`ALTER TABLE injuries ADD COLUMN IF NOT EXISTS body_zone TEXT;`);
}

export default async function handler(req, res) {
  const client = getPool();
  try {
    await ensureTable(client);

    if (req.method === 'GET') {
      const { playerName } = req.query;
      if (playerName) {
        const { rows } = await client.query(
          'SELECT * FROM injuries WHERE player_name = $1 ORDER BY injury_date DESC NULLS LAST, created_at DESC',
          [playerName]
        );
        return res.status(200).json({ Result: 'OK', Injuries: rows });
      }
      const { rows } = await client.query('SELECT * FROM injuries ORDER BY injury_date DESC NULLS LAST, created_at DESC');
      return res.status(200).json({ Result: 'OK', Injuries: rows });
    }

    if (req.method === 'POST') {
      const { playerName, injuryType, bodyPart, bodyZone, injuryDate, daysOut, notes } = req.body || {};
      if (!playerName || !injuryType) {
        return res.status(400).json({ error: 'playerName e injuryType sono obbligatori.' });
      }
      const parsedDays = daysOut !== undefined && daysOut !== null && daysOut !== '' ? parseInt(daysOut, 10) : null;
      const { rows } = await client.query(
        `INSERT INTO injuries (player_name, injury_type, body_part, body_zone, injury_date, days_out, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [playerName, injuryType, bodyPart || null, bodyZone || null, injuryDate || null, (parsedDays !== null && !isNaN(parsedDays)) ? parsedDays : null, notes || null]
      );
      return res.status(200).json({ Result: 'OK', Injury: rows[0] });
    }

    if (req.method === 'PATCH') {
      const { id, daysOut, bodyPart, bodyZone, notes } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Parametro id mancante.' });
      const parsedDays = daysOut !== undefined && daysOut !== null && daysOut !== '' ? parseInt(daysOut, 10) : null;
      const { rows } = await client.query(
        `UPDATE injuries SET
           days_out = COALESCE($2, days_out),
           body_part = COALESCE($3, body_part),
           body_zone = COALESCE($4, body_zone),
           notes = COALESCE($5, notes)
         WHERE id = $1 RETURNING *`,
        [id, (parsedDays !== null && !isNaN(parsedDays)) ? parsedDays : null, bodyPart || null, bodyZone || null, notes || null]
      );
      return res.status(200).json({ Result: 'OK', Injury: rows[0] });
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'Parametro id mancante.' });
      await client.query('DELETE FROM injuries WHERE id = $1', [id]);
      return res.status(200).json({ Result: 'OK' });
    }

    res.status(405).json({ error: 'Metodo non supportato.' });
  } catch (err) {
    res.status(500).json({ error: 'Errore database', details: err.message });
  }
}
