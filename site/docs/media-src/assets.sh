#!/bin/sh
# The media the docs deck shows: abstract stills, clips and a 3D model, all
# generated here with ffmpeg and node, so nothing comes from a talk or the web.
#
#   sh site/docs/media-src/assets.sh <out-dir>
set -e
out=${1:?usage: assets.sh <out-dir>}
mkdir -p "$out"
ff() { ffmpeg -hide_banner -loglevel error -y "$@"; }

# Stills.
ff -f lavfi -i "gradients=s=1600x900:n=3:c0=0x0069d6:c1=0x0588ff:c2=0xbfe0ff:x0=0:y0=0:x1=1600:y1=900:seed=1" \
  -frames:v 1 "$out/gradient.png"
ff -f lavfi -i "gradients=s=1000x1000:n=3:t=radial:c0=0xdcefff:c1=0x57a7ff:c2=0x0069d6:x0=500:y0=420:x1=1000:y1=1000:seed=2" \
  -frames:v 1 "$out/radial.png"
ff -f lavfi -i "mandelbrot=s=1600x900:start_x=-0.7436:start_y=0.1318:start_scale=0.012:end_scale=0.012:outer=normalized_iteration_count:inner=black" \
  -vf "format=gray,format=rgb24,lutrgb=r='5+val*0.98':g='105+val*0.59':b='220+val*0.14'" -frames:v 1 "$out/fractal.png"
ff -f lavfi -i "color=c=white:s=1600x900" -vf \
  "geq=r='255-200*gt(mod(X,100),94)-200*gt(mod(Y,100),94)':g='255-120*gt(mod(X,100),94)-120*gt(mod(Y,100),94)':b='255-0*X'" \
  -frames:v 1 "$out/grid.png"

# A paper's first page, abstract: a title bar, an author line, an abstract
# and two columns of text, drawn as grey bars on white.
page="color=c=white:s=1240x1754,drawbox=x=170:y=170:w=900:h=44:color=0x1d1d1f:t=fill"
page="$page,drawbox=x=320:y=240:w=600:h=22:color=0x6e6e73:t=fill"
page="$page,drawbox=x=170:y=320:w=900:h=330:color=0xe8e8ed:t=fill"
y=700
while [ $y -lt 1650 ]; do
  page="$page,drawbox=x=170:y=$y:w=430:h=14:color=0xc7c7cc:t=fill,drawbox=x=640:y=$y:w=430:h=14:color=0xc7c7cc:t=fill"
  y=$((y + 34))
done
page="$page,drawbox=x=640:y=900:w=430:h=300:color=0xbfe0ff:t=fill"
ff -f lavfi -i "$page" -frames:v 1 "$out/paper-page.png"

# Clips: the same two soft blobs, in blue and in orange, of different lengths,
# for synced video and the wipe; and a cellular automaton.
blob() { # colour expressions over v (0 to 1), duration
  ff -f lavfi -i "color=c=white:s=960x540:r=30:d=$4" -vf \
    "format=rgb24,geq=r='$1':g='$2':b='$3'" -c:v libx264 -pix_fmt yuv420p -crf 26 -movflags +faststart -an "$5"
}
v="(exp(-(pow(X-480-300*cos(2*PI*T/4),2)+pow(Y-270-120*sin(2*PI*T/4),2))/9000)+exp(-(pow(X-480+260*cos(2*PI*T/3),2)+pow(Y-270-150*cos(2*PI*T/4),2))/6000))"
blob "240-235*min(1,$v)" "246-110*min(1,$v)" "255" 4 "$out/blobs-blue.mp4"
blob "255" "245-130*min(1,$v)" "236-216*min(1,$v)" 3 "$out/blobs-orange.mp4"
ff -f lavfi -i "life=s=192x108:r=12:ratio=0.3:life_color=0x0588ff:death_color=0xffffff:seed=7" \
  -t 4 -vf "scale=960:540:flags=neighbor" -c:v libx264 -pix_fmt yuv420p -crf 26 -movflags +faststart -an "$out/life.mp4"

# A 3D model: a torus as a Wavefront OBJ.
node -e '
const R = 1, r = 0.38, U = 64, V = 24, lines = [];
for (let i = 0; i < U; i++) for (let j = 0; j < V; j++) {
  const u = (i / U) * 2 * Math.PI, v = (j / V) * 2 * Math.PI;
  lines.push(`v ${((R + r * Math.cos(v)) * Math.cos(u)).toFixed(5)} ${(r * Math.sin(v)).toFixed(5)} ${((R + r * Math.cos(v)) * Math.sin(u)).toFixed(5)}`);
}
const at = (i, j) => ((i % U) * V + (j % V)) + 1;
for (let i = 0; i < U; i++) for (let j = 0; j < V; j++) {
  lines.push(`f ${at(i, j)} ${at(i + 1, j)} ${at(i + 1, j + 1)} ${at(i, j + 1)}`);
}
require("fs").writeFileSync(process.argv[1], lines.join("\n") + "\n");
' "$out/torus.obj"

echo "assets in $out"
