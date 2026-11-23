// Twine-style story map. Edits story.json through the dev server's API (scripts/server.mjs)
// and builds it with transcode.mjs for the player. All story mutations go through storyModel.js.
import * as M from './storyModel.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SVG = 'http://www.w3.org/2000/svg';

// Which story is open comes from ?story=<id>; without it the manager is the place to pick one.
const storyId = new URLSearchParams(location.search).get('story');
if (!storyId) location.replace('projects.html');
const api = p => `/api/projects/${encodeURIComponent(storyId)}${p}`;

let story = null;
let sources = [];   // clip paths ("source/<file>"), for the Video select and validation
let clips = [];     // the same clips with sizes, for the Clips dialog
let selected = null;
let selectedEdge = null; // { from, i }: the choice whose edge is selected on the canvas
let problems = { errors: {}, warnings: {} };
let saveTimer = null;
let saving = Promise.resolve();
let saveError = null;

const wrap = $('#canvasWrap');
const canvas = $('#canvas');
const cardsEl = $('#cards');
const edgesEl = $('#edges');
const rubber = $('#rubber');

// ---------- persistence ----------
async function load() {
  try {
    const [s, src] = await Promise.all([fetch(api('/story')), fetch(api('/sources'))]);
    if (s.status === 404) return setStatus('This story no longer exists. Go back to the story list.', true);
    if (!s.ok || !src.ok) throw new Error('API not available');
    story = await s.json();
    setClips(await src.json());
  } catch (err) {
    setStatus("Couldn't reach the editor API. Start the dev server with `npm run dev`.", true);
    return;
  }
  story.nodes ||= {};
  if (M.autoLayout(story)) scheduleSave();
  $('#title').value = story.title || '';
  renderAll();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 600);
  renderStatus(); // shows "Unsaved changes…" unless there's an error to explain
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const body = JSON.stringify(story);
  // Chain saves so an older PUT can never land after a newer one.
  saving = saving.then(async () => {
    const res = await fetch(api('/story'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
    saveError = res.ok ? null : (await res.json().catch(() => ({}))).error || `Save failed (${res.status})`;
  }).catch(err => { saveError = err.message; }).then(renderStatus);
  return saving;
}

function changed() {
  renderCards();
  renderEdges();
  renderStatus();
  scheduleSave();
}

// ---------- rendering ----------
function renderAll() {
  renderCards();
  renderEdges();
  renderPanel();
  renderStatus();
}

function cardHtml(id, n) {
  const tags = [];
  if (id === story.start) tags.push('<span class="ed-tag start">Start</span>');
  if (!(n.choices || []).length) tags.push('<span class="ed-tag">End</span>');
  const src = n.source
    ? `<div class="src" title="${esc(n.source)}">${esc(n.source.split('/').pop())}</div>`
    : '<div class="src missing">No video</div>';
  return `<div class="ed-card-head" title="Drag to move"><span class="name">${esc(n.label || id)}</span>${tags.join('')}</div>
    <div class="ed-card-body">${src}<div class="prompt">${esc(n.prompt)}</div></div>
    <div class="ed-handle" title="Drag to another node to add a choice, or to empty space to branch to a new node"></div>`;
}

function renderCards() {
  problems = M.validate(story, sources);
  const seen = M.reachable(story);
  const existing = new Map([...cardsEl.children].map(el => [el.dataset.id, el]));
  for (const [id, n] of Object.entries(story.nodes)) {
    let el = existing.get(id);
    existing.delete(id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'ed-card';
      el.dataset.id = id;
      cardsEl.append(el);
    }
    const html = cardHtml(id, n);
    if (el._html !== html) { el.innerHTML = html; el._html = html; }
    el.style.left = n.editor.x + 'px';
    el.style.top = n.editor.y + 'px';
    el.classList.toggle('sel', id === selected);
    el.classList.toggle('err', !!problems.errors[id]);
    el.classList.toggle('unreachable', !seen.has(id));
  }
  for (const el of existing.values()) el.remove();
}

const center = n => ({ x: n.editor.x + M.CARD_W / 2, y: n.editor.y + M.CARD_H / 2 });

// Point where the ray from the card's center toward (tx, ty) leaves the card, plus a small gap.
function edgePoint(n, tx, ty, gap = 4) {
  const c = center(n);
  const dx = tx - c.x, dy = ty - c.y;
  if (!dx && !dy) return c;
  const t = Math.min((M.CARD_W / 2 + gap) / Math.abs(dx || 1e-9), (M.CARD_H / 2 + gap) / Math.abs(dy || 1e-9));
  return { x: c.x + dx * t, y: c.y + dy * t };
}

// Edge type for the legend: the default (first of several) choice, another choice, or the only
// choice, which the player follows automatically with no UI.
function edgeType(n, i) {
  if (n.choices.length === 1) return 'auto';
  return i === 0 ? 'default' : 'choice';
}
const TYPE_TEXT = { default: 'default choice', choice: 'choice', auto: 'continues automatically' };

function renderEdges() {
  edgesEl.textContent = '';
  $('#links').classList.toggle('has-sel', !!selected);
  const depth = M.depths(story);
  const grips = [];
  for (const [from, n] of Object.entries(story.nodes)) {
    (n.choices || []).forEach((c, i) => {
      const t = story.nodes[c.to];
      if (!t) return;
      const type = edgeType(n, i);
      // A "loop" goes to a node that is not further from the start than this one.
      const loop = depth[from] != null && depth[c.to] != null && depth[c.to] <= depth[from];
      let d, p, q;
      if (c.to === from) {
        // Self-loop: a small arc over the top-right corner.
        const x = n.editor.x + M.CARD_W - 30, y = n.editor.y;
        d = `M ${x} ${y - 4} C ${x} ${y - 50}, ${x + 60} ${y - 50}, ${x + 34} ${y - 4}`;
        p = { x, y: y - 4 };
        q = { x: x + 34, y: y - 4 };
      } else {
        const a = center(n), b = center(t);
        // Loops arc away so they don't run along the forward edges they return across;
        // two-way links bow apart so both arrows stay visible.
        const twoWay = (t.choices || []).some(r => r.to === from);
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const bow = loop ? Math.min(140, 30 + len * 0.2) : twoWay ? 30 : 0;
        const ctrl = { x: (a.x + b.x) / 2 - (b.y - a.y) / len * bow, y: (a.y + b.y) / 2 + (b.x - a.x) / len * bow };
        p = edgePoint(n, ctrl.x, ctrl.y);
        q = edgePoint(t, ctrl.x, ctrl.y, 6);
        d = `M ${p.x} ${p.y} Q ${ctrl.x} ${ctrl.y} ${q.x} ${q.y}`;
      }
      const isPick = selectedEdge?.from === from && selectedEdge.i === i;
      // Wide invisible path underneath for hovering and clicking, carrying the choice text as a tooltip.
      const hit = document.createElementNS(SVG, 'path');
      hit.setAttribute('d', d);
      hit.classList.add('hit');
      hit.dataset.from = from;
      hit.dataset.i = i;
      const title = document.createElementNS(SVG, 'title');
      title.textContent = `${n.label || from} → ${t.label || c.to}` +
        (c.label ? `: "${c.label}"` : '') + ` (${TYPE_TEXT[type]}${loop ? ', loops back' : ''})`;
      hit.append(title);

      const path = document.createElementNS(SVG, 'path');
      path.setAttribute('d', d);
      path.setAttribute('marker-end', `url(#arrow-${type})`);
      path.classList.add('edge', type);
      if (loop) path.classList.add('loop');
      if (from === selected) path.classList.add('sel');
      if (isPick) path.classList.add('pick');
      edgesEl.append(hit, path);
      if (isPick) {
        // Grips go last so they sit above every other edge's hit path.
        for (const [end, pt] of [['source', p], ['target', q]]) {
          const g = document.createElementNS(SVG, 'circle');
          g.setAttribute('cx', pt.x);
          g.setAttribute('cy', pt.y);
          g.setAttribute('r', 7);
          g.classList.add('ed-grip');
          g.dataset.end = end;
          grips.push(g);
        }
      }
    });
  }
  edgesEl.append(...grips);
}

function setStatus(msg, isErr = false) {
  const el = $('#status');
  el.textContent = msg;
  el.classList.toggle('err', isErr);
}

function renderStatus() {
  const errs = Object.entries(problems.errors);
  const warns = Object.values(problems.warnings).flat().length;
  $('#playBtn').disabled = !!errs.length;
  $('#draftBtn').disabled = !!errs.length;
  $('#exportBtn').disabled = !!errs.length;
  $('#playBtn').title = errs.length ? 'Fix the problems first' : 'Save, build and play';
  if (saveError) return setStatus('Not saved: ' + saveError, true);
  if (errs.length) {
    const [id, msgs] = errs[0];
    return setStatus(`${errs.length} node${errs.length > 1 ? 's' : ''} can't be built: ${story.nodes[id]?.label || id}: ${msgs[0]}`, true);
  }
  const n = Object.keys(story.nodes).length;
  setStatus(`${n} nodes${warns ? ` · ${warns} warning${warns > 1 ? 's' : ''}` : ''} · ${saveTimer ? 'Unsaved changes…' : 'Saved'}`);
}

// ---------- side panel ----------
function sourceOptions(current) {
  const opts = ['<option value="">— none —</option>'];
  const list = current && !sources.includes(current) ? [...sources, current] : sources;
  for (const s of list) {
    const missing = !sources.includes(s) ? ' (missing)' : '';
    opts.push(`<option value="${esc(s)}"${s === current ? ' selected' : ''}>${esc(s.split('/').pop())}${missing}</option>`);
  }
  return opts.join('');
}

function nodeOptions(current) {
  return Object.entries(story.nodes)
    .map(([id, n]) => `<option value="${esc(id)}"${id === current ? ' selected' : ''}>${esc(n.label || id)}</option>`)
    .join('');
}

function renderPanel() {
  const n = selected && story.nodes[selected];
  $('#panel').hidden = !n;
  if (!n) return;
  $('#panelTitle').textContent = n.label || selected;
  $('#fLabel').value = n.label || '';
  $('#fId').textContent = `id: ${selected}`;
  $('#fSource').innerHTML = sourceOptions(n.source);
  $('#fPrompt').value = n.prompt || '';
  $('#fWindow').value = n.choiceWindow ?? '';
  $('#fWindow').placeholder = story.defaults?.choiceWindow ?? '';
  $('#fFallback').value = n.fallback || '';
  $('#setStartBtn').disabled = selected === story.start;
  $('#deleteBtn').disabled = selected === story.start;
  $('#deleteBtn').title = selected === story.start ? "The start node can't be deleted" : '';

  const cs = n.choices || [];
  $('#fChoices').innerHTML = cs.length ? cs.map((c, i) => `
    <li class="${i === 0 && cs.length > 1 ? 'default' : ''}${selectedEdge?.from === selected && selectedEdge.i === i ? ' active' : ''}" data-i="${i}">
      <input data-k="label" type="text" value="${esc(c.label)}" placeholder="${cs.length > 1 ? 'Choice text' : 'Continues automatically'}" aria-label="Choice ${i + 1} text">
      <button data-act="del" title="Remove choice" aria-label="Remove choice">Remove</button>
      <div class="row">
        <span class="arrow">→</span>
        <select data-k="to" aria-label="Choice ${i + 1} target">${nodeOptions(c.to)}</select>
        <button data-act="up" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button data-act="down" title="Move down" ${i === cs.length - 1 ? 'disabled' : ''}>↓</button>
      </div>
    </li>`).join('') : '<li class="ed-hint">No choices: this node is an ending.</li>';

  const errs = problems.errors[selected] || [], warns = problems.warnings[selected] || [];
  $('#fProblems').innerHTML = errs.map(m => `<li class="err">${esc(m)}</li>`).join('')
    + warns.map(m => `<li class="warn">${esc(m)}</li>`).join('');
}

function select(id) {
  selected = id && story.nodes[id] ? id : null;
  selectedEdge = null;
  renderCards();
  renderEdges();
  renderPanel();
}

// Selecting an edge also opens its source node's panel, where the choice text is editable.
function selectEdge(from, i) {
  selected = from;
  selectedEdge = { from, i };
  renderCards();
  renderEdges();
  renderPanel();
}

// Text fields update the story without re-rendering the panel, so focus and caret stay put.
$('#fLabel').addEventListener('input', e => {
  story.nodes[selected].label = e.target.value;
  $('#panelTitle').textContent = e.target.value || selected;
  changed();
});
$('#fPrompt').addEventListener('input', e => { story.nodes[selected].prompt = e.target.value; changed(); });
$('#fSource').addEventListener('change', e => {
  M.setSource(story, selected, e.target.value);
  changed();
  renderPanel();
});
$('#fWindow').addEventListener('input', e => {
  const v = parseFloat(e.target.value);
  if (isFinite(v) && v > 0) story.nodes[selected].choiceWindow = v;
  else delete story.nodes[selected].choiceWindow;
  changed();
});
$('#fFallback').addEventListener('change', e => {
  if (e.target.value) story.nodes[selected].fallback = e.target.value;
  else delete story.nodes[selected].fallback;
  changed();
});
$('#fChoices').addEventListener('input', e => {
  const li = e.target.closest('li[data-i]');
  if (!li || e.target.dataset.k !== 'label') return;
  M.updateChoice(story, selected, +li.dataset.i, { label: e.target.value });
  changed();
});
$('#fChoices').addEventListener('change', e => {
  const li = e.target.closest('li[data-i]');
  if (!li || e.target.dataset.k !== 'to') return;
  M.updateChoice(story, selected, +li.dataset.i, { to: e.target.value });
  changed();
  renderPanel();
});
$('#fChoices').addEventListener('click', e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const i = +btn.closest('li').dataset.i;
  if (btn.dataset.act === 'del') M.removeChoice(story, selected, i);
  if (btn.dataset.act === 'up') M.moveChoice(story, selected, i, -1);
  if (btn.dataset.act === 'down') M.moveChoice(story, selected, i, 1);
  selectedEdge = null; // indices just shifted
  changed();
  renderPanel();
});
$('#setStartBtn').addEventListener('click', () => { M.setStart(story, selected); changed(); renderPanel(); });
$('#deleteBtn').addEventListener('click', deleteSelected);
$('#panelClose').addEventListener('click', () => select(null));

function deleteSelected() {
  if (!selected || selected === story.start) return;
  const n = story.nodes[selected];
  if (!confirm(`Delete "${n.label || selected}" and every choice that leads to it?`)) return;
  M.deleteNode(story, selected);
  selected = null;
  selectedEdge = null;
  changed();
  renderPanel();
}

// ---------- clips (uploads belong to this story only) ----------
function setClips(list) {
  clips = list;
  sources = list.map(c => c.path);
}

async function refreshClips() {
  const res = await fetch(api('/sources'));
  if (res.ok) setClips(await res.json());
}

const fmtSize = b => b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' kB';

// XMLHttpRequest, not fetch: fetch can't report upload progress. The file is sent as the raw
// request body so the server can stream it to disk instead of parsing multipart.
function sendClip(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', api('/sources') + '?name=' + encodeURIComponent(file.name));
    xhr.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 201) resolve(body);
      else reject(new Error(body.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Couldn't reach the editor API."));
    xhr.send(file);
  });
}

function chooseFile(onFile) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'video/*,.mkv,.mov,.m4v';
  input.addEventListener('change', () => input.files[0] && onFile(input.files[0]));
  input.click();
}

// Uploads `file`; `ui` = { bar, msg, button } elements to show progress and errors in.
let uploading = false;
async function uploadClip(file, ui, onDone) {
  if (uploading) return;
  uploading = true;
  ui.button.disabled = true;
  ui.bar.hidden = false;
  ui.bar.value = 0;
  ui.msg.textContent = file.name;
  ui.msg.classList.remove('err');
  try {
    const clip = await sendClip(file, f => { ui.bar.value = f; });
    await refreshClips();
    ui.msg.textContent = `Uploaded ${clip.path.split('/').pop()}`;
    await onDone?.(clip);
  } catch (err) {
    ui.msg.textContent = err.message;
    ui.msg.classList.add('err');
  } finally {
    uploading = false;
    ui.button.disabled = false;
    ui.bar.hidden = true;
  }
}

// From the node panel: the new clip becomes that node's video.
const panelUi = { bar: $('#uploadBar'), msg: $('#uploadMsg'), button: $('#uploadBtn') };
function uploadForNode(file) {
  const nodeId = selected; // the selection can change while a big file uploads
  if (!nodeId) return;
  uploadClip(file, panelUi, clip => {
    if (!story.nodes[nodeId]) return;
    M.setSource(story, nodeId, clip.path);
    changed();
    renderPanel();
  });
}
$('#uploadBtn').addEventListener('click', () => chooseFile(uploadForNode));
const videoField = $('#videoField');
videoField.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); videoField.classList.add('drop'); } });
videoField.addEventListener('dragleave', () => videoField.classList.remove('drop'));
videoField.addEventListener('drop', e => {
  e.preventDefault();
  videoField.classList.remove('drop');
  if (e.dataTransfer.files[0]) uploadForNode(e.dataTransfer.files[0]);
});

// Clips dialog: the only place to see sizes and delete a clip.
const clipsUi = { bar: $('#clipsBar'), msg: $('#clipsMsg'), button: $('#clipsUploadBtn') };

function renderClips() {
  const users = {};
  for (const [id, n] of Object.entries(story.nodes)) if (n.source) (users[n.source] ||= []).push(n.label || id);
  $('#clipsList').innerHTML = clips.length ? clips.map(c => `
    <li data-path="${esc(c.path)}">
      <span class="name" title="${esc(c.path)}">${esc(c.path.split('/').pop())}</span>
      <span class="ed-hint">${fmtSize(c.size)}</span>
      <span class="ed-hint used">${users[c.path] ? 'Used by ' + esc(users[c.path].join(', ')) : 'Unused'}</span>
      <button data-act="del" ${users[c.path] ? 'disabled title="Still used by a node"' : ''}>Delete</button>
    </li>`).join('') : '<li class="ed-hint">No clips yet. Upload one, then pick it for a node.</li>';
}

$('#clipsBtn').addEventListener('click', () => { renderClips(); $('#clipsOverlay').hidden = false; });
$('#clipsClose').addEventListener('click', () => { $('#clipsOverlay').hidden = true; });
$('#clipsUploadBtn').addEventListener('click', () => chooseFile(file => uploadClip(file, clipsUi, () => { renderClips(); renderPanel(); })));
$('#clipsList').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-act="del"]');
  if (!btn) return;
  const clipPath = btn.closest('li').dataset.path;
  if (!confirm(`Delete ${clipPath.split('/').pop()} from this story? This can't be undone.`)) return;
  const res = await fetch(api('/sources/' + encodeURIComponent(clipPath.split('/').pop())), { method: 'DELETE' });
  if (!res.ok) {
    clipsUi.msg.textContent = (await res.json().catch(() => ({}))).error || `Delete failed (${res.status})`;
    clipsUi.msg.classList.add('err');
    return;
  }
  clipsUi.msg.textContent = '';
  await refreshClips();
  renderClips();
  renderPanel();
  renderCards();
  renderStatus();
});

// ---------- canvas interactions ----------
// View = pan offset (screen px) and zoom. Everything on the canvas is positioned in canvas units;
// canvasPoint() is the one place that converts pointer coordinates back, so drags stay 1:1 at any zoom.
const MIN_SCALE = 0.25, MAX_SCALE = 2;
const view = { x: 40, y: 40, scale: 1 };

try {
  const v = JSON.parse(localStorage.getItem('editorView'));
  if (v && [v.x, v.y, v.scale].every(Number.isFinite)) Object.assign(view, v, { scale: clampScale(v.scale) });
} catch {}

function clampScale(s) { return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s)); }

function applyView() {
  canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  const s = view.scale;
  wrap.style.backgroundSize = [100, 100, 25, 25].map(g => `${g * s}px ${g * s}px`).join(', ');
  wrap.style.backgroundPosition = `${view.x}px ${view.y}px`;
  $('#zoomLevel').textContent = Math.round(s * 100) + '%';
  try { localStorage.setItem('editorView', JSON.stringify(view)); } catch {}
}

// Zoom keeping the canvas point under (sx, sy), in wrap-relative screen px, fixed.
function zoomAt(sx, sy, scale) {
  scale = clampScale(scale);
  const k = scale / view.scale;
  view.x = sx - (sx - view.x) * k;
  view.y = sy - (sy - view.y) * k;
  view.scale = scale;
  applyView();
}

function zoomCenter(factor) {
  zoomAt(wrap.clientWidth / 2, wrap.clientHeight / 2, view.scale * factor);
}

function fitAll() {
  const ns = Object.values(story?.nodes || {});
  if (!ns.length) return;
  const x0 = Math.min(...ns.map(n => n.editor.x)), y0 = Math.min(...ns.map(n => n.editor.y));
  const x1 = Math.max(...ns.map(n => n.editor.x + M.CARD_W)), y1 = Math.max(...ns.map(n => n.editor.y + M.CARD_H));
  const pad = 60;
  const scale = clampScale(Math.min((wrap.clientWidth - pad * 2) / (x1 - x0), (wrap.clientHeight - pad * 2) / (y1 - y0), 1));
  view.scale = scale;
  view.x = (wrap.clientWidth - (x1 - x0) * scale) / 2 - x0 * scale;
  view.y = (wrap.clientHeight - (y1 - y0) * scale) / 2 - y0 * scale;
  applyView();
}

function canvasPoint(e) {
  const r = wrap.getBoundingClientRect();
  return { x: (e.clientX - r.left - view.x) / view.scale, y: (e.clientY - r.top - view.y) / view.scale };
}

function cardAt(e) {
  return document.elementFromPoint(e.clientX, e.clientY)?.closest('.ed-card');
}

// Canvas position of the visible center, for placing new nodes.
function visibleCenter() {
  const p = canvasPoint({ clientX: wrap.getBoundingClientRect().left + wrap.clientWidth / 2, clientY: wrap.getBoundingClientRect().top + wrap.clientHeight / 2 });
  return { x: p.x - M.CARD_W / 2, y: p.y - M.CARD_H / 2 };
}

wrap.addEventListener('wheel', e => {
  e.preventDefault();
  const r = wrap.getBoundingClientRect();
  if (e.ctrlKey || e.metaKey) { // trackpad pinch arrives as ctrl+wheel
    zoomAt(e.clientX - r.left, e.clientY - r.top, view.scale * Math.exp(-e.deltaY * 0.01));
  } else {
    view.x -= e.deltaX;
    view.y -= e.deltaY;
    applyView();
  }
}, { passive: false });

function startPan(e) {
  e.preventDefault();
  const sx = e.clientX, sy = e.clientY, ox = view.x, oy = view.y;
  let moved = false;
  wrap.classList.add('panning');
  const onMove = ev => {
    if (ev.pointerId !== e.pointerId) return;
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
    moved = true;
    view.x = ox + ev.clientX - sx;
    view.y = oy + ev.clientY - sy;
    applyView();
  };
  const onUp = ev => {
    if (ev.pointerId !== e.pointerId) return;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    wrap.classList.remove('panning');
    if (!moved && e.button === 0) select(null); // a plain click on empty space deselects
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

$('#zoomIn').addEventListener('click', () => zoomCenter(1.25));
$('#zoomOut').addEventListener('click', () => zoomCenter(0.8));
$('#zoomLevel').addEventListener('click', () => zoomCenter(1 / view.scale));
$('#zoomFit').addEventListener('click', fitAll);

function addNodeAt(p) {
  const id = M.addNode(story, p);
  selected = id;
  return id;
}

wrap.addEventListener('pointerdown', e => {
  if (e.button === 1) return startPan(e);
  if (e.button !== 0) return;
  const grip = e.target.closest('.ed-grip');
  if (grip) return startReconnect(e, grip.dataset.end);
  const hit = e.target.closest('.hit');
  if (hit) { e.preventDefault(); return selectEdge(hit.dataset.from, +hit.dataset.i); }
  const card = e.target.closest('.ed-card');
  if (!card) return startPan(e); // empty space: drag pans, a click deselects
  const id = card.dataset.id;

  if (e.target.closest('.ed-handle')) return startLink(e, id);
  startMove(e, card, id); // the whole card drags; a click without movement just selects it
});

function startMove(e, card, id) {
  e.preventDefault();
  const n = story.nodes[id];
  const start = canvasPoint(e), orig = { ...n.editor };
  let moved = false;
  // Listen on window rather than relying only on pointer capture, so a fast drag that leaves
  // the card (or a browser that drops capture) still moves it.
  try { card.setPointerCapture(e.pointerId); } catch {}
  card.classList.add('dragging');
  const onMove = ev => {
    if (ev.pointerId !== e.pointerId) return;
    const p = canvasPoint(ev);
    if (!moved && Math.hypot(p.x - start.x, p.y - start.y) < 3) return;
    moved = true;
    M.setPosition(story, id, orig.x + p.x - start.x, orig.y + p.y - start.y);
    card.style.left = n.editor.x + 'px';
    card.style.top = n.editor.y + 'px';
    renderEdges();
  };
  const onUp = ev => {
    if (ev.pointerId !== e.pointerId) return;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    card.classList.remove('dragging');
    if (moved) { scheduleSave(); renderStatus(); }
    if (selected !== id) select(id);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

// Shared rubber-band drag: draws a dashed line from `anchor` to the pointer, highlights the card
// under it, and reports where it was released. Used to create links and to reconnect edge ends.
function dragConnect(e, anchor, onDrop, { fadeEdge = false } = {}) {
  e.preventDefault();
  let target = null;
  rubber.setAttribute('x1', anchor.x);
  rubber.setAttribute('y1', anchor.y);
  rubber.setAttribute('x2', anchor.x);
  rubber.setAttribute('y2', anchor.y);
  rubber.removeAttribute('hidden'); // SVG elements have no .hidden property
  $('#links').classList.toggle('dragging-edge', fadeEdge);
  wrap.setPointerCapture(e.pointerId);
  const setTarget = el => {
    if (target === el) return;
    target?.classList.remove('drop');
    target = el;
    target?.classList.add('drop');
  };
  const finish = () => {
    wrap.removeEventListener('pointermove', onMove);
    wrap.removeEventListener('pointerup', onUp);
    wrap.removeEventListener('pointercancel', onCancel);
    rubber.setAttribute('hidden', '');
    $('#links').classList.remove('dragging-edge');
    const el = target;
    setTarget(null);
    return el;
  };
  const onMove = ev => {
    const p = canvasPoint(ev);
    rubber.setAttribute('x2', p.x);
    rubber.setAttribute('y2', p.y);
    setTarget(cardAt(ev));
  };
  const onUp = ev => {
    const el = finish();
    onDrop(el, canvasPoint(ev));
  };
  const onCancel = () => finish();
  wrap.addEventListener('pointermove', onMove);
  wrap.addEventListener('pointerup', onUp);
  wrap.addEventListener('pointercancel', onCancel);
}

function startLink(e, from) {
  const n = story.nodes[from];
  const a = { x: n.editor.x + M.CARD_W, y: n.editor.y + M.CARD_H / 2 };
  dragConnect(e, a, (el, p) => {
    if (el && el.dataset.id === from && Math.hypot(p.x - a.x, p.y - a.y) < 30) return; // a click on the handle
    if (el) {
      if (!M.addChoice(story, from, el.dataset.id)) return setStatus('That choice already exists.');
      selected = from;
    } else if (Math.hypot(p.x - a.x, p.y - a.y) > 30) {
      // Dropped on empty canvas: branch to a brand-new node there.
      const id = addNodeAt({ x: p.x - M.CARD_W / 2, y: p.y - M.CARD_H / 2 });
      M.addChoice(story, from, id);
    } else return;
    changed();
    renderPanel();
  });
}

// Drag one end of the selected edge onto another card. Dropping on empty space cancels, so
// deleting an edge is always an explicit Delete.
function startReconnect(e, end) {
  const { from, i } = selectedEdge;
  const choice = story.nodes[from]?.choices?.[i];
  if (!choice) return;
  // The fixed end is the one we're not dragging; the line is hidden behind its card until it leaves it.
  const anchor = center(story.nodes[end === 'target' ? from : choice.to]);
  dragConnect(e, anchor, el => {
    if (!el) return;
    const id = el.dataset.id;
    if (end === 'target') {
      if (id === choice.to) return;
      if (!M.retargetChoice(story, from, i, id)) return setStatus('That choice already exists.');
    } else {
      if (id === from) return;
      if (!M.moveChoiceTo(story, from, i, id)) return setStatus('That choice already exists.');
      selected = id;
      selectedEdge = { from: id, i: story.nodes[id].choices.length - 1 };
    }
    changed();
    renderPanel();
  }, { fadeEdge: true });
}

wrap.addEventListener('dblclick', e => {
  if (e.target.closest('.ed-card, .hit, .ed-grip')) return;
  const p = canvasPoint(e);
  addNodeAt({ x: p.x - M.CARD_W / 2, y: p.y - M.CARD_H / 2 });
  changed();
  renderPanel();
});

$('#addBtn').addEventListener('click', () => {
  addNodeAt(visibleCenter());
  changed();
  renderPanel();
  $('#fLabel').select();
});

document.addEventListener('keydown', e => {
  if (e.target.closest('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selectedEdge) {
      e.preventDefault();
      const { from, i } = selectedEdge;
      selectedEdge = null;
      M.removeChoice(story, from, i);
      changed();
      renderPanel();
    } else if (selected) { e.preventDefault(); deleteSelected(); }
  }
  if (e.key === 'Escape') {
    if (selectedEdge) { selectedEdge = null; renderEdges(); renderPanel(); } else select(null);
  }
  if (e.key === '+' || e.key === '=') zoomCenter(1.25);
  if (e.key === '-') zoomCenter(0.8);
  if (e.key === '0') fitAll();
  if (e.key === '1') zoomCenter(1 / view.scale);
});

$('#title').addEventListener('input', e => { story.title = e.target.value; scheduleSave(); });

// ---------- save / build / play ----------
async function flush() {
  if (saveTimer) save();
  await saving;
  return !saveError;
}

$('#saveBtn').addEventListener('click', () => flush());

$('#playBtn').addEventListener('click', () => buildAndPlay(false));
$('#draftBtn').addEventListener('click', () => buildAndPlay(true));
$('#exportBtn').addEventListener('click', () => buildAndPlay(false, true));

async function buildAndPlay(draft, exporting = false) {
  const overlay = $('#buildOverlay'), log = $('#buildLog'), title = $('#buildTitle'), close = $('#buildClose');
  overlay.hidden = false;
  close.hidden = true;
  $('#openPlayer')?.remove();
  $('#downloadZip')?.remove();
  $('#exportInfo').hidden = true;
  $('#copySnippet').hidden = true;
  title.textContent = 'Saving…';
  log.textContent = '';
  if (!(await flush())) {
    title.textContent = 'Save failed';
    log.textContent = saveError;
    close.hidden = false;
    return;
  }
  title.textContent = exporting ? 'Building and exporting… (unchanged clips are reused)' : draft ? 'Building draft… (480p preview, unchanged clips are reused)' : 'Building… (unchanged clips are reused)';
  let result;
  try {
    const res = await fetch(api(exporting ? '/export' : draft ? '/build?draft=1' : '/build'), { method: 'POST' });
    result = await res.json();
  } catch (err) {
    result = { ok: false, log: err.message };
  }
  log.textContent = result.log;
  log.scrollTop = log.scrollHeight;
  close.hidden = false;
  if (!result.ok) { title.textContent = exporting ? 'Export failed' : 'Build failed'; return; }
  if (exporting) return showExport();
  title.textContent = draft ? 'Draft built' : 'Built';
  // A link, not window.open: the build is async, so a scripted popup would be blocked.
  const a = document.createElement('a');
  a.id = 'openPlayer';
  a.href = `watch.html?story=${encodeURIComponent(storyId)}${draft ? '&draft=1' : ''}`;
  a.target = 'branch-player';
  a.textContent = 'Open player';
  a.className = 'ed-open';
  a.addEventListener('click', () => { overlay.hidden = true; });
  close.before(a);
  a.focus();
}
function showExport() {
  $('#buildTitle').textContent = 'Exported';
  const close = $('#buildClose');
  const zip = document.createElement('a');
  zip.id = 'downloadZip';
  zip.href = api('/export.zip');
  zip.download = `${storyId}.zip`;
  zip.textContent = 'Download .zip';
  zip.className = 'ed-open';
  close.before(zip);
  // The viewer page needs only the folder's own URL, so the snippet is a plain iframe.
  $('#embedSnippet').value = `<iframe src="https://YOUR-HOST/${storyId}/" width="960" height="540" style="border:0;max-width:100%" allow="autoplay; fullscreen" allowfullscreen></iframe>`;
  $('#exportInfo').hidden = false;
  $('#copySnippet').hidden = false;
  zip.focus();
}
$('#copySnippet').addEventListener('click', async () => {
  const box = $('#embedSnippet');
  box.select();
  try { await navigator.clipboard.writeText(box.value); $('#copySnippet').textContent = 'Copied'; }
  catch { document.execCommand?.('copy'); }
  setTimeout(() => { $('#copySnippet').textContent = 'Copy embed code'; }, 1500);
});
$('#buildClose').addEventListener('click', () => { $('#buildOverlay').hidden = true; });

window.addEventListener('beforeunload', e => {
  if (saveTimer) { save(); e.preventDefault(); }
});

applyView(); // after `view` and every handler exist; before load() so the first render is positioned
load();
