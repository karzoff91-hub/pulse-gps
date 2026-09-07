// /api/gym-exercises.js
// Esercizi all'interno di una scheda di palestra (scheda corrente o storica).
// POST   -> { sheetId, exerciseName, youtubeUrl, kg, sets, repsCount, recovery, notes, keyLiftTag }
//           aggiunge un esercizio a una scheda (solo staff, nessun token).
//           sets/repsCount: serie e ripetizioni STRUTTURATE (numeri), usate per
//           il calcolo del massimale e del volume totale — il vecchio campo
//           "reps" testuale ("4x5") resta calcolato automaticamente per
//           compatibilità con le viste che lo leggono come testo, ma non è
//           più la fonte di verità: se sets/repsCount sono presenti, vincono
//           sempre loro.
//           keyLiftTag: se presente, marca ESPLICITAMENTE questo esercizio come
//           l'esercizio fondamentale da usare per calcolare i massimali (es.
//           "Squat") — niente più indovinelli dal nome (es. "Hack Squat" che
//           contiene "Squat" per puro caso testuale).
// PATCH  -> due modalità, distinte dalla presenza di "token" nel body:
//   - STAFF (senza token): { id, exerciseName, youtubeUrl, kg, sets, repsCount, recovery, notes, keyLiftTag }
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

// Valida e normalizza il Kg: accetta solo numeri (anche con virgola/punto
// decimale), vuoto/null per "nessun valore". Qualunque altro testo (es.
// "35 kg", "circa 40") viene rifiutato con un errore chiaro invece di far
// fallire la query SQL con un messaggio incomprensibile per chi usa il sito.
function parseKg(raw){
  if(raw === undefined || raw === null || raw === '') return { ok:true, value:null };
  const normalized = String(raw).trim().replace(',', '.');
  if(!/^\d+(\.\d+)?$/.test(normalized)) return { ok:false };
  return { ok:true, value:parseFloat(normalized) };
}

// Valida sets/repsCount: interi positivi o null (campo vuoto = non specificato).
function parseIntOrNull(raw){
  if(raw === undefined || raw === null || raw === '') return { ok:true, value:null };
  const n = parseInt(raw, 10);
  if(isNaN(n) || n <= 0 || String(n) !== String(raw).trim()) return { ok:false };
  return { ok:true, value:n };
}

// Costruisce il vecchio campo "reps" testuale a partire da sets/repsCount,
// per compatibilità con codice che lo legge ancora come testo (es. schede
// molto vecchie, o un futuro export). Se manca uno dei due, torna null.
function buildRepsText(sets, repsCount){
  if(sets && repsCount) return `${sets}x${repsCount}`;
  return null;
}

export default async function handler(req, res) {
  const client = getPool();
  try {
    if (req.method === 'POST') {
      const { sheetId, exerciseName, youtubeUrl, kg, sets, repsCount, recovery, notes, keyLiftTag } = req.body || {};
      if (!sheetId || !exerciseName) {
        return res.status(400).json({ error: 'sheetId e exerciseName sono obbligatori.' });
      }
      const kgParsed = parseKg(kg);
      if (!kgParsed.ok) return res.status(400).json({ error: 'Il campo Kg deve essere solo un numero (es. 35 o 35,5), senza altro testo.' });
      const setsParsed = parseIntOrNull(sets);
      const repsParsed = parseIntOrNull(repsCount);
      if (!setsParsed.ok || !repsParsed.ok) return res.status(400).json({ error: 'Serie e ripetizioni devono essere numeri interi positivi.' });
      const repsText = buildRepsText(setsParsed.value, repsParsed.value);
      const { rows } = await client.query(
        `INSERT INTO gym_exercises (sheet_id, exercise_name, youtube_url, kg, reps, sets, reps_count, recovery, notes, key_lift_tag)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [sheetId, exerciseName, youtubeUrl || null, kgParsed.value, repsText, setsParsed.value, repsParsed.value, recovery || null, notes || null, keyLiftTag || null]
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
        const kgParsed = parseKg(kg);
        if (!kgParsed.ok) return res.status(400).json({ error: 'Inserisci solo il numero (es. 35 o 35,5), senza altre lettere o simboli.' });

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
          [kgParsed.value, id]
        );
        return res.status(200).json({ Result: 'OK', Exercise: rows[0] });
      }

      // --- Modalità staff: modifica completa, nessuna verifica di token ---
      const { exerciseName, youtubeUrl, kg, sets, repsCount, recovery, notes, keyLiftTag } = req.body || {};
      const kgParsedStaff = parseKg(kg);
      if (!kgParsedStaff.ok) return res.status(400).json({ error: 'Il campo Kg deve essere solo un numero (es. 35 o 35,5), senza altro testo.' });
      const setsParsedStaff = parseIntOrNull(sets);
      const repsParsedStaff = parseIntOrNull(repsCount);
      if (!setsParsedStaff.ok || !repsParsedStaff.ok) return res.status(400).json({ error: 'Serie e ripetizioni devono essere numeri interi positivi.' });
      const repsTextStaff = buildRepsText(setsParsedStaff.value, repsParsedStaff.value);
      const { rows } = await client.query(
        `UPDATE gym_exercises SET
           exercise_name = COALESCE($2, exercise_name),
           youtube_url = $3,
           kg = $4,
           reps = $5,
           sets = $6,
           reps_count = $7,
           recovery = $8,
           notes = $9,
           key_lift_tag = $10
         WHERE id = $1 RETURNING *`,
        [id, exerciseName || null, youtubeUrl || null, kgParsedStaff.value, repsTextStaff, setsParsedStaff.value, repsParsedStaff.value, recovery || null, notes || null, keyLiftTag || null]
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
