// Build de Studio : produit dans dist/ l'application web complète, prête à servir ou à embarquer.
//   - src/app.ts  -> dist/js/app.js   (un seul fichier, minifié : un aller-retour au lieu de 30 modules)
//   - src/boot.ts -> dist/js/boot.js  (script classique, appliqué avant le premier affichage)
//   - src/sw/sw.ts -> dist/sw.js      (liste des fichiers et version du cache calculées ici)
//   - css minifié ; index.html, manifeste, polices et icônes copiés.
//
// Usage :
//   node scripts/build.ts                 build de production
//   node scripts/build.ts --test          build de test (expose les modules : window.__studio), dans dist-test/
//   node scripts/build.ts --watch --serve reconstruit à chaque modification et sert sur http://localhost:8000
import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const args = new Set(process.argv.slice(2));
const TEST = args.has('--test'), WATCH = args.has('--watch'), SERVE = args.has('--serve');
const OUT = join(ROOT, TEST ? 'dist-test' : 'dist');

const common: esbuild.BuildOptions = {
  bundle: true, minify: true, target: 'es2022', logLevel: 'warning', legalComments: 'none',
  define: { __TEST__: String(TEST) },
};

const walk = (dir: string): string[] => readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });

/** Fichiers statiques, puis service worker avec la liste exacte des fichiers et l'empreinte de leur contenu. */
async function finish(): Promise<void> {
  for (const f of ['index.html', 'manifest.webmanifest']) cpSync(join(ROOT, f), join(OUT, f));
  for (const d of ['fonts', 'icons']) cpSync(join(ROOT, d), join(OUT, d), { recursive: true });
  const files = walk(OUT).map(f => relative(OUT, f)).filter(f => f !== 'sw.js' && !f.endsWith('.map')).sort();
  const hash = createHash('sha256');
  for (const f of files) hash.update(f).update(readFileSync(join(OUT, f)));
  const version = hash.digest('hex').slice(0, 12);
  await esbuild.build({ ...common, entryPoints: [join(ROOT, 'src/sw/sw.ts')], outfile: join(OUT, 'sw.js'), format: 'iife',
    define: { ...common.define, __VERSION__: JSON.stringify(version), __SHELL__: JSON.stringify(['./', ...files]) } });
  const size = (f: string) => `${(statSync(join(OUT, f)).size / 1024).toFixed(1)} Ko`;
  console.log(`✓ ${relative(ROOT, OUT)}/ · app.js ${size('js/app.js')} · app.css ${size('css/app.css')} · cache ${version}`);
}

async function main(): Promise<void> {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const app: esbuild.BuildOptions = { ...common, entryPoints: { 'js/app': join(ROOT, 'src/app.ts'), 'css/app': join(ROOT, 'css/app.css') }, outdir: OUT, format: 'esm', sourcemap: 'linked',
    loader: { '.woff2': 'file' }, external: ['../fonts/*'],
    plugins: [{ name: 'fin', setup(b) { b.onEnd(r => { if (!r.errors.length) return finish(); }); } }] };
  const boot: esbuild.BuildOptions = { ...common, entryPoints: { 'js/boot': join(ROOT, 'src/boot.ts') }, outdir: OUT, format: 'iife' };
  if (!WATCH) { await esbuild.build(boot); await esbuild.build(app); return; }
  const [cb, ca] = await Promise.all([esbuild.context(boot), esbuild.context(app)]);
  await cb.watch(); await ca.watch();
  if (SERVE) { const { port } = await ca.serve({ servedir: OUT, port: 8000 }); console.log(`→ http://localhost:${port}`); }
}

main().catch(e => { console.error(e); process.exit(1); });
