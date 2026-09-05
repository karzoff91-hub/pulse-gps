// /api/gym-sheets.js
// Gestisce le "schede" di allenamento in palestra, i link personali per gli
// atleti/fisio, e l'accesso staff (una credenziale condivisa, ruotabile solo
// da chi conosce OWNER_SECRET).
// GET    -> ?playerName=... restituisce { current, history }
//        -> ?action=token&playerName=... genera/recupera il codice di accesso personale
//        -> ?action=resolve&token=... risolve un codice nel nome del giocatore (pubblico)
//        -> ?action=staff_login_exists verifica se la credenziale staff è già stata creata
// POST   -> { playerName, action:'new_sheet', title } archivia la scheda corrente e ne crea una nuova
//        -> { staffLogin:true, username, password } accesso staff con la credenziale condivisa
//        -> { staffCredentialsSet:true, username, password, ownerSecret } crea/cambia la
//           credenziale condivisa — richiede sempre OWNER_SECRET, non basta essere già loggati
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

// Password con hash + salt (scrypt, dalla libreria nativa Node "crypto",
// niente pacchetti npm in più). Il token di sessione è firmato con HMAC
// usando STAFF_AUTH_SECRET (da impostare su Vercel come le altre chiavi);
// se non è impostata si usa un valore di fallback, ma va configurata.
function hashPassword(password){
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored){
  if(!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(check, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function signStaffToken(username){
  const secret = process.env.STAFF_AUTH_SECRET || 'pulse-dev-secret-da-cambiare';
  const payload = Buffer.from(username).toString('base64');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}
function verifyStaffToken(token){
  if(!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const secret = process.env.STAFF_AUTH_SECRET || 'pulse-dev-secret-da-cambiare';
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const a = Buffer.from(sig, 'hex'), b = Buffer.from(expected, 'hex');
  if(a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return Buffer.from(payload, 'base64').toString('utf8'); } catch(e){ return null; }
}

// Verifica il "codice da amministratore" (OWNER_SECRET, impostato su Vercel
// e noto solo a te) necessario per creare o cambiare la credenziale
// condivisa dello staff. Confronto a tempo costante contro attacchi timing.
function verifyOwnerSecret(secret){
  const expected = process.env.OWNER_SECRET;
  if(!expected) return false; // non configurato: nessuno può cambiare le credenziali finché non lo imposti
  if(!secret || typeof secret !== 'string') return false;
  const a = Buffer.from(secret), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function ensureTables(client){
  // Una SOLA riga (id fisso = 1): la credenziale condivisa di accesso allo
  // staff. Cambiarla richiede sempre OWNER_SECRET — chi conosce solo la
  // credenziale condivisa non può modificarla, solo usarla per accedere.
  await client.query(`
    CREATE TABLE IF NOT EXISTS staff_login (
      id INTEGER PRIMARY KEY DEFAULT 1,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
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

      if (action === 'staff_login_exists') {
        const { rows } = await client.query('SELECT id FROM staff_login WHERE id = 1');
        return res.status(200).json({ Result: 'OK', exists: rows.length > 0 });
      }

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

    if (req.method === 'POST' && req.body && req.body.staffLogin) {
      const { username, password } = req.body;
      if (!username || !password) return res.status(400).json({ error: 'Nome utente e password sono obbligatori.' });
      const { rows } = await client.query('SELECT * FROM staff_login WHERE id = 1');
      if (rows.length === 0) return res.status(404).json({ error: 'Nessuna credenziale configurata ancora.' });
      const row = rows[0];
      if (row.username !== username.trim() || !verifyPassword(password, row.password_hash)) {
        return res.status(401).json({ error: 'Nome utente o password errati.' });
      }
      return res.status(200).json({ Result: 'OK', username: row.username, token: signStaffToken(row.username) });
    }

    if (req.method === 'POST' && req.body && req.body.staffCredentialsSet) {
      const { username, password, ownerSecret } = req.body;
      if (!verifyOwnerSecret(ownerSecret)) return res.status(403).json({ error: 'Codice amministratore errato.' });
      if (!username || !password) return res.status(400).json({ error: 'Nome utente e password sono obbligatori.' });
      if (password.length < 6) return res.status(400).json({ error: 'La password deve avere almeno 6 caratteri.' });
      await client.query(
        `INSERT INTO staff_login (id, username, password_hash) VALUES (1, $1, $2)
         ON CONFLICT (id) DO UPDATE SET username = $1, password_hash = $2, updated_at = NOW()`,
        [username.trim(), hashPassword(password)]
      );
      return res.status(200).json({ Result: 'OK' });
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
