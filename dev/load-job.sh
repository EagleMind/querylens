#!/usr/bin/env bash
# Load the IMDB dataset + Join Order Benchmark queries into an `imdb` database in the
# dev container. Idempotent: skips the load when imdb is already populated.
#
#   dev/load-job.sh                 # downloads ~1.2 GB into dev/.cache/job if needed
#   JOB_DATA_DIR=/path/to/csvs dev/load-job.sh   # reuse already-extracted CSVs
set -euo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash on Windows: don't mangle container paths

CONTAINER=${CONTAINER:-querylens-pg}
HERE="$(cd "$(dirname "$0")" && pwd)"
# Git Bash: hand Windows tools (git, curl, docker) real Windows paths.
command -v cygpath >/dev/null && HERE="$(cygpath -m "$HERE")"
CACHE="$HERE/.cache/job"
DATA="${JOB_DATA_DIR:-$CACHE/data}"
REPO="$CACHE/repo"
psql() { docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -q -U querylens "$@"; }

if docker exec "$CONTAINER" psql -U querylens -d imdb -tAc "select count(*) from title" >/dev/null 2>&1; then
  echo "imdb already loaded"; exit 0
fi

mkdir -p "$CACHE"
[ -d "$REPO" ] || git clone -q --depth 1 https://github.com/gregrahn/join-order-benchmark.git "$REPO"
if [ ! -f "$DATA/title.csv" ]; then
  mkdir -p "$DATA"
  echo "downloading imdb.tgz (~1.2 GB)…"
  curl -fL -o "$CACHE/imdb.tgz" https://event.cwi.nl/da/job/imdb.tgz
  tar -xzf "$CACHE/imdb.tgz" -C "$DATA" && rm "$CACHE/imdb.tgz"
fi

docker exec "$CONTAINER" mkdir -p /tmp/imdb
docker cp "$DATA/." "$CONTAINER:/tmp/imdb/"
docker cp "$REPO/schema.sql" "$CONTAINER:/tmp/imdb/schema.sql"
docker cp "$REPO/fkindexes.sql" "$CONTAINER:/tmp/imdb/fkindexes.sql"

docker exec "$CONTAINER" createdb -U querylens imdb
psql -d imdb -f /tmp/imdb/schema.sql
docker exec "$CONTAINER" bash -c 'cd /tmp/imdb && for f in *.csv; do
  psql -q -U querylens -d imdb -c "\copy ${f%.csv} from $f csv escape '"'"'\'"'"'"; done'
psql -d imdb -f /tmp/imdb/fkindexes.sql
psql -d imdb -c "CREATE EXTENSION IF NOT EXISTS hypopg; CREATE EXTENSION IF NOT EXISTS pg_stat_statements; ANALYZE;"
docker exec "$CONTAINER" rm -rf /tmp/imdb
echo "imdb loaded"
