// Copy the Stellarium Web Engine build into public/engine/, so the Next.js app
// serves the same /engine/ files FastAPI serves to index.html. Without a local
// build (vendor/stellarium-web-engine/build) the committed copy stays as it is.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const build = join(web, '..', 'vendor', 'stellarium-web-engine', 'build');
const out = join(web, 'public', 'engine');
const files = ['stellarium-web-engine.js', 'stellarium-web-engine.wasm'];

if (!files.every((f) => existsSync(join(build, f)))) {
  console.log('sync-engine: no engine build in vendor/, keeping public/engine as committed.');
} else {
  mkdirSync(out, { recursive: true });
  let changed = 0;
  for (const f of files) {
    const from = join(build, f);
    const to = join(out, f);
    if (existsSync(to) && readFileSync(from).equals(readFileSync(to))) continue;
    copyFileSync(from, to);
    changed++;
  }
  console.log(changed ? `sync-engine: copied ${changed} file(s) from the vendor build.` : 'sync-engine: public/engine is up to date.');
}
