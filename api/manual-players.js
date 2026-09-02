// /api/manual-players.js
// Gestisce i giocatori aggiunti manualmente (non provenienti da K-Sport GPS).
// GET    -> restituisce la lista
// POST   -> crea un nuovo giocatore { name, position, notes }
// DELETE -> elimina un giocatore ?id=123 (elimina anche le sue statistiche)

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

async function ensureTables(client){
  await client.query(`
    CREATE TABLE IF NOT EXISTS manual_players (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      position TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS manual_stats (
      id SERIAL PRIMARY KEY,
      player_id INTEGER REFERENCES manual_players(id) ON DELETE CASCADE,
      stat_name TEXT NOT NULL,
      stat_value TEXT NOT NULL,
      session_label TEXT,
      recorded_date DATE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

export default async function handler(req, res) {
  const client = getPool();
  try {
    await ensureTables(client);

    if (req.method === 'GET') {
      const { rows } = await client.query('SELECT * FROM manual_players ORDER BY name ASC');
      return res.status(200).json({ Result: 'OK', Players: rows });
    }

    if (req.method === 'POST') {
      const { name, position, notes } = req.body || {};
      if (!name) return res.status(400).json({ error: 'Il nome del giocatore è obbligatorio.' });
      const { rows } = await client.query(
        'INSERT INTO manual_players (name, position, notes) VALUES ($1, $2, $3) RETURNING *',
        [name, position || null, notes || null]
      );
      return res.status(200).json({ Result: 'OK', Player: rows[0] });
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'Parametro id mancante.' });
      await client.query('DELETE FROM manual_players WHERE id = $1', [id]);
      return res.status(200).json({ Result: 'OK' });
    }

    res.status(405).json({ error: 'Metodo non supportato.' });
  } catch (err) {
    res.status(500).json({ error: 'Errore database', details: err.message });
  }
}
