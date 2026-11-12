// Vérifications statiques, lancées par la CI à chaque push et utilisables en local : node scripts/check.mjs
//   1. syntaxe de chaque module JavaScript ;
//   2. chaque import relatif pointe vers un fichier qui existe ;
//   3. le service worker met en cache tous les modules (sinon l'app casse hors ligne) et rien d'inexistant ;
//   4. les fichiers cités par index.html et le manifeste existent ;
//   5. aucune clé d'API ou jeton ne traîne dans le dépôt (il est public).
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const rel = p => relative(ROOT, p);
const errors = [];
const fail = (file, msg) => errors.push(`${file} : ${msg}`);

const walk = dir => readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const jsFiles = walk(join(ROOT, 'js')).filter(f => f.endsWith('.js'));

// 1 et 2
for (const f of [...jsFiles, join(ROOT, 'sw.js')]) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { fail(rel(f), 'erreur de syntaxe\n' + String(e.stderr).trim()); }
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
    if (!existsSync(resolve(dirname(f), m[1]))) fail(rel(f), `import introuvable « ${m[1]} »`);
  }
}

// 3
const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
const shell = [...(sw.match(/const SHELL = \[([\s\S]*?)\];/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(m => m[1]);
if (!shell.length) fail('sw.js', 'liste SHELL introuvable');
for (const u of shell) if (u !== './' && !existsSync(join(ROOT, u))) fail('sw.js', `met en cache un fichier inexistant « ${u} »`);
for (const f of jsFiles) if (!shell.includes(rel(f))) fail('sw.js', `« ${rel(f)} » n'est pas mis en cache : l'app ne démarrerait pas hors ligne`);

// 4
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
for (const m of html.matchAll(/\b(?:src|href)="([^"#:]+)"/g)) if (!existsSync(join(ROOT, m[1]))) fail('index.html', `fichier introuvable « ${m[1]} »`);
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.webmanifest'), 'utf8'));
for (const i of manifest.icons ?? []) if (!existsSync(join(ROOT, i.src))) fail('manifest.webmanifest', `icône introuvable « ${i.src} »`);

// 5 : vraies clés uniquement (les exemples « lin_api_… » des réglages sont trop courts pour correspondre)
const SECRET = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/, 'clé Anthropic'], [/\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/, 'clé OpenAI'],
  [/\blin_api_[A-Za-z0-9]{24,}/, 'clé Linear'], [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'jeton GitHub'], [/\bgithub_pat_[A-Za-z0-9_]{40,}/, 'jeton GitHub'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'clé privée'],
];
let tracked = [];
try { tracked = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean); }
catch { tracked = walk(ROOT).map(rel).filter(f => !f.startsWith('.git/') && !f.includes('/build/')); }
for (const f of tracked) {
  if (/\.(png|jpe?g|icns|woff2?|zip|ico)$/i.test(f) || !existsSync(join(ROOT, f))) continue;
  const text = readFileSync(join(ROOT, f), 'utf8');
  for (const [re, what] of SECRET) if (re.test(text)) fail(f, `contient ce qui ressemble à une ${what}`);
}

if (errors.length) { console.error(`✗ ${errors.length} problème(s)\n- ` + errors.join('\n- ')); process.exit(1); }
console.log(`✓ ${jsFiles.length} modules, ${shell.length} fichiers hors ligne, ${tracked.length} fichiers sans secret`);
