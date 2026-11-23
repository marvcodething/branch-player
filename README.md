# Branch Player

Seamless branching video in the browser, built on Media Source Extensions (MSE). The viewer watches one continuous stream; at the end of each clip they pick what happens next, and the next clip continues on the exact next frame with no gap in video or audio.

This is the playback core for a node-based interactive video authoring tool. Right now it contains:

- **A media pipeline** (`scripts/transcode.mjs`) that takes clips in any format ffmpeg can read and compiles a story into uniform, segmented fMP4.
- **The engine** (`public/src/engine/`), a dependency-free ES module that plays a compiled story with seamless branching.
- **A demo UI** (`public/src/ui/app.js`) that shows choices, prefetch state and a per-transition seam log.
- **A story manager** (`public/projects.html`): create, rename and delete stories. Each story has its own `projects/<id>/` folder and its own uploaded clips.
- **A story editor** (`public/editor.html?story=<id>`), a Twine-style map for editing a story: drag nodes, drag links between them to add choices, upload a clip for each node, set the start, then build and play.

## Requirements

- ffmpeg and ffprobe on your PATH (any recent build with libx264; libvpx-vp9 and libopus for the VP9 option)
- Node 18 or newer (the dev server is `scripts/server.mjs`, no dependencies)
- A desktop Chromium-based browser, Firefox or Safari (see Browser support)

## Run the demo

```bash
npm run setup      # generate 6 demo source clips (mixed formats) and transcode them
npm run dev        # stories at http://localhost:8080/projects.html (player: /?story=<id>, editor: /editor.html?story=<id>)
```

MSE needs the page served over HTTP. Opening `index.html` as a file won't work.

## Use your own clips

1. Create a story in the manager, then upload clips from the editor (MOV, MP4, MKV, WebM, M4V; the transcode step re-encodes them all to one format). Uploads belong to that story only. You can also drop files into `projects/<id>/source/` by hand.
2. Edit `projects/<id>/story.json`, either in the editor or by hand: one entry per node with `source`, `label`, `prompt` and `choices`.
3. Click **Play** in the editor, or run `node scripts/transcode.mjs <id>` and reload. Clips whose source and output settings haven't changed are reused; add `--force` to rebuild everything.

### story.json

```jsonc
{
  "title": "My story",
  "start": "intro",                 // id of the first node
  "output": {
    "codec": "h264",                // "h264" (widest support) or "vp9" (royalty-free)
    "width": 1920, "height": 1080,  // every clip is letterboxed to this size
    "fps": 30,                      // every clip is converted to this frame rate
    "crf": 20, "maxrate": "8M",
    "audioBitrate": "128k",
    "segmentSeconds": 2             // segment length = keyframe interval
  },
  "defaults": {
    "choiceWindow": 5,              // seconds before a clip's end that choices open
    "lockLead": 0.75,               // seconds before the end that the choice is committed
    "fallback": "first"             // "first" or "random" when the viewer doesn't pick
  },
  "nodes": {
    "intro": {
      "label": "The Fork",
      "source": "footage/intro.mov",
      "prompt": "Which way?",
      "choices": [ { "label": "Go left", "to": "left" }, { "label": "Go right", "to": "right" } ],
      "choiceWindow": 4,            // optional per-node override
      "fallback": "random"          // optional per-node override
    }
  }
}
```

A node with **no choices** is an ending. A node with **one choice** continues automatically with no UI.

## Share and embed

In the editor, **Export** builds the story at full quality and packages it as a static site (`exports/<id>/` plus `exports/<id>.zip`). The same thing from the command line:

```bash
node scripts/export.mjs <id> [--draft] [--out dir] [--zip]
```

Upload the folder to any static host (Netlify, Cloudflare Pages, S3, GitHub Pages). Its URL is the player; embed it with:

```html
<iframe src="https://YOUR-HOST/<id>/" width="960" height="540" style="border:0;max-width:100%" allow="autoplay; fullscreen" allowfullscreen></iframe>
```

The bundle's `embed.html` repeats the snippet and lists the `postMessage` events the player sends to the host page (`ready`, `started`, `clipstart`, `choicewindow`, `choice`, `ended`, `error`). `_headers` carries cache rules for Netlify and Cloudflare Pages. While developing, `/watch.html?story=<id>` is the same viewer; `?src=<url>` plays a story hosted elsewhere (needs CORS and range requests there).

## How it works

1. **Transcode.** Every clip is converted to the same codec, resolution, frame rate and audio format, then split into 2-second fMP4 segments with a keyframe at the start of each. Video and audio are separate tracks. Clips without audio get a silent track. MSE can only splice media that shares one codec configuration, so this step is what makes the player format-agnostic.
2. **One timeline.** The engine opens one `MediaSource` with one video and one audio `SourceBuffer`. Each clip that plays becomes a timeline entry placed at the previous entry's end time, using `timestampOffset` to shift it into place and append windows to trim it exactly.
3. **Prefetch.** As soon as a clip is scheduled, the first segments of every node it can branch to are downloaded into memory, but not appended.
4. **Choose, then lock.** Choices open `choiceWindow` seconds before the end. At `lockLead` seconds before the end, the pick (or the default) is committed, and the next clip's prefetched segments are appended right after the current clip.
5. **Measure.** `requestVideoFrameCallback` watches presented frames. At each seam it logs the time between the last frame of one clip and the first frame of the next. One frame's duration (33.3 ms at 30 fps) means the seam is invisible.

## Engine API

```js
import { BranchEngine } from './src/engine/BranchEngine.js';

const story = await (await fetch('projects/<id>/story.compiled.json')).json();
if (!BranchEngine.isSupported(story)) { /* show a fallback */ }

const engine = new BranchEngine(videoElement, story, { baseUrl: 'projects/<id>/', lockLead: 0.75 });
engine.on('choicewindow', ({ choices, prompt, defaultChoice }) => { /* show buttons */ });
engine.on('locked', ({ choice }) => { /* disable buttons */ });
engine.on('handoff', h => console.log(h.from, '→', h.to, h.gapMs.toFixed(1), 'ms'));
engine.on('ended', () => { /* show end card */ });

await engine.start();   // call from a click so audio is allowed to play
engine.pick(1);         // while the choice window is open
engine.getState();      // snapshot for rendering: current node, clip time, window, lock countdown…
engine.stop();
```

Events: `clipstart`, `choicewindow`, `pick`, `locked`, `handoff`, `stall`, `ended`, `error`.

## Browser support

Desktop Chrome, Edge, Firefox and Safari all support MSE with H.264/AAC in fMP4. `requestVideoFrameCallback` (used only for seam measurement and precise clip detection) is in Chromium, Safari, and Firefox 132+.

iPhone needs `ManagedMediaSource` (iOS 17.1+). It's the same model with a few extra events; not wired up yet.

## Known limits and next steps

- **One quality level.** Adaptive bitrate needs several renditions per clip plus a bandwidth estimator that picks which rendition's segments to append.
- **Choice changes after lock are ignored.** An alternative is to append the default branch early and `remove()` + re-append if the viewer changes their pick.
- **No seeking UI.** Seeking within the current clip works; seeking across the branching history needs a design decision.
- **Audio at seams** relies on appending a little audio overlap that the next clip overwrites. Test with real dialogue and music beds.
