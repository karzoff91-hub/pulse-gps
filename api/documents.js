// /api/documents.js
// Documenti PDF per giocatore (diagnosi, esami clinici/strumentali).
// Richiede un Vercel Blob Store collegato al progetto. L'autenticazione è
// gestita automaticamente da Vercel (OIDC per store collegati, oppure la
// variabile BLOB_READ_WRITE_TOKEN se presente) — non serve configurare nulla
// a mano oltre a collegare lo store nel tab "Storage" del progetto.
// GET    -> ?playerName=... restituisce i documenti di quel giocatore
// POST   -> { playerName, docType, title, fileBase64, fileName }
// DELETE -> ?id=123

import { put, del } from '@vercel/blob';
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
    CREATE TABLE IF NOT EXISTS player_documents (
      id SERIAL PRIMARY KEY,
      player_name TEXT NOT NULL,
      doc_type TEXT NOT NULL,
      title TEXT,
      blob_url TEXT NOT NULL,
      uploaded_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

export default async function handler(req, res) {
  const client = getPool();
  try {
    await ensureTable(client);

    if (req.method === 'GET') {
      const { playerName } = req.query;
      if (!playerName) return res.status(400).json({ error: 'Parametro playerName mancante.' });
      const { rows } = await client.query(
        'SELECT * FROM player_documents WHERE player_name = $1 ORDER BY uploaded_at DESC',
        [playerName]
      );
      return res.status(200).json({ Result: 'OK', Documents: rows });
    }

    if (req.method === 'POST') {
      const { playerName, docType, title, fileBase64, fileName } = req.body || {};
      if (!playerName || !docType || !fileBase64 || !fileName) {
        return res.status(400).json({ error: 'playerName, docType, fileBase64 e fileName sono obbligatori.' });
      }
      const buffer = Buffer.from(fileBase64, 'base64');
      if (buffer.length > 4 * 1024 * 1024) {
        return res.status(400).json({ error: 'File troppo grande (limite 4 MB).' });
      }

      let blob;
      try {
        blob = await put(`documents/${playerName}/${Date.now()}-${fileName}`, buffer, {
          access: 'public',
          contentType: 'application/pdf',
        });
      } catch (blobErr) {
        return res.status(500).json({ error: 'Blob Store non collegato o non autorizzato. Verifica in Vercel > Storage che sia collegato a questo progetto.', details: blobErr.message });
      }

      const { rows } = await client.query(
        `INSERT INTO player_documents (player_name, doc_type, title, blob_url) VALUES ($1, $2, $3, $4) RETURNING *`,
        [playerName, docType, title || fileName, blob.url]
      );
      return res.status(200).json({ Result: 'OK', Document: rows[0] });
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'Parametro id mancante.' });
      const { rows } = await client.query('SELECT blob_url FROM player_documents WHERE id = $1', [id]);
      if (rows[0]) {
        try { await del(rows[0].blob_url); } catch(e) { /* ignora se già rimosso o non raggiungibile */ }
      }
      await client.query('DELETE FROM player_documents WHERE id = $1', [id]);
      return res.status(200).json({ Result: 'OK' });
    }

    res.status(405).json({ error: 'Metodo non supportato.' });
  } catch (err) {
    res.status(500).json({ error: 'Errore nel salvataggio del documento', details: err.message });
  }
}
