// Viewer UI for published stories: the player and nothing else. Also what an <iframe> embed loads.
// Where the story lives (checked in this order):
//   ?src=<url>      folder holding story.compiled.json (absolute, or relative to this page)
//   ?story=<id>     the dev server's build of that story (add &draft=1 for the draft build)
//   (neither)       the folder this page is in, which is how an exported bundle works
// When hosted in an iframe it reports events to the parent with postMessage; see below.
import { BranchEngine } from '../engine/BranchEngine.js';

const $ = s => document.querySelector(s);
const video = $('#video');
const params = new URLSearchParams(location.search);
let engine = null;
let story = null;
let renderedEntry = null;

function resolveBase() {
  const dir = u => (u.endsWith('/') ? u : u + '/');
  if (params.get('src')) return dir(new URL(params.get('src'), location.href).href);
  if (params.get('story')) return `projects/${encodeURIComponent(params.get('story'))}/${params.get('draft') === '1' ? 'draft/' : ''}`;
  return './';
}

// Host pages listen with: window.addEventListener('message', e => e.data?.source === 'branch-player' && …)
// Payloads carry node ids and labels only, never URLs or segment data.
function notify(type, detail = {}) {
  if (window.parent === window) return;
  window.parent.postMessage({ source: 'branch-player', type, ...detail }, '*');
}
const nodeInfo = id => ({ node: id, label: story.nodes[id]?.label });

async function boot() {
  const baseUrl = resolveBase();
  try {
    const res = await fetch(baseUrl + 'story.compiled.json');
    if (!res.ok) throw new Error('This story has not been built or published yet.');
    story = await res.json();
  } catch (err) {
    $('#startTitle').textContent = "Couldn't load the story";
    $('#startSub').textContent = err.message;
    notify('error', { message: err.message });
    return;
  }
  document.title = story.title || document.title;
  if (!BranchEngine.isSupported(story)) {
    $('#startTitle').textContent = "This browser can't play this story";
    $('#startSub').textContent = "It doesn't support the video format this story was published in.";
    notify('error', { message: 'unsupported' });
    return;
  }

  engine = new BranchEngine(video, story, { baseUrl });
  engine.on('clipstart', ({ entry }) => notify('clipstart', nodeInfo(entry.id)));
  engine.on('choicewindow', ({ entry, choices }) => {
    buildChoices();
    notify('choicewindow', { ...nodeInfo(entry.id), choices: choices.map(c => c.label) });
  });
  engine.on('pick', ({ choice }) => markPicked(choice));
  engine.on('locked', ({ entry, choice }) => {
    markPicked(choice, true);
    if (entry.node.choices.length > 1) notify('choice', { ...nodeInfo(entry.id), choice: choice.label, to: choice.to, auto: !entry.pick });
  });
  engine.on('ended', () => { $('#endCard').hidden = false; notify('ended'); });
  engine.on('error', err => {
    console.error(err);
    $('#startCard').hidden = false;
    $('#startSub').textContent = 'Playback error: ' + err.message;
    notify('error', { message: err.message });
  });

  $('#startTitle').textContent = story.title;
  $('#startSub').textContent = '';
  $('#startBtn').disabled = false;
  requestAnimationFrame(frame);
  notify('ready', { title: story.title });
}

async function start() {
  $('#startCard').hidden = true;
  $('#endCard').hidden = true;
  $('#choices').hidden = true;
  renderedEntry = null;
  try {
    await engine.start();
    notify('started');
  } catch (err) {
    $('#startCard').hidden = false;
    $('#startSub').textContent = 'Playback was blocked: ' + err.message;
  }
}

function buildChoices() {
  const s = engine.getState();
  if (!s.entry) return;
  renderedEntry = s.entry;
  $('#prompt').textContent = s.node.prompt || 'Choose';
  const row = $('#choiceRow');
  row.textContent = '';
  s.node.choices.forEach((ch, i) => {
    const b = document.createElement('button');
    b.className = 'choice';
    b.id = 'choice-' + i;
    const key = document.createElement('kbd');
    key.textContent = i + 1;
    const label = document.createElement('span');
    label.textContent = ch.label; // textContent: labels are author text, never markup
    b.append(key, label);
    b.addEventListener('click', () => engine.pick(i));
    row.appendChild(b);
  });
}

function markPicked(choice, locked = false) {
  const s = engine.getState();
  if (!s.entry || s.entry !== renderedEntry) return;
  s.node.choices.forEach((ch, i) => {
    const b = $('#choice-' + i);
    if (!b) return;
    b.classList.toggle('picked', ch === choice);
    b.disabled = locked;
  });
}

document.addEventListener('keydown', e => {
  if (!engine) return;
  const n = parseInt(e.key, 10);
  if (n >= 1 && n <= 4) engine.pick(n - 1);
});

function frame() {
  const s = engine.getState();
  if (s.entry) {
    const branching = s.node.choices.length > 1;
    const show = branching && s.entry.windowOpen && s.remaining > 0 && s.entry === renderedEntry;
    $('#choices').hidden = !show;
    if (show) $('#countdownBar').style.width = Math.max(0, Math.min(100, (s.lockIn / (s.window - engine.options.lockLead)) * 100)) + '%';
  }
  requestAnimationFrame(frame);
}

$('#startBtn').addEventListener('click', start);
$('#againBtn').addEventListener('click', start);
$('#muteBtn').addEventListener('click', () => {
  video.muted = !video.muted;
  $('#muteBtn').textContent = video.muted ? 'Unmute' : 'Mute';
});
$('#fsBtn').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('#stage').requestFullscreen?.();
});

boot();
