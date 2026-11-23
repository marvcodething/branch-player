#!/usr/bin/env node
// Packages a built story as a static site you can upload anywhere (Netlify, Cloudflare Pages,
// S3 + CloudFront, GitHub Pages, any web server). No Node, API or editor is needed to play it.
//
// Usage: node scripts/export.mjs <projectId> [--draft] [--out <dir>] [--zip]
// Reads public/projects/<id>/ (run transcode.mjs first) and writes exports/<id>/:
//   index.html, watch.css, src/…   the viewer (public/watch.html) and the engine
//   story.compiled.json, media/    the compiled story
//   _headers                       cache rules understood by Netlify and Cloudflare Pages
//   embed.html                     copy-paste <iframe> snippet and the postMessage events
// --zip also writes exports/<id>.zip.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const outArg = outIdx >= 0 ? argv[outIdx + 1] : null;
const args = argv.filter((a, i) => !a.startsWith('--') && !(outIdx >= 0 && i === outIdx + 1));
const draft = argv.includes('--draft');
const zip = argv.includes('--zip');
const id = args[0];
if (!id || !/^[a-z0-9-]+$/.test(id) || (outIdx >= 0 && !outArg)) {
  console.error('Usage: node scripts/export.mjs <projectId> [--draft] [--out <dir>] [--zip]');
  process.exit(2);
}

const publicDir = path.join(root, 'public');
const builtDir = path.join(publicDir, 'projects', id, ...(draft ? ['draft'] : []));
if (!fs.existsSync(path.join(builtDir, 'story.compiled.json'))) {
  console.error(`No ${draft ? 'draft ' : ''}build for "${id}". Run: node scripts/transcode.mjs ${id}${draft ? ' --draft' : ''}`);
  process.exit(1);
}
const outDir = path.resolve(outArg || path.join(root, 'exports', id));
// Refuse to wipe anything that isn't plainly an export of ours (e.g. --out ~ or the repo root).
if (fs.existsSync(outDir) && fs.readdirSync(outDir).length && !fs.existsSync(path.join(outDir, 'story.compiled.json'))) {
  console.error(`${outDir} exists and doesn't look like a previous export. Choose another --out.`);
  process.exit(1);
}
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const cp = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
};
// The viewer becomes the site's index so the bundle's URL is the player.
cp(path.join(publicDir, 'watch.html'), path.join(outDir, 'index.html'));
cp(path.join(publicDir, 'watch.css'), path.join(outDir, 'watch.css'));
cp(path.join(publicDir, 'src', 'engine'), path.join(outDir, 'src', 'engine'));
cp(path.join(publicDir, 'src', 'ui', 'watch.js'), path.join(outDir, 'src', 'ui', 'watch.js'));
cp(path.join(builtDir, 'story.compiled.json'), path.join(outDir, 'story.compiled.json'));
cp(path.join(builtDir, 'media'), path.join(outDir, 'media'));
// build.json is a transcode cache stamp with absolute local paths; it has no business on a CDN.
for (const f of fs.readdirSync(path.join(outDir, 'media'))) fs.rmSync(path.join(outDir, 'media', f, 'build.json'), { force: true });

// Segment filenames repeat across rebuilds (seg_000.m4s), so media can't be immutable. An hour of
// caching keeps replays cheap; the story JSON is revalidated so a re-publish is seen right away.
fs.writeFileSync(path.join(outDir, '_headers'), [
  '/story.compiled.json', '  Cache-Control: no-cache',
  '/media/*', '  Cache-Control: public, max-age=3600',
  '/src/*', '  Cache-Control: no-cache',
  '/*', '  Access-Control-Allow-Origin: *', ''
].join('\n'));

const story = JSON.parse(fs.readFileSync(path.join(outDir, 'story.compiled.json'), 'utf8'));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
fs.writeFileSync(path.join(outDir, 'embed.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Embed ${esc(story.title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem}pre{background:#f3f3f3;padding:12px;overflow:auto}</style></head>
<body>
<h1>Embed “${esc(story.title)}”</h1>
<p>Upload this whole folder to a static host, then use its URL in place of <code>https://YOUR-HOST/${esc(id)}/</code>.</p>
<pre>&lt;iframe src="https://YOUR-HOST/${esc(id)}/"
  width="960" height="540" style="border:0;max-width:100%"
  allow="autoplay; fullscreen" allowfullscreen&gt;&lt;/iframe&gt;</pre>
<p>The player lives at the folder's URL. To play a story hosted elsewhere, open the viewer with <code>?src=https://other-host/story-folder/</code> (that host must allow CORS and HTTP range requests).</p>
<h2>Events</h2>
<p>The player reports to the host page with <code>postMessage</code>:</p>
<pre>window.addEventListener('message', e => {
  const m = e.data;
  if (m?.source !== 'branch-player') return;
  // m.type: ready | started | clipstart | choicewindow | choice | ended | error
  // m.node, m.label on clip events; m.choice, m.to, m.auto on "choice"
  console.log(m);
});</pre>
<p>Check <code>e.origin</code> against your player's host before trusting a message.</p>
</body></html>
`);

let bytes = 0;
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    e.isDirectory() ? walk(p) : (bytes += fs.statSync(p).size);
  }
})(outDir);
console.log(`Exported "${story.title}" (${draft ? 'draft' : 'full quality'}, ${(bytes / 1024 / 1024).toFixed(1)} MB) → ${path.relative(process.cwd(), outDir) || '.'}`);

if (zip) {
  const zipPath = outDir + '.zip';
  fs.rmSync(zipPath, { force: true });
  const r = spawnSync('zip', ['-qr', zipPath, '.'], { cwd: outDir, encoding: 'utf8' });
  if (r.status !== 0) { console.error(`zip failed: ${r.stderr || r.error?.message || 'zip not installed'}`); process.exit(1); }
  console.log(`Zip → ${path.relative(process.cwd(), zipPath)}`);
}
