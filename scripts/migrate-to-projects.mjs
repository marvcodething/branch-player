#!/usr/bin/env node
// One-time move from the single-story layout (story.json + media/source/) to projects/demo/.
// Idempotent: does nothing once projects/ exists.

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const projects = path.join(root, 'projects');
const oldStory = path.join(root, 'story.json');
const oldSources = path.join(root, 'media', 'source');

if (fs.existsSync(projects)) { console.log('projects/ already exists, nothing to do.'); process.exit(0); }
if (!fs.existsSync(oldStory)) { console.log('No story.json to migrate.'); process.exit(0); }

const dest = path.join(projects, 'demo');
fs.mkdirSync(path.join(dest, 'source'), { recursive: true });

const story = JSON.parse(fs.readFileSync(oldStory, 'utf8'));
for (const n of Object.values(story.nodes || {})) {
  if (n.source) n.source = n.source.replace(/^media\/source\//, 'source/');
}
fs.writeFileSync(path.join(dest, 'story.json'), JSON.stringify(story, null, 2) + '\n');

if (fs.existsSync(oldSources)) {
  for (const f of fs.readdirSync(oldSources)) fs.renameSync(path.join(oldSources, f), path.join(dest, 'source', f));
  fs.rmSync(oldSources, { recursive: true });
  if (!fs.readdirSync(path.join(root, 'media')).length) fs.rmdirSync(path.join(root, 'media'));
}
fs.rmSync(oldStory);

// Old single-story build output; rebuilt per project by the transcode step.
fs.rmSync(path.join(root, 'public', 'media'), { recursive: true, force: true });
fs.rmSync(path.join(root, 'public', 'story.compiled.json'), { force: true });

console.log('Migrated to projects/demo/. Run `npm run build:media` to rebuild its media.');
