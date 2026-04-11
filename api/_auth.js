export function checkAuth(req, res) {
  const provided = req.headers['x-app-password'];
  if (!process.env.APP_PASSWORD || provided !== process.env.APP_PASSWORD) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}
