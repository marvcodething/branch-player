// BranchEngine: seamless branching video on a single <video> element using Media Source Extensions.
//
// The whole experience is ONE continuous media timeline. Each played clip becomes a timeline
// "entry" placed right after the previous one; its segments are appended into the same two
// SourceBuffers (video + audio) with a timestampOffset that shifts the clip into place.
// Because the decoder never stops, there is no seam to hide.
//
// Branching lifecycle for each entry that has 2+ choices:
//   scheduled  → the first segments of every possible next node start prefetching into memory
//   window     → `choicewindow` fires `choiceWindow` seconds before the end; pick() is allowed
//   locked     → `lockLead` seconds before the end the pick (or the default) is committed, the
//                next entry is scheduled, and its (already prefetched) segments are appended
//   handoff    → the first frame of the next entry is presented; the seam is measured
//
// Events: clipstart, choicewindow, pick, locked, handoff, stall, ended, error

import { Emitter } from './Emitter.js';
import { SegmentCache } from './SegmentCache.js';
import { TrackBuffer } from './TrackBuffer.js';

const KINDS = ['video', 'audio'];
// Audio is appended a little past each clip's end. The next clip's audio overwrites the overlap,
// which avoids tiny audio gaps that would otherwise stall MSE playback at the seam.
const AUDIO_OVERLAP = 0.2;
// Guards against float rounding dropping a clip's first or last video frame at the window edges.
const EDGE = 0.002;

export class BranchEngine extends Emitter {
  constructor(video, story, options = {}) {
    super();
    this.video = video;
    this.story = story;
    this.options = {
      bufferAhead: 10,      // seconds of media to keep appended ahead of the playhead
      keepBehind: 8,        // seconds kept behind the playhead before eviction (must exceed one GOP)
      choiceWindow: 5,      // seconds before a clip's end that choices open
      lockLead: 0.75,       // seconds before a clip's end that the choice is committed
      fallback: 'first',    // 'first' | 'random' when the viewer doesn't choose
      prefetchSegments: 2,  // segments per track prefetched for every candidate next node
      baseUrl: '',
      ...story.defaults,
      ...options
    };
    this.frameDur = 1 / (story.fps || 30);
    this.cache = new SegmentCache({ baseUrl: this.options.baseUrl });
    for (const node of Object.values(story.nodes)) {
      for (const k of KINDS) {
        let acc = 0;
        node[k].ends = node[k].segments.map(s => (acc += s.duration));
      }
    }
    this.session = 0;
    this.timeline = [];
  }

  static isSupported(story) {
    return typeof MediaSource !== 'undefined' &&
      MediaSource.isTypeSupported(story.mime.video) &&
      MediaSource.isTypeSupported(story.mime.audio);
  }

  // ---------------------------------------------------------------- lifecycle

  async start() {
    this.stop();
    const session = ++this.session;
    const ms = new MediaSource();
    this.ms = ms;
    const url = URL.createObjectURL(ms);
    this.video.src = url;
    await new Promise(r => ms.addEventListener('sourceopen', r, { once: true }));
    URL.revokeObjectURL(url);
    if (session !== this.session) return;

    this.tracks = {
      video: new TrackBuffer(ms, this.story.mime.video, 'video'),
      audio: new TrackBuffer(ms, this.story.mime.audio, 'audio')
    };
    this.timeline = [];
    this.current = null;
    this.lastFrame = null;
    this.pumping = false;
    this.endCalled = false;
    this.lastEvict = 0;
    this.stallsSinceHandoff = 0;

    this._schedule(this.story.start, 0);
    await this._pump();
    if (session !== this.session) return;

    this._listen(session);
    const cb = (now, meta) => {
      if (session !== this.session) return;
      this._onFrame(meta);
      this.video.requestVideoFrameCallback(cb);
    };
    this.video.requestVideoFrameCallback(cb);
    const loop = () => {
      if (session !== this.session) return;
      this._tick();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    this.interval = setInterval(() => { this._tick(); this._pump(); }, 250); // also runs in background tabs

    return this.video.play(); // may reject under autoplay rules; the caller decides what to show
  }

  stop() {
    this.session++;
    clearInterval(this.interval);
    this.unlisten?.();
    this.unlisten = null;
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.ms = null;
    this.tracks = null;
    this.timeline = [];
    this.current = null;
  }

  setOption(key, value) { this.options[key] = value; }

  // ---------------------------------------------------------------- viewer input

  pick(index) {
    const e = this._entryAt(this.video.currentTime);
    if (!e || e.locked || !e.windowOpen) return false;
    const choice = e.node.choices[index];
    if (!choice) return false;
    e.pick = choice;
    e.pickedRemaining = e.end - this.video.currentTime;
    this.emit('pick', { entry: e, choice });
    return true;
  }

  // Snapshot for UI rendering (call every animation frame).
  getState() {
    const t = this.video.currentTime;
    const e = this._entryAt(t);
    if (!e) return { t, entry: null };
    return {
      t,
      entry: e,
      node: e.node,
      clipTime: t - e.start,
      remaining: e.end - t,
      window: this._windowFor(e),
      windowOpen: e.windowOpen && !e.locked,
      locked: e.locked,
      pick: e.pick,
      choice: e.choice,
      defaultChoice: e.defaultChoice,
      lockIn: e.end - this.options.lockLead - t
    };
  }

  // How much of each candidate next node's start is already in memory.
  prefetchStatus() {
    const e = this._entryAt(this.video.currentTime);
    if (!e) return [];
    const targets = [...new Set(e.node.choices.map(c => c.to))];
    return targets.map(id => {
      const urls = this._prefetchUrls(this.story.nodes[id]);
      return { id, label: this.story.nodes[id].label, ready: urls.filter(u => this.cache.isReady(u)).length, total: urls.length,
               chosen: e.locked && e.choice?.to === id };
    });
  }

  // ---------------------------------------------------------------- timeline

  _schedule(nodeId, start) {
    const node = this.story.nodes[nodeId];
    const e = {
      index: this.timeline.length, id: nodeId, node, start,
      duration: node.duration, end: start + node.duration,
      next: { video: -1, audio: -1 },       // -1 = init segment not appended yet
      windowOpen: false, locked: false, pick: null, choice: null,
      defaultChoice: this._defaultChoice(node)
    };
    this.timeline.push(e);
    for (const c of node.choices) this.cache.prefetch(this._prefetchUrls(this.story.nodes[c.to]));
    return e;
  }

  _prefetchUrls(node) {
    const urls = [];
    for (const k of KINDS) {
      urls.push(node[k].init);
      node[k].segments.slice(0, this.options.prefetchSegments).forEach(s => urls.push(s.url));
    }
    return urls;
  }

  _defaultChoice(node) {
    if (!node.choices.length) return null;
    const mode = node.fallback || this.options.fallback;
    if (mode === 'random') return node.choices[Math.floor(Math.random() * node.choices.length)];
    return node.choices[0];
  }

  _windowFor(e) {
    return Math.min(e.node.choiceWindow ?? this.options.choiceWindow, e.duration);
  }

  _entryAt(t) {
    for (let i = this.timeline.length - 1; i >= 0; i--) {
      const e = this.timeline[i];
      if (t >= e.start && t < e.end) return e;
    }
    // After the very last frame of an ending, stay on the last entry.
    const last = this.timeline[this.timeline.length - 1];
    return last && t >= last.end ? last : null;
  }

  _lock(e, reason) {
    if (e.locked || !e.node.choices.length) return;
    e.locked = true;
    e.lockReason = reason;
    e.choice = e.pick || e.defaultChoice;
    const next = this._schedule(e.choice.to, e.end);
    this.emit('locked', { entry: e, choice: e.choice, next, reason });
    this._pump();
  }

  // ---------------------------------------------------------------- per-frame logic

  _tick() {
    if (!this.tracks) return;
    const t = this.video.currentTime;
    const e = this._entryAt(t);
    if (!e || e.locked) return;
    const n = e.node;
    if (n.choices.length === 1) { this._lock(e, 'linear'); return; }
    if (n.choices.length < 2) return;
    if (!e.windowOpen && t >= e.end - this._windowFor(e)) {
      e.windowOpen = true;
      this.emit('choicewindow', { entry: e, choices: n.choices, prompt: n.prompt, defaultChoice: e.defaultChoice });
    }
    if (t >= e.end - this.options.lockLead) this._lock(e, e.pick ? 'deadline' : 'timeout');
  }

  _onFrame(meta) {
    const e = this._entryAt(meta.mediaTime + EDGE);
    const prev = this.lastFrame;
    if (e && e !== this.current) {
      const from = this.current;
      this.current = e;
      if (from && prev) {
        const frames = Math.max(1, meta.presentedFrames - prev.presentedFrames);
        this.emit('handoff', {
          from: from.id, to: e.id,
          choice: from.choice?.label, auto: !from.pick, pickedRemaining: from.pickedRemaining,
          gapMs: (meta.expectedDisplayTime - prev.expectedDisplayTime) / frames,
          callbacksSkipped: frames > 1,
          frameMs: this.frameDur * 1000,
          firstFrameOffsetMs: (meta.mediaTime - e.start) * 1000,
          stalls: this.stallsSinceHandoff
        });
        this.stallsSinceHandoff = 0;
      }
      this.emit('clipstart', { entry: e });
    }
    this.lastFrame = { mediaTime: meta.mediaTime, expectedDisplayTime: meta.expectedDisplayTime, presentedFrames: meta.presentedFrames };
  }

  _listen(session) {
    const v = this.video;
    const onWaiting = () => {
      if (session !== this.session || v.seeking || !this.current) return; // startup buffering isn't a seam stall
      this.stallsSinceHandoff++;
      this.emit('stall', { time: v.currentTime });
      const e = this._entryAt(v.currentTime);
      if (e && !e.locked && e.node.choices.length) this._lock(e, 'stall'); // never wait on an unlocked choice
      this._pump();
    };
    const onEnded = () => { if (session === this.session) this.emit('ended', {}); };
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('ended', onEnded);
    this.unlisten = () => {
      v.removeEventListener('waiting', onWaiting);
      v.removeEventListener('ended', onEnded);
    };
  }

  // ---------------------------------------------------------------- buffering

  async _pump() {
    if (!this.tracks) return;
    if (this.pumping) { this.pumpAgain = true; return; }
    this.pumping = true;
    const session = this.session;
    try {
      do {
        this.pumpAgain = false;
        await Promise.all(KINDS.map(k => this._fill(k, session)));
        if (session !== this.session) return;
        await this._evict(false);
        await this._maybeEnd(session);
      } while (this.pumpAgain && session === this.session);
    } catch (err) {
      if (session === this.session) this.emit('error', err);
    } finally {
      if (session === this.session) this.pumping = false;
    }
  }

  async _fill(kind, session) {
    const tb = this.tracks[kind];
    for (const e of this.timeline) {
      const tr = e.node[kind];
      while (e.next[kind] < tr.segments.length) {
        if (e.next[kind] >= 0) {
          const appendedUntil = e.start + (e.next[kind] > 0 ? tr.ends[e.next[kind] - 1] : 0);
          if (appendedUntil - this.video.currentTime >= this.options.bufferAhead) return;
        }
        const url = e.next[kind] < 0 ? tr.init : tr.segments[e.next[kind]].url;
        const buf = await this.cache.get(url);
        if (session !== this.session) return;
        await this._append(tb, buf, e, kind);
        if (session !== this.session) return;
        e.next[kind]++;
      }
    }
  }

  async _append(tb, buf, e, kind) {
    const tr = e.node[kind];
    const opts = kind === 'video'
      ? { offset: e.start - tr.startPts, windowStart: e.start - EDGE, windowEnd: e.end + EDGE }
      : { offset: e.start - tr.startPts, windowStart: e.start, windowEnd: e.end + AUDIO_OVERLAP };
    try {
      await tb.append(buf, opts);
    } catch (err) {
      if (err.name !== 'QuotaExceededError') throw err;
      await this._evict(true);
      await tb.append(buf, opts);
    }
  }

  async _evict(force) {
    if (this.endCalled) return;
    const now = this.video.currentTime;
    if (!force && now - this.lastEvict < 5) return;
    this.lastEvict = now;
    // Removal extends to the next keyframe, so always keep more than one segment behind the playhead.
    const cut = now - (force ? 3 : this.options.keepBehind);
    if (cut <= 0) return;
    await Promise.all(KINDS.map(k => {
      const tb = this.tracks[k];
      return cut > tb.bufferedStart() + 0.5 ? tb.remove(0, cut) : null;
    }));
  }

  async _maybeEnd(session) {
    const last = this.timeline[this.timeline.length - 1];
    if (!last || last.node.choices.length || this.endCalled) return;
    if (!KINDS.every(k => last.next[k] >= last.node[k].segments.length)) return;
    this.endCalled = true;
    await Promise.all(KINDS.map(k => this.tracks[k].idle()));
    if (session !== this.session || this.ms.readyState !== 'open') return;
    // Drop the audio overlap past the final frame so the stream ends exactly with the video.
    if (this.ms.duration > last.end) await this.tracks.audio.remove(last.end, this.ms.duration);
    if (session !== this.session || this.ms.readyState !== 'open') return;
    this.ms.endOfStream(); // after this, never append or remove again (either would reopen the stream)
  }
}
