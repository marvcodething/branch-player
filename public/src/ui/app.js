// Demo UI for BranchEngine. Everything playback-related lives in ../engine; this file only
// renders engine state and forwards viewer input.
import { BranchEngine } from '../engine/BranchEngine.js';

const $ = s => document.querySelector(s);
const video = $('#video');
const log = [];
let engine = null;
let story = null;
let renderedEntry = null;

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = t => {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  return String(m).padStart(2, '0') + ':' + (t - m * 60).toFixed(2).padStart(5, '0');
};

// ---------- aspect ratio ----------
const stage = $('#stage');
let arMode = 'player';

function applyArMode() {
  if (arMode === 'video' && video.videoWidth && video.videoHeight) {
    stage.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
    video.style.objectFit = 'fill';
  } else {
    stage.style.aspectRatio = '';
    video.style.objectFit = '';
  }
}
video.addEventListener('resize', applyArMode);

// ---------- audio crossfade ----------
// Routes the video element through a Web Audio GainNode so we can schedule a
// gain dip around each seam: 1 → 0 over the last halfFade seconds of the
// outgoing clip, then 0 → 1 over the first halfFade seconds of the incoming.
let audioCtx = null;
let gainNode = null;
let crossfadeEnabled = false;
let crossfadeDuration = 1.0; // total seconds (half before seam, half after)

function initAudio() {
  if (audioCtx) {
    audioCtx.resume();
    return;
  }
  audioCtx = new AudioContext();
  const src = audioCtx.createMediaElementSource(video);
  gainNode = audioCtx.createGain();
  src.connect(gainNode);
  gainNode.connect(audioCtx.destination);
}

function scheduleCrossfade(seamMediaTime) {
  if (!crossfadeEnabled || !gainNode) return;
  const delay = seamMediaTime - video.currentTime;
  if (delay <= 0) return;
  const halfFade = crossfadeDuration / 2;
  const now = audioCtx.currentTime;
  const seam = now + delay;
  const fadeStart = Math.max(now + 0.01, seam - halfFade);

  gainNode.gain.cancelScheduledValues(now);
  gainNode.gain.setValueAtTime(1, now);
  gainNode.gain.setValueAtTime(1, fadeStart);
  gainNode.gain.linearRampToValueAtTime(0, seam);
  gainNode.gain.linearRampToValueAtTime(1, seam + halfFade);
}

function cancelCrossfade() {
  if (!gainNode) return;
  gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
  gainNode.gain.setValueAtTime(1, audioCtx.currentTime);
}

// ---------- boot ----------
async function boot() {
  const params = new URLSearchParams(location.search);
  const storyId = params.get('story');
  if (!storyId) { location.replace('projects.html'); return; }
  // Segment URLs in the compiled story are relative to the story's own build folder.
  const baseUrl = `projects/${encodeURIComponent(storyId)}/${params.get('draft') === '1' ? 'draft/' : ''}`;
  $('#editLink').href = `editor.html?story=${encodeURIComponent(storyId)}`;
  try {
    const res = await fetch(baseUrl + 'story.compiled.json');
    if (!res.ok) throw new Error('This story has not been built yet. Open it in the editor and press Play, or run the transcode step.');
    story = await res.json();
  } catch (err) {
    $('#startTitle').textContent = "Couldn't load the story";
    $('#startSub').textContent = err.message;
    return;
  }
  if (!BranchEngine.isSupported(story)) {
    $('#startTitle').textContent = "This browser can't play this story";
    $('#startSub').textContent = `It doesn't support ${story.mime.video} / ${story.mime.audio} in Media Source Extensions.`;
    return;
  }

  engine = new BranchEngine(video, story, { baseUrl });
  window.__branch = { engine, log };

  engine.on('clipstart', () => { renderNodes(); applyArMode(); });
  engine.on('choicewindow', () => buildChoices());
  engine.on('pick', ({ choice }) => markPicked(choice));
  engine.on('locked', ({ entry, choice }) => {
    markPicked(choice, true);
    scheduleCrossfade(entry.end);
  });
  engine.on('handoff', h => { log.unshift(h); renderLog(); });
  engine.on('ended', () => { $('#endCard').hidden = false; $('#pauseBtn').disabled = true; });
  engine.on('error', err => { console.error(err); $('#pickStatus').textContent = 'Playback error: ' + err.message; });

  initSettings();
  renderNodes();
  $('#storyMeta').textContent = `${story.title} · ${Object.keys(story.nodes).length} nodes · ${story.fps} fps · ${story.mime.video.match(/codecs="([^"]+)"/)?.[1]}`;
  $('#startTitle').textContent = story.title;
  $('#startSub').textContent = "Choices appear near the end of each clip. If you don't pick, the default is taken.";
  $('#startBtn').disabled = false;
  requestAnimationFrame(frame);
  setInterval(renderPrefetch, 250);
}

async function start() {
  initAudio();
  cancelCrossfade();
  $('#startCard').hidden = true;
  $('#endCard').hidden = true;
  $('#choices').hidden = true;
  $('#pauseBtn').disabled = false;
  $('#pauseBtn').textContent = 'Pause';
  $('#restartBtn').disabled = false;
  renderedEntry = null;
  try {
    await engine.start();
  } catch (err) {
    $('#startCard').hidden = false;
    $('#startSub').textContent = 'Playback was blocked: ' + err.message;
  }
}

// ---------- choices ----------
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
    b.innerHTML = `<kbd>${i + 1}</kbd><span>${esc(ch.label)}</span>` + (ch === s.defaultChoice ? '<span class="def">default</span>' : '');
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
  if (!engine || e.target.closest('input, select, textarea')) return;
  const n = parseInt(e.key, 10);
  if (n >= 1 && n <= 4) engine.pick(n - 1);
});

// ---------- per-frame rendering ----------
function frame() {
  const s = engine.getState();
  if (s.entry) {
    const n = s.node, d = s.entry.duration;
    $('#nowName').textContent = n.label;
    $('#timecode').textContent = fmt(s.clipTime) + ' / ' + fmt(d);
    $('#trackHead').style.width = Math.min(100, (s.clipTime / d) * 100) + '%';
    const branching = n.choices.length > 1;
    $('#trackWindow').style.width = branching ? (s.window / d) * 100 + '%' : '0%';
    $('#trackLock').style.right = (engine.options.lockLead / d) * 100 + '%';
    $('#trackLock').hidden = !branching;

    const showChoices = branching && s.entry.windowOpen && s.remaining > 0 && s.entry === renderedEntry;
    $('#choices').hidden = !showChoices;
    if (showChoices) $('#countdownBar').style.width = Math.max(0, Math.min(100, (s.lockIn / (s.window - engine.options.lockLead)) * 100)) + '%';

    let status;
    if (!n.choices.length) status = 'Ending clip';
    else if (n.choices.length === 1) status = 'Continues to ' + story.nodes[n.choices[0].to].label;
    else if (s.locked) status = 'Locked: ' + s.choice.label;
    else if (s.entry.windowOpen) status = (s.pick ? 'Picked ' + s.pick.label : 'Default ' + s.defaultChoice.label) + ' · locks in ' + Math.max(0, s.lockIn).toFixed(1) + ' s';
    else status = 'Choices open in ' + Math.max(0, s.remaining - s.window).toFixed(1) + ' s';
    $('#pickStatus').textContent = status;
  }
  requestAnimationFrame(frame);
}

// ---------- panels ----------
function renderLog() {
  const rows = log.map(h => {
    const frames = h.gapMs / h.frameMs;
    const seamless = h.stalls === 0 && Math.abs(frames - 1) < 0.5;
    const pill = h.stalls ? `<span class="pill warn">stalled ×${h.stalls}</span>`
      : seamless ? '<span class="pill ok">seamless</span>'
      : `<span class="pill cue">${frames.toFixed(1)} frames</span>`;
    const how = h.auto ? 'default' : `picked ${h.pickedRemaining.toFixed(1)} s before end`;
    return `<tr><td>${esc(story.nodes[h.from].label)} → ${esc(story.nodes[h.to].label)}</td>` +
      `<td>${esc(h.choice)} <span class="muted">(${how})</span></td>` +
      `<td class="data">${h.gapMs.toFixed(1)} ms ${pill}${h.callbacksSkipped ? ' <span class="muted">*</span>' : ''}</td>` +
      `<td class="data">${(Math.abs(h.firstFrameOffsetMs) < 0.05 ? 0 : h.firstFrameOffsetMs).toFixed(1)} ms</td></tr>`;
  }).join('');
  $('#log').innerHTML = '<table><thead><tr><th>Transition</th><th>Choice</th><th>Gap between frames</th><th>First frame offset</th></tr></thead><tbody>' + rows + '</tbody></table>';
  const seamless = log.filter(h => h.stalls === 0 && Math.abs(h.gapMs / h.frameMs - 1) < 0.5).length;
  const avg = log.reduce((a, h) => a + h.gapMs, 0) / (log.length || 1);
  $('#summary').innerHTML = `Transitions <b>${log.length}</b> · Seamless <b>${seamless}/${log.length}</b> · Avg gap <b>${avg.toFixed(1)} ms</b> · One frame <b>${(1000 / story.fps).toFixed(1)} ms</b>`;
}

function renderNodes() {
  const s = engine?.getState();
  $('#nodes').innerHTML = Object.entries(story.nodes).map(([id, n]) => {
    const edges = n.choices.length
      ? n.choices.map(c => `<span>${esc(c.label)}</span> → ${esc(story.nodes[c.to].label)}`).join('<br>')
      : 'Ending';
    return `<div class="node${s?.entry?.id === id ? ' is-live' : ''}">` +
      `<div class="node-head"><span class="node-name">${esc(n.label)}</span>` +
      `<span class="data muted">${n.duration.toFixed(2)} s · ${n.video.segments.length} seg · ${esc(n.source)}${n.hasSourceAudio ? '' : ' (silent)'}</span></div>` +
      `<div class="node-edges">${edges}</div></div>`;
  }).join('');
}

function renderPrefetch() {
  if (!engine) return;
  const list = engine.prefetchStatus();
  $('#preload').innerHTML = list.length
    ? list.map(p => {
        const pill = p.chosen ? '<span class="pill ok">appending</span>'
          : p.ready === p.total ? '<span class="pill ok">in memory</span>'
          : '<span class="pill cue">fetching</span>';
        return `<div class="preload-row"><span>${esc(p.label)}</span><span class="data muted">${p.ready}/${p.total} segs</span>${pill}</div>`;
      }).join('')
    : '<p class="empty">No branches from this clip.</p>';
}

function initSettings() {
  const bind = (id, key, fmtOut) => {
    const el = $('#' + id), out = $('#' + id + 'Out');
    el.value = engine.options[key];
    if (out) out.textContent = fmtOut(+el.value);
    el.addEventListener('input', () => {
      const v = el.type === 'range' ? +el.value : el.value;
      engine.setOption(key, v);
      if (out) out.textContent = fmtOut(v);
    });
  };
  bind('choiceWindow', 'choiceWindow', v => v.toFixed(1) + ' s');
  bind('lockLead', 'lockLead', v => v.toFixed(2) + ' s');
  bind('fallback', 'fallback', v => v);

  const arSelect = $('#arMode');
  arSelect.addEventListener('change', () => { arMode = arSelect.value; applyArMode(); });

  const toggle = $('#crossfadeToggle');
  const durSlider = $('#crossfadeDur');
  const durOut = $('#crossfadeDurOut');

  toggle.addEventListener('change', () => {
    crossfadeEnabled = toggle.checked;
    if (!crossfadeEnabled) cancelCrossfade();
  });

  durSlider.addEventListener('input', () => {
    crossfadeDuration = +durSlider.value;
    durOut.textContent = crossfadeDuration.toFixed(1) + ' s';
  });
}

// ---------- controls ----------
$('#startBtn').addEventListener('click', start);
$('#againBtn').addEventListener('click', start);
$('#restartBtn').addEventListener('click', start);
$('#pauseBtn').addEventListener('click', () => {
  if (video.paused) { video.play(); $('#pauseBtn').textContent = 'Pause'; }
  else { video.pause(); $('#pauseBtn').textContent = 'Resume'; }
});
$('#muteBtn').addEventListener('click', () => {
  video.muted = !video.muted;
  $('#muteBtn').textContent = video.muted ? 'Unmute' : 'Mute';
});

boot();
