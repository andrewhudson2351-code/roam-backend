// Admin gate for x-admin-secret routes. Logs every attempt with the client IP
// (trust proxy is set in index.js, so req.ip is the real client, not Railway's
// edge) so admin access — and probes against it — are auditable in the logs.
module.exports = (req, res, next) => {
  const secret = req.headers['x-admin-secret'];
  const ok = secret && secret === process.env.ADMIN_SECRET;
  console.log(`[admin] ${ok ? 'OK  ' : 'DENY'} ${req.method} ${req.originalUrl} ip=${req.ip} ua="${(req.headers['user-agent'] || '').slice(0, 80)}"`);
  if (!ok) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  next();
};
