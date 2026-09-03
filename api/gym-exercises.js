// /api/gym-exercises.js
// Esercizi dentro una scheda palestra.
// POST   -> { sheetId, exerciseName, youtubeUrl, kg, reps, recovery, notes }
// PATCH  -> { id, exerciseName, youtubeUrl, kg, reps, recovery, notes } modifica un esercizio esistente
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

export default async function handler(req, res) {
  const client = getPool();
  try {
    if (req.method === 'POST') {
      const { sheetId, exerciseName, youtubeUrl, kg, reps, recovery, notes } = req.body || {};
      if (!sheetId || !exerciseName) {
        return res.status(400).json({ error: 'sheetId ed exerciseName sono obbligatori.' });
      }
      const { rows } = await client.query(
        `INSERT INTO gym_exercises (sheet_id, exercise_name, youtube_url, kg, reps, recovery, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [sheetId, exerciseName, youtubeUrl || null, kg || null, reps || null, recovery || null, notes || null]
      );
      return res.status(200).json({ Result: 'OK', Exercise: rows[0] });
    }

    if (req.method === 'PATCH') {
      const { id, exerciseName, youtubeUrl, kg, reps, recovery, notes } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Parametro id mancante.' });
      const { rows } = await client.query(
        `UPDATE gym_exercises SET
           exercise_name = COALESCE($2, exercise_name),
           youtube_url = $3,
           kg = $4,
           reps = $5,
           recovery = $6,
           notes = $7
         WHERE id = $1 RETURNING *`,
        [id, exerciseName || null, youtubeUrl || null, kg || null, reps || null, recovery || null, notes || null]
      );
      return res.status(200).json({ Result: 'OK', Exercise: rows[0] });
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'Parametro id mancante.' });
      await client.query('DELETE FROM gym_exercises WHERE id = $1', [id]);
      return res.status(200).json({ Result: 'OK' });
    }

    res.status(405).json({ error: 'Metodo non supportato.' });
  } catch (err) {
    res.status(500).json({ error: 'Errore database', details: err.message });
  }
}
