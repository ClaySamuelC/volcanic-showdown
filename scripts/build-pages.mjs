// Assembles the static client into dist/ for GitHub Pages (or any static host).
// Layout mirrors what the Node server serves: public/* at root, plus shared/, game/ and vendor/three.
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(path.join(root, 'public'), dist, { recursive: true });
cpSync(path.join(root, 'shared'), path.join(dist, 'shared'), { recursive: true });
cpSync(path.join(root, 'game'), path.join(dist, 'game'), { recursive: true });
mkdirSync(path.join(dist, 'vendor', 'three', 'build'), { recursive: true });
cpSync(path.join(root, 'node_modules', 'three', 'build', 'three.module.js'), path.join(dist, 'vendor', 'three', 'build', 'three.module.js'));
writeFileSync(path.join(dist, '.nojekyll'), '');
console.log('Static site written to', dist);
