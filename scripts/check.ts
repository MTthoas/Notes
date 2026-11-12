// Vérifications après build, lancées par la CI à chaque push (et en local : npm run check).
//   1. dist/ contient l'app complète, et index.html ne cite que des fichiers qui existent ;
//   2. le service worker met en cache chaque fichier servi (sinon l'app casse hors ligne) ;
//   3. aucune clé d'API ou jeton ne traîne dans le dépôt (il est public).
// La syntaxe et les imports sont vérifiés par TypeScript (npm run typecheck).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const DIST = join(ROOT, 'dist');
const errors: string[] = [];
const fail = (file: string, msg: string): void => { errors.push(`${file} : ${msg}`); };
const walk = (dir: string): string[] => readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });

// 1
if (!existsSync(join(DIST, 'index.html'))) { console.error('✗ dist/ est absent : lance d’abord npm run build'); process.exit(1); }
const html = readFileSync(join(DIST, 'index.html'), 'utf8');
for (const m of html.matchAll(/\b(?:src|href)="([^"#:]+)"/g)) if (m[1] && !existsSync(join(DIST, m[1]))) fail('index.html', `fichier introuvable « ${m[1]} »`);
const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.webmanifest'), 'utf8')) as { icons?: { src: string }[] };
for (const i of manifest.icons ?? []) if (!existsSync(join(DIST, i.src))) fail('manifest.webmanifest', `icône introuvable « ${i.src} »`);

// 2
const served = walk(DIST).map(f => relative(DIST, f)).filter(f => f !== 'sw.js' && !f.endsWith('.map'));
const sw = readFileSync(join(DIST, 'sw.js'), 'utf8');
for (const f of served) if (!sw.includes(JSON.stringify(f))) fail('sw.js', `« ${f} » n'est pas mis en cache : l'app ne démarrerait pas hors ligne`);

// 3 : vraies clés uniquement (les exemples « lin_api_… » des réglages sont trop courts pour correspondre)
const SECRET: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/, 'clé Anthropic'], [/\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/, 'clé OpenAI'],
  [/\blin_api_[A-Za-z0-9]{24,}/, 'clé Linear'], [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'jeton GitHub'], [/\bgithub_pat_[A-Za-z0-9_]{40,}/, 'jeton GitHub'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'clé privée'],
];
const tracked = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
for (const f of tracked) {
  if (/\.(png|jpe?g|icns|woff2?|zip|ico)$/i.test(f) || f === 'package-lock.json' || !existsSync(join(ROOT, f))) continue;
  const text = readFileSync(join(ROOT, f), 'utf8');
  for (const [re, what] of SECRET) if (re.test(text)) fail(f, `contient ce qui ressemble à une ${what}`);
}

if (errors.length) { console.error(`✗ ${errors.length} problème(s)\n- ` + errors.join('\n- ')); process.exit(1); }
console.log(`✓ ${served.length} fichiers servis et mis en cache, ${tracked.length} fichiers sans secret`);
