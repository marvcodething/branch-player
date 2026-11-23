// Fetches media segments as ArrayBuffers and keeps them in an LRU cache bounded by bytes.
// prefetch() is fire-and-forget; get() returns the same in-flight promise if one exists,
// so a segment is never downloaded twice.
export class SegmentCache {
  constructor({ baseUrl = '', maxBytes = 300 * 1024 * 1024 } = {}) {
    this.baseUrl = baseUrl;
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.entries = new Map(); // url -> { promise, size, buffer }
  }

  get(url) {
    let e = this.entries.get(url);
    if (e) {
      // refresh LRU position
      this.entries.delete(url);
      this.entries.set(url, e);
      return e.promise;
    }
    e = { size: 0, buffer: null };
    e.promise = fetch(this.baseUrl + url)
      .then(r => {
        if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then(buf => {
        e.buffer = buf;
        e.size = buf.byteLength;
        this.bytes += e.size;
        this.#evict();
        return buf;
      })
      .catch(err => {
        this.entries.delete(url);
        throw err;
      });
    this.entries.set(url, e);
    return e.promise;
  }

  prefetch(urls) {
    for (const u of urls) this.get(u).catch(() => {}); // errors surface later on get()
  }

  isReady(url) { return !!this.entries.get(url)?.buffer; }

  #evict() {
    for (const [url, e] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      if (!e.buffer) continue; // never drop in-flight requests
      this.entries.delete(url);
      this.bytes -= e.size;
    }
  }
}
