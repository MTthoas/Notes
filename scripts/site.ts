// Sert le site vitrine (site/) en local, sans dépendance : npm run site → http://localhost:4321
// Dans l'app Mac, l'onglet Site du projet fait la même chose d'un clic (native/Shared/Sites.swift).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..', 'site');
const PORT = Number(process.env.PORT) || 4321;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

createServer(async (req, res) => {
  try {
    const path = decodeURIComponent((req.url ?? '/').split(/[?#]/)[0] ?? '/');
    let file = resolve(join(ROOT, path));
    if (file !== ROOT && !file.startsWith(ROOT + sep)) throw new Error('hors du site');
    if (path.split('/').some(p => p.startsWith('.'))) throw new Error('fichier caché');
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Page introuvable.');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`→ http://localhost:${PORT}`));
