#!/usr/bin/env node
// Dev server: serves public/ (the player, the editor, the story manager) and the API they use
// to manage stories ("projects"), upload clips and run the transcode step.
//
//   projects/<id>/story.json       authoring source
//   projects/<id>/source/<file>    clips uploaded to that story (never shared between stories)
//   public/projects/<id>/          build output (generated)
//
// Usage: node scripts/server.mjs [port=8080]
// Binds to 127.0.0.1 only: the API writes and deletes files and runs ffmpeg.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const publicDir = path.join(root, 'public');
const projectsDir = path.join(root, 'projects');
const builtDir = path.join(publicDir, 'projects');
const port = Number(process.argv[2] || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4', '.m4s': 'video/iso.segment', '.m3u8': 'application/vnd.apple.mpegurl',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'
};
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v']);
const MAX_UPLOAD = 4 * 1024 ** 3;
const ID_RE = /^[a-z0-9-]{1,60}$/;

// Encoding settings and defaults for a new story. Every clip in a story is re-encoded to these
// (CLAUDE.md invariant 1), so they live in the story, not in the player.
const NEW_STORY = {
  output: { codec: 'h264', width: 1280, height: 720, fps: 30, crf: 22, maxrate: '5M', audioBitrate: '128k', segmentSeconds: 2 },
  defaults: { choiceWindow: 5, lockLead: 0.75, fallback: 'first' }
};

// Inside `base`, or null. Stops ../ and absolute paths from escaping.
function within(base, rel) {
  const p = path.resolve(base, rel);
  return p === base || p.startsWith(base + path.sep) ? p : null;
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  // no-store so the player always sees the story.compiled.json from the latest build
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const readJson = async req => { try { return JSON.parse(await readBody(req)); } catch { return null; } };

// ---------- projects ----------
// The folder of an existing project, or null for a bad or unknown id.
function projectDir(id) {
  if (!ID_RE.test(id)) return null;
  const dir = within(projectsDir, id);
  return dir && fs.existsSync(path.join(dir, 'story.json')) ? dir : null;
}

const readStory = dir => JSON.parse(fs.readFileSync(path.join(dir, 'story.json'), 'utf8'));

function writeStory(dir, story) {
  const file = path.join(dir, 'story.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(story, null, 2) + '\n');
  fs.renameSync(file + '.tmp', file); // atomic, so a crash never leaves a half-written story
}

function listClips(dir) {
  const src = path.join(dir, 'source');
  if (!fs.existsSync(src)) return [];
  return fs.readdirSync(src)
    .filter(f => VIDEO_EXT.has(path.extname(f).toLowerCase()))
    .sort()
    .map(f => ({ path: path.posix.join('source', f), size: fs.statSync(path.join(src, f)).size }));
}

function summary(id) {
  const dir = path.join(projectsDir, id);
  const story = readStory(dir);
  return {
    id, title: story.title || id,
    nodes: Object.keys(story.nodes || {}).length,
    clips: listClips(dir).length,
    built: fs.existsSync(path.join(builtDir, id, 'story.compiled.json')),
    updated: fs.statSync(path.join(dir, 'story.json')).mtimeMs
  };
}

function listProjects() {
  if (!fs.existsSync(projectsDir)) return [];
  return fs.readdirSync(projectsDir)
    .filter(id => projectDir(id))
    .map(summary)
    .sort((a, b) => b.updated - a.updated);
}

function newId(title) {
  const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'story';
  let id = slug, n = 2;
  while (fs.existsSync(path.join(projectsDir, id))) id = `${slug}-${n++}`;
  return id;
}

// Structural checks only. A node without a source is allowed so work in progress can be saved;
// the editor blocks Play until every node has one, and transcode.mjs rejects it anyway.
function validateStory(s, dir) {
  if (!s || typeof s !== 'object' || !s.nodes || typeof s.nodes !== 'object') return 'Missing nodes';
  if (!s.nodes[s.start]) return `Start node "${s.start}" does not exist`;
  const sourceRoot = path.join(dir, 'source');
  for (const [id, n] of Object.entries(s.nodes)) {
    if (!/^[\w-]+$/.test(id)) return `Invalid node id "${id}"`;
    for (const c of n.choices || []) {
      if (!s.nodes[c.to]) return `${id}: choice "${c.label}" points to missing node "${c.to}"`;
    }
    if (n.source) {
      // Clips belong to one story: a source must be inside this project's source folder.
      const src = within(dir, n.source);
      if (!src || !src.startsWith(sourceRoot + path.sep) || !fs.existsSync(src)) return `${id}: source not found: ${n.source}`;
    }
  }
  return null;
}

function cleanClipName(name) {
  const base = path.basename(String(name || '')).replace(/[^\w.\- ]/g, '_').replace(/^\.+/, '').trim();
  const ext = path.extname(base).toLowerCase();
  if (!VIDEO_EXT.has(ext)) return null;
  return { stem: base.slice(0, base.length - ext.length).slice(0, 80) || 'clip', ext };
}

// Streams the request body to disk (clips are large), then checks that ffprobe sees a video track.
async function uploadClip(req, res, dir, query) {
  const parts = cleanClipName(query.get('name'));
  if (!parts) return send(res, 415, { error: `Unsupported file type. Use ${[...VIDEO_EXT].join(', ')}.` });
  const declared = Number(req.headers['content-length']);
  if (declared > MAX_UPLOAD) return send(res, 413, { error: 'File is larger than 4 GB.' });

  const srcDir = path.join(dir, 'source');
  fs.mkdirSync(srcDir, { recursive: true });
  let name = parts.stem + parts.ext, n = 2;
  while (fs.existsSync(path.join(srcDir, name))) name = `${parts.stem}-${n++}${parts.ext}`;
  const final = path.join(srcDir, name), part = final + '.part';

  let size = 0;
  const limit = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      cb(size > MAX_UPLOAD ? new Error('File is larger than 4 GB.') : null, chunk);
    }
  });
  try {
    await pipeline(req, limit, fs.createWriteStream(part));
  } catch (err) {
    fs.rmSync(part, { force: true });
    return res.headersSent || res.destroyed ? undefined : send(res, 400, { error: err.message });
  }
  const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', part], { encoding: 'utf8' });
  if (probe.error) {
    fs.rmSync(part, { force: true });
    return send(res, 500, { error: 'ffprobe is not available, so the clip could not be checked.' });
  }
  if (probe.status !== 0 || !probe.stdout.includes('video')) {
    fs.rmSync(part, { force: true });
    return send(res, 415, { error: 'That file has no readable video track.' });
  }
  fs.renameSync(part, final);
  return send(res, 201, { path: path.posix.join('source', name), size });
}

let building = null; // id of the project being built; one build at a time
function runScript(script, scriptArgs) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', script), ...scriptArgs], { cwd: root });
    let log = '';
    child.stdout.on('data', d => { log += d; process.stdout.write(d); });
    child.stderr.on('data', d => { log += d; process.stderr.write(d); });
    child.on('close', code => resolve({ ok: code === 0, log }));
    child.on('error', err => resolve({ ok: false, log: log + String(err) }));
  });
}
const build = (id, draft = false) => runScript('transcode.mjs', [id, ...(draft ? ['--draft'] : [])]);

async function api(req, res, route, query) {
  const seg = route.split('/').filter(Boolean).slice(1).map(decodeURIComponent); // after "api"
  if (seg[0] !== 'projects') return send(res, 404, { error: 'Not found' });
  const m = req.method;

  if (seg.length === 1) {
    if (m === 'GET') return send(res, 200, listProjects());
    if (m === 'POST') {
      const body = await readJson(req);
      const title = String(body?.title ?? '').trim().slice(0, 120);
      if (!title) return send(res, 400, { error: 'A story needs a name.' });
      const id = newId(title);
      const dir = path.join(projectsDir, id);
      fs.mkdirSync(path.join(dir, 'source'), { recursive: true });
      writeStory(dir, {
        title, start: 'start', ...structuredClone(NEW_STORY),
        nodes: { start: { label: 'Start', source: '', prompt: '', choices: [], editor: { x: 100, y: 100 } } }
      });
      return send(res, 201, summary(id));
    }
    return send(res, 405, { error: 'Method not allowed' });
  }

  const id = seg[1], dir = projectDir(id);
  if (!dir) return send(res, 404, { error: 'No such story.' });
  const sub = seg[2];

  if (!sub) {
    if (m === 'GET') return send(res, 200, summary(id));
    if (m === 'PATCH') {
      const body = await readJson(req);
      const title = String(body?.title ?? '').trim().slice(0, 120);
      if (!title) return send(res, 400, { error: 'A story needs a name.' });
      const story = readStory(dir);
      story.title = title;
      writeStory(dir, story);
      return send(res, 200, summary(id));
    }
    if (m === 'DELETE') {
      if (building === id) return send(res, 409, { error: 'This story is being built. Try again when it finishes.' });
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(path.join(builtDir, id), { recursive: true, force: true });
      fs.rmSync(path.join(root, 'exports', id), { recursive: true, force: true });
      fs.rmSync(path.join(root, 'exports', id + '.zip'), { force: true });
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { error: 'Method not allowed' });
  }

  if (sub === 'story') {
    if (m === 'GET') return send(res, 200, fs.readFileSync(path.join(dir, 'story.json'), 'utf8'));
    if (m === 'PUT') {
      const story = await readJson(req);
      if (!story) return send(res, 400, { error: 'Invalid JSON' });
      const err = validateStory(story, dir);
      if (err) return send(res, 400, { error: err });
      writeStory(dir, story);
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { error: 'Method not allowed' });
  }

  if (sub === 'sources') {
    if (seg.length === 3 && m === 'GET') return send(res, 200, listClips(dir));
    if (seg.length === 3 && m === 'POST') return uploadClip(req, res, dir, query);
    if (seg.length === 4 && m === 'DELETE') {
      const file = seg[3];
      if (file !== path.basename(file)) return send(res, 400, { error: 'Bad file name.' });
      const rel = path.posix.join('source', file);
      const users = Object.entries(readStory(dir).nodes || {}).filter(([, n]) => n.source === rel).map(([nid, n]) => n.label || nid);
      if (users.length) return send(res, 409, { error: `Still used by: ${users.join(', ')}` });
      fs.rmSync(path.join(dir, rel), { force: true });
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { error: 'Method not allowed' });
  }

  if (sub === 'build' && m === 'POST') {
    if (building) return send(res, 409, { ok: false, log: 'A build is already running.' });
    building = id;
    try { return send(res, 200, await build(id, query.get('draft') === '1')); } finally { building = null; }
  }
  // Full-quality build, then package it as a static site. The zip is what gets uploaded to a host.
  if (sub === 'export' && m === 'POST') {
    if (building) return send(res, 409, { ok: false, log: 'A build is already running.' });
    building = id;
    try {
      const built = await build(id);
      if (!built.ok) return send(res, 200, built);
      const exported = await runScript('export.mjs', [id, '--zip']);
      return send(res, 200, { ok: exported.ok, log: built.log + '\n' + exported.log, zip: exported.ok });
    } finally { building = null; }
  }
  if (sub === 'export.zip' && m === 'GET') {
    const zipPath = path.join(root, 'exports', id + '.zip');
    if (!fs.existsSync(zipPath)) return send(res, 404, { error: 'Nothing exported yet.' });
    res.writeHead(200, {
      'Content-Type': 'application/zip', 'Content-Length': fs.statSync(zipPath).size,
      'Content-Disposition': `attachment; filename="${id}.zip"`, 'Cache-Control': 'no-store'
    });
    return fs.createReadStream(zipPath).pipe(res);
  }
  return send(res, 404, { error: 'Not found' });
}

function serveStatic(req, res, route) {
  let rel = decodeURIComponent(route);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = within(publicDir, '.' + rel);
  if (!file) return send(res, 403, 'Forbidden', 'text/plain');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size, 'Cache-Control': 'no-store'
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// A page on another origin could otherwise POST/DELETE to this local API from the user's browser.
function crossOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host !== req.headers.host; } catch { return true; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;
  try {
    const safe = req.method === 'GET' || req.method === 'HEAD';
    if (!safe && crossOrigin(req)) return send(res, 403, { error: 'Cross-origin request refused.' });
    if (route.startsWith('/api/')) return await api(req, res, route, url.searchParams);
    if (!safe) return send(res, 405, 'Method not allowed', 'text/plain');
    serveStatic(req, res, route);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: err.message });
  }
});
server.requestTimeout = 0; // clips are large; Node's default 5-minute cap would cut slow uploads
server.listen(port, '127.0.0.1', () => {
  console.log(`Stories  http://localhost:${port}/projects.html\nPlayer   http://localhost:${port}/?story=<id>   (viewer/embed: /watch.html?story=<id>)\nEditor   http://localhost:${port}/editor.html?story=<id>`);
});
