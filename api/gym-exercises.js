// /api/gym-exercises.js
// Esercizi all'interno di una scheda di palestra (scheda corrente o storica).
// POST   -> { sheetId, exerciseName, youtubeUrl, kg, reps, recovery, notes }
//           aggiunge un esercizio a una scheda (solo staff, nessun token).
// PATCH  -> due modalità, distinte dalla presenza di "token" nel body:
//   - STAFF (senza token): { id, exerciseName, youtubeUrl, kg, reps, recovery, notes }
//     modifica completa dell'esercizio.
//   - ATLETA (con token):  { id, kg, token }
//     modifica SOLO il campo Kg. Consentito su un esercizio di QUALSIASI
//     scheda (corrente o storica), a patto che il token corrisponda
//     davvero al giocatore proprietario di quella scheda — verificato
//     sempre lato server, mai fidandosi dell'interfaccia.
// DELETE -> ?id=123 elimina un esercizio (solo staff).

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
        return res.status(400).json({ error: 'sheetId e exerciseName sono obbligatori.' });
      }
      const { rows } = await client.query(
        `INSERT INTO gym_exercises (sheet_id, exercise_name, youtube_url, kg, reps, recovery, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [sheetId, exerciseName, youtubeUrl || null, (kg !== undefined && kg !== '') ? kg : null, reps || null, recovery || null, notes || null]
      );
      return res.status(200).json({ Result: 'OK', Exercise: rows[0] });
    }

    if (req.method === 'PATCH') {
      const { id, token } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Parametro id mancante.' });

      if (token) {
        // --- Modalità atleta: solo Kg, su una scheda propria (anche storica) ---
        const { kg } = req.body;
        if (kg === undefined) return res.status(400).json({ error: 'Campo kg mancante.' });

        const { rows: ownerRows } = await client.query(
          `SELECT gs.player_name FROM gym_exercises ge
           JOIN gym_sheets gs ON gs.id = ge.sheet_id
           WHERE ge.id = $1`,
          [id]
        );
        if (ownerRows.length === 0) return res.status(404).json({ error: 'Esercizio non trovato.' });

        const { rows: tokenRows } = await client.query(
          'SELECT player_name FROM player_tokens WHERE token = $1',
          [token]
        );
        if (tokenRows.length === 0 || tokenRows[0].player_name !== ownerRows[0].player_name) {
          return res.status(403).json({ error: 'Non autorizzato a modificare questo esercizio.' });
        }

        const { rows } = await client.query(
          'UPDATE gym_exercises SET kg = $1 WHERE id = $2 RETURNING *',
          [(kg !== '' ? kg : null), id]
        );
        return res.status(200).json({ Result: 'OK', Exercise: rows[0] });
      }

      // --- Modalità staff: modifica completa, nessuna verifica di token ---
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
        [id, exerciseName || null, youtubeUrl || null, (kg !== undefined && kg !== '') ? kg : null, reps || null, recovery || null, notes || null]
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
