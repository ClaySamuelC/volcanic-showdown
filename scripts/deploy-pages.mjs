// Builds the static client and publishes dist/ to the gh-pages branch of the origin remote.
// Usage: npm run deploy:pages
import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const run = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: 'inherit' });
const out = (cmd, cwd = root) => execSync(cmd, { cwd, encoding: 'utf8' }).trim();

const remote = out('git remote get-url origin');
const name = out('git config user.name') || 'deploy';
const email = out('git config user.email') || 'deploy@example.com';

run('node scripts/build-pages.mjs');
if (existsSync(path.join(dist, '.git'))) rmSync(path.join(dist, '.git'), { recursive: true, force: true });
run('git init -q -b gh-pages', dist);
run(`git -c user.name="${name}" -c user.email="${email}" add -A`, dist);
run(`git -c user.name="${name}" -c user.email="${email}" commit -q -m "Deploy ${new Date().toISOString()}"`, dist);
run(`git push --force "${remote}" gh-pages:gh-pages`, dist);
rmSync(path.join(dist, '.git'), { recursive: true, force: true });
console.log('Published dist/ to gh-pages.');
