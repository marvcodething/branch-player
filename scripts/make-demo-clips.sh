#!/usr/bin/env bash
# Generates six demo SOURCE clips in deliberately mixed formats, frame rates and lengths,
# so the transcode step has something realistic to normalize.
#   intro.mp4   H.264/AAC   30fps 10s
#   left.webm   VP9/Opus    30fps 10s
#   right.mov   H.264/AAC   24fps 12s   (different frame rate)
#   door.webm   VP9, NO AUDIO     8s    (exercises the silent-audio path)
#   stairs.mp4  H.264/AAC   30fps 10s
#   ending.webm VP9/Opus    30fps  6s
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=projects/demo/source
mkdir -p "$OUT"

FONT="${FONT:-}"
if [ -z "$FONT" ]; then
  for f in /usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf \
           /System/Library/Fonts/Menlo.ttc \
           /Library/Fonts/Arial.ttf \
           C:/Windows/Fonts/consola.ttf; do
    [ -f "$f" ] && FONT="$f" && break
  done
fi
if [ -z "$FONT" ]; then echo "Set FONT=/path/to/a/font.ttf"; exit 1; fi

mk() { # name label color seconds fps tone ext [noaudio]
  local name=$1 label=$2 color=$3 dur=$4 fps=$5 freq=$6 ext=$7 noaudio=${8:-}
  local vf="drawbox=x='mod(t*192\,1280)':y=600:w=16:h=120:color=white@0.9:t=fill,\
drawtext=fontfile=$FONT:text='$label':fontcolor=white:fontsize=88:x=80:y=120,\
drawtext=fontfile=$FONT:text='%{pts\:hms}  f%{n}':fontcolor=white@0.85:fontsize=44:x=80:y=260,\
drawtext=fontfile=$FONT:text='source\: $ext ${fps}fps ${dur}s':fontcolor=white@0.6:fontsize=34:x=80:y=330"
  local ain=(-f lavfi -i "sine=frequency=$freq:sample_rate=48000:d=$dur")
  local amap=(-map 1:a -af volume=0.15)
  if [ -n "$noaudio" ]; then ain=(); amap=(); fi
  local codec
  case $ext in
    mp4|mov) codec=(-c:v libx264 -pix_fmt yuv420p -preset veryfast -crf 26 -c:a aac -b:a 96k) ;;
    webm)    codec=(-c:v libvpx-vp9 -b:v 800k -deadline realtime -cpu-used 8 -c:a libopus -b:a 64k) ;;
  esac
  ffmpeg -y -loglevel error -f lavfi -i "color=c=$color:s=1280x720:r=$fps:d=$dur" "${ain[@]}" \
    -map 0:v -vf "$vf" "${amap[@]}" "${codec[@]}" -t "$dur" "$OUT/$name.$ext"
  echo "made $OUT/$name.$ext"
}

mk intro  "THE FORK"   0x2a3a5c 10 30 220 mp4
mk left   "LEFT PATH"  0x2f5a3a 10 30 262 webm
mk right  "RIGHT PATH" 0x5c3a2a 12 24 294 mov
mk door   "THE DOOR"   0x4a2f5a  8 30 330 webm noaudio
mk stairs "THE STAIRS" 0x5a522a 10 30 349 mp4
mk ending "ENDING"     0x333338  6 30 196 webm
