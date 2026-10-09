#!/bin/sh
# First-start initialisation of the postgres service (docker-entrypoint-initdb.d; runs only on an empty volume).
# Creates the three service roles with their own passwords; the migration (run as the owner) creates the schema,
# the private schema, and the per-role grants (src/agenthorizon/app/schema.py GRANTS_SQL).
set -eu
: "${AH_API_DB_PASSWORD:?}" "${AH_WORKER_DB_PASSWORD:?}" "${AH_SCORER_DB_PASSWORD:?}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
     -v api_pw="$AH_API_DB_PASSWORD" -v worker_pw="$AH_WORKER_DB_PASSWORD" -v scorer_pw="$AH_SCORER_DB_PASSWORD" <<'SQL'
CREATE ROLE ah_api LOGIN PASSWORD :'api_pw';
CREATE ROLE ah_worker LOGIN PASSWORD :'worker_pw';
CREATE ROLE ah_scorer LOGIN PASSWORD :'scorer_pw';
CREATE EXTENSION IF NOT EXISTS pg_trgm;
SQL
