// /api/documents.js
// Documenti per giocatore (diagnosi, esami clinici/strumentali) — PDF o immagini.
// Richiede un Vercel Blob Store collegato al progetto.
// GET    -> ?playerName=... restituisce i documenti di quel giocatore
// POST   -> { playerName, docType, title, fileBase64, fileName, mimeType } carica un file
// PATCH  -> { id } genera (o rigenera) l'analisi IA sintetica del documento
//           (richiede ANTHROPIC_API_KEY su Vercel)
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
      mime_type TEXT,
      uploaded_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await client.query(`ALTER TABLE player_documents ADD COLUMN IF NOT EXISTS mime_type TEXT;`);
  await client.query(`ALTER TABLE player_documents ADD COLUMN IF NOT EXISTS ai_summary TEXT;`);
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
      const { playerName, docType, title, fileBase64, fileName, mimeType } = req.body || {};
      if (!playerName || !docType || !fileBase64 || !fileName) {
        return res.status(400).json({ error: 'playerName, docType, fileBase64 e fileName sono obbligatori.' });
      }
      const buffer = Buffer.from(fileBase64, 'base64');
      if (buffer.length > 4 * 1024 * 1024) {
        return res.status(400).json({ error: 'File troppo grande (limite 4 MB).' });
      }
      const finalMime = mimeType || 'application/pdf';

      let blob;
      try {
        blob = await put(`documents/${playerName}/${Date.now()}-${fileName}`, buffer, {
          access: 'public',
          contentType: finalMime,
        });
      } catch (blobErr) {
        return res.status(500).json({ error: 'Blob Store non collegato o non autorizzato.', details: blobErr.message });
      }

      const { rows } = await client.query(
        `INSERT INTO player_documents (player_name, doc_type, title, blob_url, mime_type) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [playerName, docType, title || fileName, blob.url, finalMime]
      );
      return res.status(200).json({ Result: 'OK', Document: rows[0] });
    }

    if (req.method === 'PATCH') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Parametro id mancante.' });

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY non configurata su Vercel.' });

      const { rows: docRows } = await client.query('SELECT * FROM player_documents WHERE id = $1', [id]);
      const doc = docRows[0];
      if (!doc) return res.status(404).json({ error: 'Documento non trovato.' });

      const fileRes = await fetch(doc.blob_url);
      if (!fileRes.ok) return res.status(502).json({ error: 'Impossibile scaricare il documento per l\'analisi.' });
      const arrayBuffer = await fileRes.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString('base64');
      const mime = doc.mime_type || fileRes.headers.get('content-type') || 'application/pdf';

      const contentBlock = mime === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
        : { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } };

      const prompt = `Sei un assistente di supporto per uno staff medico/atletico sportivo. Analizza questo documento (${doc.doc_type}, riguardante il giocatore ${doc.player_name}) e fornisci in italiano, in massimo 6-8 frasi:
1) una sintesi dei contenuti principali;
2) possibili implicazioni pratiche per l'allenamento e la riabilitazione del giocatore.
Resta un supporto informativo: non fornire una diagnosi medica formale e non sostituire il parere di un professionista sanitario.`;

      let aiRes, aiData;
      try {
        aiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 500,
            messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: prompt }] }],
          }),
        });
        aiData = await aiRes.json();
      } catch (err) {
        return res.status(500).json({ error: 'Errore nella chiamata al servizio AI', details: err.message });
      }
      if (!aiRes.ok) {
        return res.status(502).json({ error: 'Errore dal servizio AI', details: aiData.error?.message || 'sconosciuto' });
      }
      const summary = (aiData.content || []).map(c => c.text || '').join('\n').trim();

      await client.query('UPDATE player_documents SET ai_summary = $1 WHERE id = $2', [summary, id]);
      return res.status(200).json({ Result: 'OK', summary });
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'Parametro id mancante.' });
      const { rows } = await client.query('SELECT blob_url FROM player_documents WHERE id = $1', [id]);
      if (rows[0]) {
        try { await del(rows[0].blob_url); } catch(e) { /* ignora se già rimosso */ }
      }
      await client.query('DELETE FROM player_documents WHERE id = $1', [id]);
      return res.status(200).json({ Result: 'OK' });
    }

    res.status(405).json({ error: 'Metodo non supportato.' });
  } catch (err) {
    res.status(500).json({ error: 'Errore nel salvataggio del documento', details: err.message });
  }
}
