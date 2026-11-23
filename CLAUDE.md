# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Branch Player is the playback core of a future node-based interactive video authoring tool (Bandersnatch-style). Viewers watch one continuous stream and choose what happens next near the end of each clip; the next clip must start on the exact next frame with no visible or audible gap. Target: consumer-grade, high-quality video, desktop browsers first, mobile later.

The playback approach is settled: **Media Source Extensions on a single `<video>` element**. An earlier prototype used two stacked `<video>` elements and measured ~100 ms (3 frames) at every cut because each `play()` restarts a media pipeline. Don't reintroduce multi-element switching. Canvas/WebCodecs is reserved for the future editor (scrubbing, thumbnails, transition previews), not for viewer playback.

## Layout

```
projects/<id>/story.json    one story's authoring source: nodes, choices, output encoding settings
projects/<id>/source/       clips uploaded to that story (never shared between stories)
scripts/transcode.mjs       projects/<id> → public/projects/<id>/story.compiled.json + fMP4 segments
scripts/make-demo-clips.sh  generates mixed-format demo sources in projects/demo/source/
scripts/migrate-to-projects.mjs  one-time move of the old single-story layout into projects/demo
scripts/seam-test.mjs       headless playthrough; fails if any seam isn't one frame
scripts/export.mjs          built story → exports/<id>/ static site (+ .zip): viewer, engine, media, _headers, embed.html
scripts/server.mjs          dev server: static public/ + /api/projects (stories, clip upload, build)
public/watch.html           viewer/embed page (src/ui/watch.js): player only, ?src= / ?story= / &draft=1, postMessage to parent; becomes index.html in an export
public/projects.html        story manager: list, create, rename, delete (src/projects/projects.js)
public/index.html           demo page
public/src/engine/          THE ENGINE (no dependencies, no DOM beyond the <video> it's given)
  BranchEngine.js           timeline, branching lifecycle, buffering, seam measurement
  TrackBuffer.js            serial op queue around one SourceBuffer
  SegmentCache.js           fetch + byte-bounded LRU cache, prefetch
  Emitter.js
public/src/ui/app.js        demo UI; only renders engine state and forwards input
public/editor.html          Twine-style story editor (proof of concept)
public/src/editor/
  storyModel.js             pure story.json operations + validation (no DOM)
  editor.js                 canvas, side panel, save/build/play via /api/*
```

Keep the engine UI-agnostic. UI talks to it only through events, `pick()`, `getState()`, `prefetchStatus()`, `setOption()`. No build step: plain ES modules served statically.

## Commands

- `npm install` once (the only dependency is Playwright, used only by the seam test)
- `npm run setup` generates demo clips and transcodes them (needs ffmpeg/ffprobe). `npm run demo-clips` only regenerates sources; set `FONT=/path/to/font.ttf` if no default font is found.
- `npm run build:media` re-transcodes the demo story (`node scripts/transcode.mjs <projectId> [--force]`). Clips are skipped when `public/projects/<id>/media/<node>/build.json` matches the source's size/mtime and the output settings; `--force` re-encodes all.
- `npm run dev` runs `scripts/server.mjs`: story manager at `/projects.html`, player at `/?story=<id>`, editor at `/editor.html?story=<id>` (MSE doesn't work from file://). It binds to 127.0.0.1 only, since its API writes and deletes files and runs ffmpeg.
- `npm run test:seams` runs the headless seam test against the dev server, which must already be running in another terminal. First `npx playwright install chromium`. Playwright's Chromium lacks H.264/AAC, so either set `CHROME_PATH` to Google Chrome or set `output.codec` to `"vp9"` in `projects/demo/story.json` and rebuild media.
- Shorter or deterministic run: `node scripts/seam-test.mjs [seconds=60] [url] [--pick]`. Without `--pick` it never chooses, so every node takes its fallback path.

Run `npm run test:seams` after any change to the engine or the transcode pipeline. Every seam should report ~33.3 ms at 30 fps (1.00 frames) with 0 stalls. There are no unit tests or linter.

`public/projects/` (build output) and `projects/*/source/` (demo clips and uploads) are gitignored. Don't hand-edit build output; change a story's story.json or the scripts and rebuild.

The seam test drives the demo UI through `#startBtn`, `#choices`, `#choice-N`, `#endCard`, number keys, and reads `window.__branch.log` (set in app.js). Keep those working when changing the UI.

## Invariants: don't break these

1. **Uniform encoding.** All clips in a story share one codec config (codec, profile/level, resolution, fps, pixel format, audio rate/channels). MSE can't splice mismatched media. Format-agnosticism comes from the transcode step, never from the player.
2. **Closed, fixed GOPs.** Keyframe interval = `segmentSeconds × fps`, `-sc_threshold 0`. Every clip and segment starts on a keyframe.
3. **Every clip has audio.** Silent clips get `anullsrc`. A missing audio range stalls the whole MediaSource.
4. **Audio is padded past the video end** (`AUDIO_PAD` in transcode, `AUDIO_OVERLAP` in engine). The next clip's audio overwrites the overlap. An audio gap, even a few ms, can stall playback at the seam. At the final ending the overlap is removed before `endOfStream()`.
5. **`startPts` is computed the way browsers see fMP4:** tfdt + composition offset from the first fragment, ignoring edit lists, which MSE ignores. For AAC, 1024 priming samples are added so the append window trims them. Opus (vp9 profile) uses `audioPriming: 0` because the decoder applies pre-skip. If you change encoders (e.g. fdk-aac uses 2048), update `audioPriming` in the matching `PROFILES` entry.
6. **Append windows:** video `[start − EDGE, end + EDGE]`, audio `[start, end + AUDIO_OVERLAP]`. `EDGE` protects against float rounding dropping a clip's first or last frame.
7. **All SourceBuffer mutations go through `TrackBuffer`'s queue.** Never touch `sb` directly while it may be updating. Both SourceBuffers use `mode = 'segments'` so placement is controlled entirely by `timestampOffset`; edit lists in the fMP4 are ignored by MSE.
   **`appendWindowEnd` must be widened to `Infinity` before setting `appendWindowStart`**, otherwise setting start > current end throws. TrackBuffer does this; any direct append code must too.
8. **Nothing appends or removes after `endOfStream()`**, since that reopens the stream and `ended` never fires. `_evict` checks `endCalled`.
9. **Eviction keeps more than one GOP behind the playhead.** `remove()` extends to the next keyframe, so a small `keepBehind` can delete frames that are about to be shown. Forced eviction in `_evict(true)` hardcodes 3 s, which is only safe while `segmentSeconds` < 3. Raise it if you lengthen segments.
10. **Session guards.** Every async path checks `session === this.session` so a Restart can't let a stale pump append into a new MediaSource.
11. **Never wait on an unlocked choice.** If playback stalls inside a branching clip that isn't locked, lock the default immediately.

## Branching lifecycle (per timeline entry)

scheduled (candidates' first `prefetchSegments` segments start downloading) → `choicewindow` at `end − choiceWindow` → `pick()` allowed → `locked` at `end − lockLead` (next entry scheduled at exactly `end`, its prefetched segments appended) → `handoff` measured on the first presented frame of the next entry. Nodes with one choice lock immediately; nodes with none are endings.

## Roadmap (rough priority)

1. Adaptive bitrate: multiple renditions in transcode (e.g. 1080p/720p/480p on one ladder, same GOP), a bandwidth estimator in `SegmentCache`, rendition choice per appended segment. Audio stays one rendition.
2. Mobile: `ManagedMediaSource` for iOS 17.1+ (handle `startstreaming`/`endstreaming`, set `disableRemotePlayback`).
3. Choice changes after lock: optional speculative append of the default plus `remove()` and re-append on change.
4. State/variables in the story format (flags set by choices, conditional edges), save/resume.
5. The authoring app: node graph editor that writes story.json, triggers transcode (server-side ffmpeg, or ffmpeg.wasm/WebCodecs locally), previews with this engine.

## Conventions

- Plain modern JS (ES2022), no framework in the engine. JSDoc types are welcome; migrate to TypeScript only if asked.
- Comments explain *why* (media quirks, spec behavior), not *what*.
- Keep the demo UI's styles in `public/styles.css`. The editor's color tokens (light and dark) live in `public/editor.css`.

## Editor

- Story ids (`projects/<id>/`) and node ids (`public/projects/<id>/media/<node>/`) are permanent once created because they name directories. `title` / `label` are the editable names.
- Clips belong to exactly one story. `source` in story.json is project-relative (`source/<file>`); the server rejects any path outside that project's `source/` folder, and uploads are streamed to disk and checked with ffprobe. The editor's Upload button and Clips dialog are the only ways to add and remove them.
- Story management is server-side storage on local disk for now (no accounts or cloud). The manager page only talks to `/api/projects`.
- Canvas positions are stored as `nodes[id].editor = {x, y}` in story.json. transcode.mjs copies only the fields it knows, so `editor` never reaches the player.
- The canvas is panned and zoomed by one transform on `#canvas` (`view` in editor.js). Convert pointer coordinates only through `canvasPoint()`, which divides by the scale; never use raw `clientX/Y` or `scrollLeft` for canvas positions.
- Clicking an edge selects it (`selectedEdge = {from, i}`) and shows grips at both ends; dragging a grip onto a card calls `retargetChoice`/`moveChoiceTo`. Clear `selectedEdge` whenever choice indices shift.
- The server's `PUT /api/projects/:id/story` accepts nodes with no `source` so unfinished work can be saved. `validate()` in storyModel.js treats a missing source as an error and disables Play.
