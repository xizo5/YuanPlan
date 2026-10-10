import fs from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
const entries = Object.entries(lock.packages).filter(([name, p]) => name.includes('node_modules/') && !p.link);
const lines = ['# Third-party notices', '', 'YuanPlan is licensed under MIT. Dependencies retain their own copyrights and licenses.', '', 'This file is generated from package-lock.json by npm run licenses:generate.', 'The installed dependency license texts are also included in the built web application at /third-party-notices.txt and retained in the container node_modules directories.', 'Platform-specific packages are redistributed only when installed for the target platform; their package license files remain authoritative.', '', '| Package | Version | Declared license |', '| --- | --- | --- |'];
const texts = ['YuanPlan third-party license notices', '', 'Generated for the installed dependencies. Original package copyright and license texts follow.', 'Dependencies with no separate license file retain the license declaration shown in THIRD_PARTY_NOTICES.md and their original package metadata.', ''];
for (const [directory, pkg] of entries.sort(([a], [b]) => a.localeCompare(b, 'en'))) {
  const name = directory.split('node_modules/').at(-1);
  lines.push(`| [${name}](https://www.npmjs.com/package/${name}/v/${pkg.version}) | ${pkg.version} | ${pkg.license ?? 'See original package'} |`);
  const base = path.join(root, directory);
  let files;
  try { files = await fs.readdir(base); } catch { continue; }
  for (const file of files.filter(f => /^(license|licence|copying|notice)(\.[^.]+)?$/i.test(f)).sort()) {
    const info = await fs.stat(path.join(base, file));
    if (!info.isFile()) continue;
    texts.push(`\n${'='.repeat(72)}\n${name}@${pkg.version} — ${file}\n${'='.repeat(72)}\n`);
    texts.push(await fs.readFile(path.join(base, file), 'utf8'));
  }
}
await fs.writeFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), lines.join('\n') + '\n');
await fs.writeFile(path.join(root, 'apps/web/public/third-party-notices.txt'), texts.join('\n') + '\n');
console.log(`Generated notices for ${entries.length} locked dependency entries`);
