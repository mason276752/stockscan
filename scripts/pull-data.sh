#!/usr/bin/env sh
# Bring the data (data/store: filings, scores, filing lists; data/bars: the
# finished years of daily bars) into the working tree straight from the
# repo's data ref - no merge, no rebase, no branch switch: the files are
# ignored on main (.gitignore: data/), so they just sit there for the
# server / build:static to use. Run it after a clone, and again whenever
# you want the latest fetched by the Pages workflow.
#
#   scripts/pull-data.sh            # from origin, ref refs/data/main
#   DATA_REF=data scripts/pull-data.sh    # some other ref / branch
#   REMOTE=upstream scripts/pull-data.sh
#
# Only the tip is fetched (--depth=1): the history of the data is of no use
# locally. This year's bars (head.zst) are not in git; the server's own
# background fetch fills them in.
set -eu
cd "$(dirname "$0")/.."
REMOTE="${REMOTE:-origin}"
DATA_REF="${DATA_REF:-refs/data/main}"

echo "pull-data: fetching $DATA_REF from $REMOTE (tip only) …"
git fetch --depth=1 --no-tags "$REMOTE" "$DATA_REF"
# FETCH_HEAD is the ref just fetched; restore only the data paths from it
git restore --overlay --source=FETCH_HEAD -- data/store data/bars
filings=$(find data/store/filings -type f 2>/dev/null | wc -l | tr -d ' ')
bars=$(find data/bars -name meta.json 2>/dev/null | wc -l | tr -d ' ')
echo "pull-data: done - $filings filing files, $bars bar symbols under data/"
