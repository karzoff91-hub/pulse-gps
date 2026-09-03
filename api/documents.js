// /api/documents.js
// Documenti per giocatore (diagnosi, esami clinici/strumentali) — PDF o immagini.
// Gestisce anche le foto profilo dei giocatori (stesso store, tabella separata).
// Lo store Vercel Blob è PRIVATO: i file non sono raggiungibili con un link
// diretto, servono sempre le credenziali del server. Per questo la vista e
// il download passano da questa stessa funzione (?download=1), non da un
// link diretto al file.
// GET    -> ?playerName=... lista documenti di un giocatore
//        -> ?id=123&download=1 restituisce il file vero e proprio
//        -> ?resource=photo&playerName=...&download=1 restituisce la foto profilo
// POST   -> { playerName, docType, title, fileBase64, fileName, mimeType } carica un file
//        -> { playerName, isPhoto:true, fileBase64, fileName, mimeType } carica/sostituisce la foto profilo
// PATCH  -> { id, mode } genera l'analisi/estrazione IA del documento
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
  await client.query(`
    CREATE TABLE IF NOT EXISTS player_photos (
      player_name TEXT PRIMARY KEY,
      blob_url TEXT NOT NULL,
      mime_type TEXT,
      uploaded_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

// I blob dello store privato richiedono il token nell'header Authorization
// per essere letti, anche lato server.
async function fetchPrivateBlob(url){
  return fetch(url, { headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` } });
}

export default async function handler(req, res) {
  const client = getPool();
  try {
    await ensureTable(client);

    if (req.method === 'GET' && req.query.resource === 'photo') {
      const { playerName } = req.query;
      if (!playerName) return res.status(400).json({ error: 'Parametro playerName mancante.' });
      const { rows } = await client.query('SELECT * FROM player_photos WHERE player_name = $1', [playerName]);
      const photo = rows[0];
      if (!photo) return res.status(404).json({ error: 'Nessuna foto per questo giocatore.' });
      if (req.query.download) {
        const fileRes = await fetchPrivateBlob(photo.blob_url);
        if (!fileRes.ok) return res.status(502).json({ error: 'Impossibile scaricare la foto.' });
        const buffer = Buffer.from(await fileRes.arrayBuffer());
        res.setHeader('Content-Type', photo.mime_type || 'image/jpeg');
        res.setHeader('Cache-Control', 'private, max-age=3600');
        return res.status(200).send(buffer);
      }
      return res.status(200).json({ Result: 'OK', hasPhoto: true });
    }

    if (req.method === 'GET' && req.query.download && req.query.id) {
      const { rows } = await client.query('SELECT blob_url, mime_type, title FROM player_documents WHERE id = $1', [req.query.id]);
      const doc = rows[0];
      if (!doc) return res.status(404).json({ error: 'Documento non trovato.' });
      const fileRes = await fetchPrivateBlob(doc.blob_url);
      if (!fileRes.ok) return res.status(502).json({ error: 'Impossibile scaricare il documento.' });
      const buffer = Buffer.from(await fileRes.arrayBuffer());
      res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${(doc.title||'documento').replace(/"/g,'')}"`);
      return res.status(200).send(buffer);
    }

    if (req.method === 'GET') {
      const { playerName } = req.query;
      if (!playerName) return res.status(400).json({ error: 'Parametro playerName mancante.' });
      const { rows } = await client.query(
        'SELECT * FROM player_documents WHERE player_name = $1 ORDER BY uploaded_at DESC',
        [playerName]
      );
      return res.status(200).json({ Result: 'OK', Documents: rows });
    }

    if (req.method === 'POST' && req.body && req.body.isPhoto) {
      const { playerName, fileBase64, fileName, mimeType } = req.body;
      if (!playerName || !fileBase64 || !fileName) {
        return res.status(400).json({ error: 'playerName, fileBase64 e fileName sono obbligatori.' });
      }
      const buffer = Buffer.from(fileBase64, 'base64');
      if (buffer.length > 4 * 1024 * 1024) {
        return res.status(400).json({ error: 'File troppo grande (limite 4 MB).' });
      }
      const finalMime = mimeType || 'image/jpeg';

      const { rows: existing } = await client.query('SELECT blob_url FROM player_photos WHERE player_name = $1', [playerName]);
      if (existing[0]) {
        try { await del(existing[0].blob_url); } catch(e) { /* ignora */ }
      }

      let blob;
      try {
        blob = await put(`photos/${playerName}/${Date.now()}-${fileName}`, buffer, { access: 'private', contentType: finalMime });
      } catch (blobErr) {
        return res.status(500).json({ error: 'Blob Store non collegato o non autorizzato.', details: blobErr.message });
      }

      await client.query(
        `INSERT INTO player_photos (player_name, blob_url, mime_type) VALUES ($1, $2, $3)
         ON CONFLICT (player_name) DO UPDATE SET blob_url = $2, mime_type = $3, uploaded_at = NOW()`,
        [playerName, blob.url, finalMime]
      );
      return res.status(200).json({ Result: 'OK' });
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
          access: 'private',
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
      const { id, mode } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Parametro id mancante.' });

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY non configurata su Vercel.' });

      const { rows: docRows } = await client.query('SELECT * FROM player_documents WHERE id = $1', [id]);
      const doc = docRows[0];
      if (!doc) return res.status(404).json({ error: 'Documento non trovato.' });

      const fileRes = await fetchPrivateBlob(doc.blob_url);
      if (!fileRes.ok) return res.status(502).json({ error: 'Impossibile scaricare il documento per l\'analisi.' });
      const arrayBuffer = await fileRes.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString('base64');
      const mime = doc.mime_type || fileRes.headers.get('content-type') || 'application/pdf';

      const isExtract = mode === 'extract';
      const prompt = isExtract
        ? `Analizza questo documento (${doc.doc_type}, giocatore ${doc.player_name}) ed estrai TUTTI i singoli test, misurazioni o valori numerici che contiene (es. forza muscolare, ROM articolare, test funzionali, punteggi, ecc.).
Rispondi SOLO con un array JSON valido, senza testo prima o dopo, senza markdown, in questo formato esatto:
[{"testName":"nome del test","value":"valore numerico o testuale","unit":"unità di misura o vuoto"}]
Se il documento non contiene test/misurazioni identificabili, rispondi con un array vuoto: []`
        : `Sei un assistente di supporto per uno staff medico/atletico sportivo. Analizza questo documento (${doc.doc_type}, riguardante il giocatore ${doc.player_name}) e fornisci in italiano, in massimo 6-8 frasi:
1) una sintesi dei contenuti principali;
2) possibili implicazioni pratiche per l'allenamento e la riabilitazione del giocatore.
Resta un supporto informativo: non fornire una diagnosi medica formale e non sostituire il parere di un professionista sanitario.`;

      let aiRes, aiData;
      try {
        aiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{
                parts: [
                  { text: prompt },
                  { inline_data: { mime_type: mime, data: base64 } },
                ],
              }],
            }),
          }
        );
        aiData = await aiRes.json();
      } catch (err) {
        return res.status(500).json({ error: 'Errore nella chiamata al servizio AI', details: err.message });
      }
      if (!aiRes.ok) {
        return res.status(502).json({ error: 'Errore dal servizio AI', details: aiData.error?.message || 'sconosciuto' });
      }
      const rawText = (aiData.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();

      if (isExtract) {
        const cleaned = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/,'').replace(/```\s*$/,'').trim();
        let extracted;
        try {
          extracted = JSON.parse(cleaned);
          if (!Array.isArray(extracted)) throw new Error('Formato inatteso');
        } catch (e) {
          return res.status(502).json({ error: 'L\'IA non è riuscita a estrarre i dati in modo leggibile.', details: rawText.slice(0,300) });
        }
        return res.status(200).json({ Result: 'OK', extracted });
      }

      const summary = rawText;
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
