#!/bin/sh
set -eu
umask 077

cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

if [ -e .env ] || [ -L .env ]; then
    printf '%s\n' '.env already exists; kept your configuration.'
else
    postgres_password=$(openssl rand -hex 32)
    app_password=$(openssl rand -hex 32)
    (
        set -C
        {
            printf 'POSTGRES_PASSWORD=%s\n' "$postgres_password"
            printf 'APP_DB_PASSWORD=%s\n' "$app_password"
            printf 'FRONTEND_PORT=3002\n'
        } > .env
    )
    printf '%s\n' 'Created .env with private, generated database passwords.'
fi

printf '%s\n' 'Start the stack: docker compose up --build -d --wait'
