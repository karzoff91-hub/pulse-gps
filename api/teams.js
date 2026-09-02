export default async function handler(req, res) {
  const user = process.env.KSPORT_USERNAME;
  const pass = process.env.KSPORT_PASSWORD;

  if (!user || !pass) {
    return res.status(500).json({
      error: 'Credenziali K-Sport non configurate. Imposta KSPORT_USERNAME e KSPORT_PASSWORD nelle variabili d\'ambiente di Vercel.'
    });
  }

  const auth = Buffer.from(`${user}:${pass}`).toString('base64');

  try {
    const response = await fetch('https://www.k-sportonline.com/Dynamix/GetTeams', {
      headers: { Authorization: `Basic ${auth}` }
    });
    const data = await response.json();
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Errore nel contattare le API K-Sport', details: err.message });
  }
}
