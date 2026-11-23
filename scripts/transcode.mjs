#!/usr/bin/env node
// Compiles a project's story.json into a playable package for the MSE engine:
//   - transcodes every node's source (any format ffmpeg reads) to ONE uniform codec/resolution/fps
//   - writes separate video and audio fMP4 (CMAF-style) tracks, split into segments
//   - guarantees every clip has an audio track (silence if the source has none)
//   - writes public/projects/<id>/story.compiled.json with durations, segment lists and timestamp info
//
// Usage: node scripts/transcode.mjs <projectId> [--force] [--draft] [--jobs N]
// Reads projects/<id>/story.json (node sources are relative to that folder) and writes to
// public/projects/<id>/. Clips whose source and output settings haven't changed since the last
// build are reused (fingerprint in media/<node>/build.json); --force re-encodes everything.
// --draft builds a fast, low-quality preview into public/projects/<id>/draft/ (its own cache, so it
// never invalidates the full-quality build). --jobs N encodes N clips at once (default 2).
// Requires ffmpeg + ffprobe on PATH.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const argv = process.argv.slice(2);
const jobsIdx = argv.indexOf('--jobs');
const jobsArg = jobsIdx >= 0 ? argv[jobsIdx + 1] : null;
const args = argv.filter((a, i) => !a.startsWith('--') && !(jobsIdx >= 0 && i === jobsIdx + 1));
const force = argv.includes('--force');
const draft = argv.includes('--draft');
// x264/VP9 already use every core for one clip, so more than a couple of clips at once mostly
// adds contention. The second job fills the gaps (probe, audio, muxing) between video encodes.
const jobs = Math.max(1, parseInt(jobsArg ?? '2', 10) || 2);
const projectId = args[0];
if (!projectId || !/^[a-z0-9-]+$/.test(projectId)) {
  console.error('Usage: node scripts/transcode.mjs <projectId> [--force] [--draft] [--jobs N]');
  process.exit(2);
}
const projectDir = path.join(root, 'projects', projectId);
const storyPath = path.join(projectDir, 'story.json');
const outDir = path.join(root, 'public', 'projects', projectId, ...(draft ? ['draft'] : []));
const story = JSON.parse(fs.readFileSync(storyPath, 'utf8'));
const O = {
  codec: 'h264', width: 1920, height: 1080, fps: 30, crf: 20, maxrate: '8M',
  audioBitrate: '128k', segmentSeconds: 2, ...story.output
};
// Draft keeps fps and segmentSeconds: the GOP/segment invariants must hold for previews too.
if (draft) {
  const scale = Math.min(1, 854 / O.width);
  O.width = Math.round(O.width * scale / 2) * 2;
  O.height = Math.round(O.height * scale / 2) * 2;
  O.crf = Math.max(O.crf, 28);
  O.maxrate = '2M';
  O.audioBitrate = '64k';
}
// Audio is encoded slightly longer than the video and trimmed by the player's append window.
// Overlap is harmless (the next clip's audio overwrites it); a gap would stall MSE playback.
const AUDIO_PAD = 0.25;

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    console.error(`\n${cmd} ${args.join(' ')}\n${r.stderr}`);
    throw new Error(`${cmd} failed`);
  }
  return r.stdout;
}
function runAsync(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) return resolve();
      console.error(`\n${cmd} ${args.join(' ')}\n${stderr}`);
      reject(new Error(`${cmd} failed`));
    });
  });
}
function probe(file) {
  return JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
}

// ---- codec profiles: must match the MIME strings the browser checks with isTypeSupported ----
function h264Level() {
  const px = O.width * O.height;
  if (px <= 1280 * 720 && O.fps <= 30) return { level: '3.1', hex: '1f' };
  if (px <= 1920 * 1080 && O.fps <= 30) return { level: '4.0', hex: '28' };
  if (px <= 1920 * 1080) return { level: '4.2', hex: '2a' };
  return { level: '5.1', hex: '33' };
}
const PROFILES = {
  h264: () => {
    const { level, hex } = h264Level();
    return {
      mime: { video: `video/mp4; codecs="avc1.6400${hex}"`, audio: 'audio/mp4; codecs="mp4a.40.2"' },
      video: ['-c:v', 'libx264', '-profile:v', 'high', '-level:v', level, '-preset', draft ? 'veryfast' : 'medium',
              '-crf', String(O.crf), '-maxrate', O.maxrate, '-bufsize', String(parseFloat(O.maxrate) * 2) + 'M'],
      audio: ['-c:a', 'aac', '-b:a', O.audioBitrate],
      // ffmpeg's AAC encoder prepends 1024 "priming" samples. Browsers ignore the edit list that
      // would hide them in fMP4, so the player skips them itself via the append window.
      audioPriming: 1024 / 48000
    };
  },
  // Royalty-free path. Also plays in open-source Chromium builds, which lack H.264/AAC.
  vp9: () => ({
    mime: { video: 'video/mp4; codecs="vp09.00.40.08"', audio: 'audio/mp4; codecs="opus"' },
    video: ['-c:v', 'libvpx-vp9', '-crf', String(O.crf + 10), '-b:v', O.maxrate, '-row-mt', '1',
            '-deadline', 'good', '-cpu-used', draft ? '8' : '4'],
    audio: ['-c:a', 'libopus', '-b:a', O.audioBitrate],
    audioPriming: 0 // Opus pre-skip is signalled in the codec config and applied by the decoder
  })
};
const P = PROFILES[O.codec]?.();
if (!P) throw new Error(`Unknown output.codec "${O.codec}" (use h264 or vp9)`);

function hlsArgs(dir) {
  return ['-f', 'hls', '-hls_time', String(O.segmentSeconds), '-hls_playlist_type', 'vod',
    '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', path.join(dir, 'seg_%03d.m4s'), path.join(dir, 'index.m3u8')];
}
function readPlaylist(dir, relBase) {
  const lines = fs.readFileSync(path.join(dir, 'index.m3u8'), 'utf8').split('\n');
  const segments = [];
  let dur = null;
  for (const l of lines) {
    if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8));
    else if (l && !l.startsWith('#') && dur != null) {
      segments.push({ url: `${relBase}/${l.trim()}`, duration: dur });
      dur = null;
    }
  }
  return { init: `${relBase}/init.mp4`, segments };
}
// Presentation time of the first frame, computed the way an MSE demuxer sees it:
// (tfdt baseMediaDecodeTime + composition offset) / timescale, minimum over the first fragment.
// Edit lists are ignored here because browsers ignore them for fragmented MP4 in MSE.
function* boxes(buf, start = 0, end = buf.length) {
  let o = start;
  while (o + 8 <= end) {
    let size = buf.readUInt32BE(o), hdr = 8;
    const type = buf.toString('latin1', o + 4, o + 8);
    if (size === 1) { size = Number(buf.readBigUInt64BE(o + 8)); hdr = 16; }
    if (size === 0) size = end - o;
    yield { type, start: o + hdr, end: o + size };
    o += size;
  }
}
function find(buf, pathTypes, start = 0, end = buf.length) {
  const [head, ...rest] = pathTypes;
  for (const b of boxes(buf, start, end)) {
    if (b.type === head) return rest.length ? find(buf, rest, b.start, b.end) : b;
  }
  return null;
}
function firstPts(dir) {
  const init = fs.readFileSync(path.join(dir, 'init.mp4'));
  const mdhd = find(init, ['moov', 'trak', 'mdia', 'mdhd']);
  const v = init[mdhd.start];
  const timescale = init.readUInt32BE(mdhd.start + (v === 1 ? 20 : 12));
  const trex = find(init, ['moov', 'mvex', 'trex']);
  let defDur = trex ? init.readUInt32BE(trex.start + 12) : 0;

  const seg = fs.readFileSync(path.join(dir, 'seg_000.m4s'));
  const tfhd = find(seg, ['moof', 'traf', 'tfhd']);
  const tfFlags = seg.readUInt32BE(tfhd.start) & 0xffffff;
  let q = tfhd.start + 8;
  if (tfFlags & 0x1) q += 8;
  if (tfFlags & 0x2) q += 4;
  if (tfFlags & 0x8) defDur = seg.readUInt32BE(q);
  const tfdt = find(seg, ['moof', 'traf', 'tfdt']);
  const tv = seg[tfdt.start];
  let dts = tv === 1 ? Number(seg.readBigUInt64BE(tfdt.start + 4)) : seg.readUInt32BE(tfdt.start + 4);
  const trun = find(seg, ['moof', 'traf', 'trun']);
  const trv = seg[trun.start], flags = seg.readUInt32BE(trun.start) & 0xffffff;
  const count = seg.readUInt32BE(trun.start + 4);
  let o = trun.start + 8;
  if (flags & 0x1) o += 4;
  if (flags & 0x4) o += 4;
  let min = Infinity;
  for (let i = 0; i < count; i++) {
    let dur = defDur, cto = 0;
    if (flags & 0x100) { dur = seg.readUInt32BE(o); o += 4; }
    if (flags & 0x200) o += 4;
    if (flags & 0x400) o += 4;
    if (flags & 0x800) { cto = trv === 1 ? seg.readInt32BE(o) : seg.readUInt32BE(o); o += 4; }
    min = Math.min(min, dts + cto);
    dts += dur;
  }
  return min / timescale;
}

const compiled = {
  title: story.title, start: story.start, defaults: story.defaults || {},
  fps: O.fps, mime: P.mime, nodes: {}
};
const exists = new Set(Object.keys(story.nodes));

// Validate everything up front so a typo fails in milliseconds, not after the first clips encode.
const plan = Object.entries(story.nodes).map(([id, node]) => {
  for (const c of node.choices || []) if (!exists.has(c.to)) throw new Error(`${id}: choice "${c.label}" points to missing node "${c.to}"`);
  const src = path.resolve(projectDir, node.source || '');
  if (!node.source || !src.startsWith(projectDir + path.sep)) throw new Error(`${id}: invalid source: ${node.source}`);
  if (!fs.existsSync(src)) throw new Error(`${id}: source not found: ${node.source}`);
  return { id, node, src };
});

async function buildNode({ id, node, src }) {
  const info = probe(src);
  const hasAudio = info.streams.some(s => s.codec_type === 'audio');
  const nodeDir = path.join(outDir, 'media', id);
  const vDir = path.join(nodeDir, 'video'), aDir = path.join(nodeDir, 'audio');
  const stamp = path.join(nodeDir, 'build.json');
  const st = fs.statSync(src);
  const fingerprint = JSON.stringify({ src, size: st.size, mtime: st.mtimeMs, O, P });
  const cached = !force && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === fingerprint;

  if (!cached) {
    fs.rmSync(nodeDir, { recursive: true, force: true });
    fs.mkdirSync(vDir, { recursive: true }); fs.mkdirSync(aDir, { recursive: true });
    // Video: normalize size (letterbox, never stretch), frame rate and pixel format.
    // Fixed GOP = one keyframe per segment, no scene-cut keyframes, so segments are uniform.
    const gop = Math.round(O.fps * O.segmentSeconds);
    const videoJob = runAsync('ffmpeg', ['-y', '-v', 'error', '-i', src, '-map', '0:v:0', '-an',
      '-vf', `scale=${O.width}:${O.height}:force_original_aspect_ratio=decrease,pad=${O.width}:${O.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${O.fps},format=yuv420p`,
      ...P.video, '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0',
      ...hlsArgs(vDir)]);

    // Audio: always stereo 48 kHz, padded past the video's end. The length comes from the probe
    // so audio can encode alongside video; the fps filter moves the video end by under one frame,
    // which the pad absorbs.
    const probed = parseFloat(info.streams.find(s => s.codec_type === 'video')?.duration ?? info.format.duration);
    const audioLen = (probed + AUDIO_PAD).toFixed(3);
    const aIn = hasAudio
      ? ['-i', src, '-map', '0:a:0', '-af', 'apad']
      : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'];
    const audioJob = runAsync('ffmpeg', ['-y', '-v', 'error', ...aIn, '-vn', '-t', audioLen, '-ar', '48000', '-ac', '2',
      ...P.audio, ...hlsArgs(aDir)]);
    await Promise.all([videoJob, audioJob]);
    // Written last, so an interrupted encode is never mistaken for a finished one.
    fs.writeFileSync(stamp, fingerprint);
  }

  const video = readPlaylist(vDir, `media/${id}/video`);
  const duration = video.segments.reduce((a, s) => a + s.duration, 0);
  const audio = readPlaylist(aDir, `media/${id}/audio`);

  video.startPts = firstPts(vDir);
  audio.startPts = firstPts(aDir) + P.audioPriming;

  console.log(`${id}: ${path.basename(src)} → ${duration.toFixed(3)}s, ${video.segments.length} segments${hasAudio ? '' : ', silent audio added'}${cached ? ' (cached)' : ''}`);
  return {
    label: node.label || id, prompt: node.prompt || '', choices: node.choices || [],
    choiceWindow: node.choiceWindow, fallback: node.fallback,
    duration, hasSourceAudio: hasAudio, source: path.basename(src),
    video, audio
  };
}

// Small worker pool. Results land by index so compiled.nodes keeps story order.
const results = new Array(plan.length);
let next = 0, failure = null;
async function worker() {
  while (!failure && next < plan.length) {
    const i = next++;
    try { results[i] = await buildNode(plan[i]); } catch (err) { failure = failure || err; }
  }
}
console.log(`${draft ? 'Draft build' : 'Building'} ${plan.length} clip(s), ${jobs} at a time (${O.width}x${O.height})`);
await Promise.all(Array.from({ length: Math.min(jobs, plan.length) }, worker));
if (failure) throw failure;
plan.forEach(({ id }, i) => { compiled.nodes[id] = results[i]; });

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'story.compiled.json'), JSON.stringify(compiled, null, 2));
console.log(`\nWrote ${path.relative(root, path.join(outDir, 'story.compiled.json'))} (${O.codec}, ${O.width}x${O.height}@${O.fps}${draft ? ', draft' : ''})`);
