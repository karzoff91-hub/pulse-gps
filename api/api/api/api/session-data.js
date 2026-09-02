// /api/session-data.js
// Proxy sicuro per GetSessionData. Uso: 
//   /api/session-data?sessionId=1                        -> tutti i giocatori
//   /api/session-data?sessionId=1&players=gironda         -> solo Gironda
//   /api/session-data?sessionId=1&players=gironda,rossi   -> più giocatori (separati da virgola)

export default async function handler(req, res) {
  const user = process.env.KSPORT_USERNAME;
  const pass = process.env.KSPORT_PASSWORD;
  const { sessionId, opponentData, players } = req.query;

  if (!user || !pass) {
    return res.status(500).json({ error: 'Credenziali K-Sport non configurate.' });
  }
  if (!sessionId) {
    return res.status(400).json({ error: 'Parametro sessionId mancante.' });
  }

  const auth = Buffer.from(`${user}:${pass}`).toString('base64');
  const params = new URLSearchParams({ Session_ID: sessionId });
  if (opponentData) params.set('OpponentData', opponentData);

  try {
    const url = `https://www.k-sportonline.com/Dynamix/GetSessionData?${params.toString()}`;
    const response = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    const data = await response.json();

    // Se il parametro "players" è presente, filtra. Altrimenti restituisce tutti.
    if (players && data && data.Data && Array.isArray(data.Data.Players)) {
      const wanted = players.toLowerCase().split(',').map(p => p.trim());
      data.Data.Players = data.Data.Players.filter(p =>
        wanted.some(w => (p.PlayerName || '').toLowerCase().includes(w))
      );
    }

    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Errore nel contattare le API K-Sport', details: err.message });
  }
}
