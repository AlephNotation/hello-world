#!/bin/sh
set -eu

: "${APP_DB_PASSWORD:?APP_DB_PASSWORD is required to initialize the guide login}"

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 <<'SQL'
\getenv guide_password APP_DB_PASSWORD

CREATE ROLE guide LOGIN PASSWORD :'guide_password'
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

REVOKE ALL ON DATABASE :"DBNAME" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"DBNAME" TO guide;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO guide;

CREATE TABLE public.notes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 180 AND body = btrim(body)),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.stack_identity (
    id smallint PRIMARY KEY CHECK (id = 1),
    instance_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid()
);
INSERT INTO public.stack_identity (id) VALUES (1);

GRANT SELECT, INSERT ON public.notes TO guide;
GRANT SELECT ON public.stack_identity TO guide;
SQL
