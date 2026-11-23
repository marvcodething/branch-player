// Wraps one SourceBuffer with a serial operation queue.
// Every mutation (append/remove) waits for the previous one to finish, which is the only
// safe way to drive a SourceBuffer: touching it while `updating` throws InvalidStateError.
export class TrackBuffer {
  constructor(mediaSource, mime, kind) {
    this.kind = kind;
    this.sb = mediaSource.addSourceBuffer(mime);
    this.sb.mode = 'segments'; // timestamps come from the media + timestampOffset
    this.queue = Promise.resolve();
  }

  #run(op) {
    const p = this.queue.then(() => new Promise((resolve, reject) => {
      const sb = this.sb;
      const done = () => { cleanup(); resolve(); };
      const fail = () => { cleanup(); reject(new Error(`${this.kind} SourceBuffer error`)); };
      const cleanup = () => {
        sb.removeEventListener('updateend', done);
        sb.removeEventListener('error', fail);
      };
      sb.addEventListener('updateend', done);
      sb.addEventListener('error', fail);
      try { op(sb); } catch (e) { cleanup(); reject(e); }
    }));
    this.queue = p.catch(() => {});
    return p;
  }

  // offset: timestampOffset for this clip; [windowStart, windowEnd): drop anything outside the clip.
  append(buffer, { offset, windowStart, windowEnd }) {
    return this.#run(sb => {
      sb.timestampOffset = offset;
      sb.appendWindowEnd = Infinity;          // widen first so start < end always holds
      sb.appendWindowStart = Math.max(0, windowStart);
      sb.appendWindowEnd = windowEnd;
      sb.appendBuffer(buffer);
    });
  }

  remove(start, end) {
    if (end <= start) return Promise.resolve();
    return this.#run(sb => sb.remove(start, end));
  }

  idle() { return this.queue; }

  bufferedStart() { const b = this.sb.buffered; return b.length ? b.start(0) : 0; }

  // End of the contiguous buffered range containing t (or 0 if t is not buffered).
  bufferedEndAt(t) {
    const b = this.sb.buffered;
    for (let i = 0; i < b.length; i++) {
      if (t >= b.start(i) - 0.1 && t < b.end(i)) return b.end(i);
    }
    return 0;
  }
}
