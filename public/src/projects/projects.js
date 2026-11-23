// Story manager: list, create, rename and delete stories. Everything is stored by the dev server
// (scripts/server.mjs); this page only talks to /api/projects.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let projects = [];
let pendingDelete = null;

function say(text, isErr = false) {
  const el = $('#msg');
  el.textContent = text;
  el.classList.toggle('err', isErr);
}

async function request(path, options) {
  const res = await fetch('/api/projects' + path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

const json = (method, data) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function render() {
  const list = $('#list');
  if (!projects.length) {
    list.innerHTML = '<li class="pm-empty">No stories yet. Create one to start adding clips.</li>';
    return;
  }
  list.innerHTML = projects.map(p => `
    <li class="pm-card" data-id="${esc(p.id)}">
      <input class="pm-title" value="${esc(p.title)}" maxlength="120" aria-label="Story name" title="Click to rename">
      <p class="pm-meta">${plural(p.nodes, 'node')} · ${plural(p.clips, 'clip')} · ${p.built ? 'Built' : '<span class="warn">Not built yet</span>'} · edited ${ago(p.updated)}</p>
      <div class="pm-actions">
        <a class="pm-btn primary" href="editor.html?story=${encodeURIComponent(p.id)}">Edit</a>
        <a class="pm-btn" href="watch.html?story=${encodeURIComponent(p.id)}" ${p.built ? '' : 'aria-disabled="true" tabindex="-1" title="Build it from the editor first (Play)"'}>Play</a>
        <span class="pm-spacer"></span>
        <button class="ed-danger" data-act="delete">Delete</button>
      </div>
    </li>`).join('');
}

async function load(keepMessage = false) {
  try {
    projects = await request('');
    if (!keepMessage) say('');
  } catch (err) {
    projects = [];
    say("Couldn't reach the story API. Start the dev server with `npm run dev`.", true);
  }
  render();
}

// ---------- create ----------
const form = $('#newForm');
$('#newBtn').addEventListener('click', () => {
  form.hidden = false;
  $('#newTitle').value = '';
  $('#newTitle').focus();
});
$('#newCancel').addEventListener('click', () => { form.hidden = true; });
form.addEventListener('keydown', e => { if (e.key === 'Escape') form.hidden = true; });
form.addEventListener('submit', async e => {
  e.preventDefault();
  const title = $('#newTitle').value.trim();
  if (!title) return;
  try {
    const p = await request('', json('POST', { title }));
    location.href = `editor.html?story=${encodeURIComponent(p.id)}`; // straight into the new story
  } catch (err) {
    say(err.message, true);
  }
});

// ---------- rename ----------
const list = $('#list');
list.addEventListener('change', async e => {
  if (!e.target.matches('.pm-title')) return;
  const id = e.target.closest('.pm-card').dataset.id;
  const old = projects.find(p => p.id === id);
  const title = e.target.value.trim();
  if (!title || title === old.title) { e.target.value = old.title; return; }
  try {
    Object.assign(old, await request('/' + encodeURIComponent(id), json('PATCH', { title })));
    say('');
  } catch (err) {
    e.target.value = old.title;
    say(err.message, true);
  }
});
list.addEventListener('keydown', e => {
  if (!e.target.matches('.pm-title')) return;
  if (e.key === 'Enter') e.target.blur();
  if (e.key === 'Escape') {
    e.target.value = projects.find(p => p.id === e.target.closest('.pm-card').dataset.id).title;
    e.target.blur();
  }
});

// ---------- delete ----------
list.addEventListener('click', e => {
  const btn = e.target.closest('button[data-act="delete"]');
  if (!btn) return;
  pendingDelete = projects.find(p => p.id === btn.closest('.pm-card').dataset.id);
  $('#confirmTitle').textContent = `Delete "${pendingDelete.title}"?`;
  $('#confirmText').textContent = `Its ${plural(pendingDelete.clips, 'uploaded clip')} and built media will be removed too. This can't be undone.`;
  $('#confirmOverlay').hidden = false;
  $('#confirmCancel').focus();
});
$('#confirmCancel').addEventListener('click', () => { $('#confirmOverlay').hidden = true; pendingDelete = null; });
$('#confirmOk').addEventListener('click', async () => {
  const p = pendingDelete;
  $('#confirmOverlay').hidden = true;
  pendingDelete = null;
  if (!p) return;
  try {
    await request('/' + encodeURIComponent(p.id), { method: 'DELETE' });
    say(`Deleted "${p.title}".`);
  } catch (err) {
    say(err.message, true);
  }
  await load(true);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#confirmOverlay').hidden) $('#confirmCancel').click();
});

load();
