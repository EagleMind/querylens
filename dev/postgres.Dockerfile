# Postgres 17 with the extensions QueryLens' advanced profiling uses:
#   hypopg              hypothetical indexes (index ideas without building them)
#   pg_stat_statements  workload "top queries" (preloaded via docker-compose command)
FROM postgres:17
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-17-hypopg \
 && rm -rf /var/lib/apt/lists/*
