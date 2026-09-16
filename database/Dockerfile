FROM postgres:17-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0

ENV POSTGRES_DB=vers_guide \
    POSTGRES_USER=postgres \
    POSTGRES_INITDB_ARGS="--auth-host=scram-sha-256"

COPY --chmod=755 database/init/01-guide.sh /docker-entrypoint-initdb.d/01-guide.sh
EXPOSE 5432
