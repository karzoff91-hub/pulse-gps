// /api/gym-sheets.js
// Gestisce le "schede" di allenamento in palestra, e i link personali per gli atleti.
// GET    -> ?playerName=... restituisce { current, history }
//        -> ?action=token&playerName=... genera/recupera il codice di accesso personale
//        -> ?action=resolve&token=... risolve un codice nel nome del giocatore (pubblico)
// POST   -> { playerName, action:'new_sheet', title } archivia la scheda corrente e ne crea una nuova
// PATCH  -> { id, title, startDate, endDate } aggiorna titolo/periodo di una scheda
// DELETE -> ?id=123 elimina una scheda (e i suoi esercizi)

import pg from 'pg';
const { Pool } = pg;
import crypto from 'crypto';

let pool;
function getPool(){
  if(!pool){
    pool = new Pool({ connectionString: process.env.POSTGRES_URL, ssl: { rejectUnauthorized: false } });
  }
  return pool;
}

async function ensureTables(client){
  await client.query(`
    CREATE TABLE IF NOT EXISTS gym_sheets (
      id SERIAL PRIMARY KEY,
      player_name TEXT NOT NULL,
      title TEXT,
      is_current BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await client.query(`ALTER TABLE gym_sheets ADD COLUMN IF NOT EXISTS start_date DATE;`);
  await client.query(`ALTER TABLE gym_sheets ADD COLUMN IF NOT EXISTS end_date DATE;`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS gym_exercises (
      id SERIAL PRIMARY KEY,
      sheet_id INTEGER REFERENCES gym_sheets(id) ON DELETE CASCADE,
      exercise_name TEXT NOT NULL,
      youtube_url TEXT,
      kg NUMERIC,
      reps TEXT,
      recovery TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS player_tokens (
      id SERIAL PRIMARY KEY,
      player_name TEXT NOT NULL UNIQUE,
      token TEXT NOT NULL UNIQUE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS staff_tokens (
      id SERIAL PRIMARY KEY,
      role TEXT NOT NULL UNIQUE,
      token TEXT NOT NULL UNIQUE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS player_physio_tokens (
      id SERIAL PRIMARY KEY,
      player_name TEXT NOT NULL UNIQUE,
      token TEXT NOT NULL UNIQUE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

async function fetchSheetWithExercises(client, sheet){
  const { rows } = await client.query('SELECT * FROM gym_exercises WHERE sheet_id = $1 ORDER BY created_at ASC', [sheet.id]);
  return { ...sheet, exercises: rows };
}

export default async function handler(req, res) {
  const client = getPool();
  try {
    await ensureTables(client);

    if (req.method === 'GET') {
      const { playerName, action, token } = req.query;

      if (action === 'resolve') {
        if (!token) return res.status(400).json({ error: 'Parametro token mancante.' });
        const { rows } = await client.query('SELECT player_name FROM player_tokens WHERE token = $1', [token]);
        if (rows.length === 0) return res.status(404).json({ error: 'Link non valido.' });
        return res.status(200).json({ Result: 'OK', playerName: rows[0].player_name });
      }

      if (action === 'token') {
        if (!playerName) return res.status(400).json({ error: 'Parametro playerName mancante.' });
        const { rows: existing } = await client.query('SELECT token FROM player_tokens WHERE player_name = $1', [playerName]);
        if (existing.length > 0) return res.status(200).json({ Result: 'OK', token: existing[0].token });
        const newToken = crypto.randomBytes(16).toString('hex');
        await client.query('INSERT INTO player_tokens (player_name, token) VALUES ($1, $2)', [playerName, newToken]);
        return res.status(200).json({ Result: 'OK', token: newToken });
      }

      if (action === 'staff_resolve') {
        if (!token) return res.status(400).json({ error: 'Parametro token mancante.' });
        const { rows } = await client.query('SELECT role FROM staff_tokens WHERE token = $1', [token]);
        if (rows.length === 0) return res.status(404).json({ error: 'Link non valido.' });
        return res.status(200).json({ Result: 'OK', role: rows[0].role });
      }

      if (action === 'staff_token') {
        const { role } = req.query;
        if (!role) return res.status(400).json({ error: 'Parametro role mancante.' });
        const { rows: existing } = await client.query('SELECT token FROM staff_tokens WHERE role = $1', [role]);
        if (existing.length > 0) return res.status(200).json({ Result: 'OK', token: existing[0].token });
        const newToken = crypto.randomBytes(16).toString('hex');
        await client.query('INSERT INTO staff_tokens (role, token) VALUES ($1, $2)', [role, newToken]);
        return res.status(200).json({ Result: 'OK', token: newToken });
      }

      if (action === 'physio_resolve') {
        if (!token) return res.status(400).json({ error: 'Parametro token mancante.' });
        const { rows } = await client.query('SELECT player_name FROM player_physio_tokens WHERE token = $1', [token]);
        if (rows.length === 0) return res.status(404).json({ error: 'Link non valido.' });
        return res.status(200).json({ Result: 'OK', playerName: rows[0].player_name });
      }

      if (action === 'physio_token') {
        if (!playerName) return res.status(400).json({ error: 'Parametro playerName mancante.' });
        const { rows: existing } = await client.query('SELECT token FROM player_physio_tokens WHERE player_name = $1', [playerName]);
        if (existing.length > 0) return res.status(200).json({ Result: 'OK', token: existing[0].token });
        const newToken = crypto.randomBytes(16).toString('hex');
        await client.query('INSERT INTO player_physio_tokens (player_name, token) VALUES ($1, $2)', [playerName, newToken]);
        return res.status(200).json({ Result: 'OK', token: newToken });
      }

      if (!playerName) return res.status(400).json({ error: 'Parametro playerName mancante.' });

      let { rows: currentRows } = await client.query(
        'SELECT * FROM gym_sheets WHERE player_name = $1 AND is_current = true ORDER BY created_at DESC LIMIT 1',
        [playerName]
      );
      let current;
      if (currentRows.length === 0) {
        const { rows: created } = await client.query(
          'INSERT INTO gym_sheets (player_name, title, is_current, start_date) VALUES ($1, $2, true, CURRENT_DATE) RETURNING *',
          [playerName, 'Scheda 1']
        );
        current = created[0];
      } else {
        current = currentRows[0];
      }
      current = await fetchSheetWithExercises(client, current);

      const { rows: historyRows } = await client.query(
        'SELECT * FROM gym_sheets WHERE player_name = $1 AND is_current = false ORDER BY created_at DESC',
        [playerName]
      );
      const history = await Promise.all(historyRows.map(s => fetchSheetWithExercises(client, s)));

      return res.status(200).json({ Result: 'OK', current, history });
    }

    if (req.method === 'POST') {
      const { playerName, title, startDate } = req.body || {};
      if (!playerName) return res.status(400).json({ error: 'playerName obbligatorio.' });
      await client.query(
        `UPDATE gym_sheets SET is_current = false, end_date = COALESCE(end_date, CURRENT_DATE)
         WHERE player_name = $1 AND is_current = true`,
        [playerName]
      );
      const { rows: countRows } = await client.query('SELECT COUNT(*) FROM gym_sheets WHERE player_name = $1', [playerName]);
      const n = Number(countRows[0].count) + 1;
      const { rows } = await client.query(
        'INSERT INTO gym_sheets (player_name, title, is_current, start_date) VALUES ($1, $2, true, COALESCE($3, CURRENT_DATE)) RETURNING *',
        [playerName, title || ('Scheda ' + n), startDate || null]
      );
      return res.status(200).json({ Result: 'OK', Sheet: rows[0] });
    }

    if (req.method === 'PATCH') {
      const { id, title, startDate, endDate } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Parametro id mancante.' });
      const { rows } = await client.query(
        `UPDATE gym_sheets SET
           title = COALESCE($2, title),
           start_date = $3,
           end_date = $4
         WHERE id = $1 RETURNING *`,
        [id, title || null, startDate || null, endDate || null]
      );
      return res.status(200).json({ Result: 'OK', Sheet: rows[0] });
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'Parametro id mancante.' });
      await client.query('DELETE FROM gym_sheets WHERE id = $1', [id]);
      return res.status(200).json({ Result: 'OK' });
    }

    res.status(405).json({ error: 'Metodo non supportato.' });
  } catch (err) {
    res.status(500).json({ error: 'Errore database', details: err.message });
  }
}
