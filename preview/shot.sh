#!/bin/sh
# ./shot.sh out.png "query" [height]
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
DIR=$(cd "$(dirname "$0")" && pwd)
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --window-size=1180,${3:-1500} --virtual-time-budget=3000 --screenshot="$1" "file://$DIR/index.html?$2" >/dev/null 2>&1
