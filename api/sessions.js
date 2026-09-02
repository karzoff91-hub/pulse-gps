export default async function handler(req, res) {
  const user = process.env.KSPORT_USERNAME;
  const pass = process.env.KSPORT_PASSWORD;
  const { teamID, minDate, maxDate } = req.query;

  if (!user || !pass) {
    return res.status(500).json({ error: 'Credenziali K-Sport non configurate.' });
  }
  if (!teamID) {
    return res.status(400).json({ error: 'Parametro teamID mancante.' });
  }

  const auth = Buffer.from(`${user}:${pass}`).toString('base64');
  const params = new URLSearchParams({ teamID });
  if (minDate) params.set('minDate', minDate);
  if (maxDate) params.set('maxDate', maxDate);

  try {
    const url = `https://www.k-sportonline.com/Dynamix/GetSessions?${params.toString()}`;
    const response = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    const data = await response.json();
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Errore nel contattare le API K-Sport', details: err.message });
  }
}
