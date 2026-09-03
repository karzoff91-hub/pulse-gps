// /api/gym-exercises.js
// Esercizi dentro una scheda palestra.
// POST   -> { sheetId, exerciseName, youtubeUrl, kg, reps, recovery, notes } (solo staff)
// PATCH  -> { id, exerciseName, youtubeUrl, kg, reps, recovery, notes } modifica completa (solo staff)
//        -> { id, kg, token } modifica SOLO il campo kg, valido solo se il token corrisponde
//           al giocatore proprietario della scheda CORRENTE che contiene quell'esercizio
//           (usato dal link personale dell'atleta)
// DELETE -> ?id=123 (solo staff)

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
      const { id, token } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Parametro id mancante.' });

      if (token) {
        // Accesso atleta: consentita SOLO la modifica del campo kg, e solo sulla
        // propria scheda corrente. Verifica lato server, non aggirabile dal client.
        const { rows: check } = await client.query(
          `SELECT ge.id FROM gym_exercises ge
           JOIN gym_sheets gs ON ge.sheet_id = gs.id
           JOIN player_tokens pt ON pt.player_name = gs.player_name
           WHERE ge.id = $1 AND pt.token = $2 AND gs.is_current = true`,
          [id, token]
        );
        if (check.length === 0) {
          return res.status(403).json({ error: 'Non autorizzato a modificare questo esercizio.' });
        }
        const { kg } = req.body || {};
        const { rows } = await client.query('UPDATE gym_exercises SET kg = $2 WHERE id = $1 RETURNING *', [id, kg || null]);
        return res.status(200).json({ Result: 'OK', Exercise: rows[0] });
      }

      // Accesso staff: modifica completa
      const { exerciseName, youtubeUrl, kg, reps, recovery, notes } = req.body || {};
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
