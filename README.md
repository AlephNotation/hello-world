# Hello, Vers

A small, working introduction to Vers: a frontend that explains the platform, backed by a real PostgreSQL database. Write a note, reload the page, and see how state survives a frontend restart.

The stack has exactly two machines:

```text
Browser ──HTTP──▶ Frontend ──PostgreSQL──▶ Postgres
                 Bun / TypeScript       PostgreSQL 17
                 port 8080              port 5432
```

The frontend serves the page and its API in one process. There is no separate backend VM. Postgres stores the notes and a persistent database identity displayed by the page.

## Run locally

Install Docker with Compose and OpenSSL, then:

```sh
git clone https://github.com/AlephNotation/hello-world.git
cd hello-world
./scripts/setup.sh
docker compose up --build -d --wait
```

Open **http://localhost:3002**. Change `FRONTEND_PORT` in `.env` if that port is in use.

`setup.sh` generates separate administrator and application passwords in a private, ignored `.env` file. It leaves an existing file untouched. Keep the generated hexadecimal password format if editing these values: the application password is embedded in a PostgreSQL connection URL.

Postgres is reachable only inside the Docker network; it has no published host port. The frontend uses the restricted `guide` database role, which can read and add notes and read the database identity. It cannot delete notes, change the schema, or manage roles.

### Try the stateful part

1. Write a note in the page.
2. Run `docker compose restart frontend`.
3. Reload the page. The note and database identity remain.
4. Run `docker compose down`, then `docker compose up -d --wait`. The named database volume retains the same data.

Stop the stack with `docker compose down`. For a fresh database, `docker compose down --volumes` **permanently deletes this local stack's saved notes**. Initialization and the passwords in `.env` are applied only to a new database volume; changing `.env` alone does not rotate an existing role's password.

## Use it on Vers

The Repos page is the place to find and import source repositories. The canvas shows running compute. This repo is a two-VM stack when launched: one frontend VM and one Postgres VM.

Importing this GitHub repository creates its catalog page; it does not launch machines. A generic launch action for imported repositories is still separate work. The commands below show the manual image-based path.

### Build the two images

Vers runs Linux/AMD64 images, including when you build on an Apple Silicon Mac:

```sh
docker build --platform linux/amd64 -f database/Dockerfile -t hello-vers-postgres:dev .
docker build --platform linux/amd64 -f frontend/Dockerfile -t hello-vers-frontend:dev .
```

The Dockerfiles pin their base images by digest; JavaScript dependencies are locked in `bun.lock`. The Postgres image includes its schema initialization, so it can start on its own without mounting files from this repository.

### Launch Postgres, then the frontend

These commands require a Vers CLI that supports `vers run --local`; check `vers run --help` first. The current source documents this interface for CLI v0.2.0, which may be newer than the installed release. See the [CLI reference](https://docs.vers.sh/cli-reference/overview#run) and [installation guide](https://docs.vers.sh/installation).

Authenticate with your Vers API key using the CLI's configuration, then load the generated database credentials without printing them:

```sh
vers whoami
set -a
. ./.env
set +a
export POSTGRES_DB=vers_guide

DATABASE_VM_ID=$(vers run --local --detach \
  --name hello-vers-postgres \
  --cpus 1 --memory-mib 1024 --disk-mib 8192 \
  --env POSTGRES_DB --env POSTGRES_PASSWORD --env APP_DB_PASSWORD \
  hello-vers-postgres:dev)
```

`--detach` prints the VM ID after the create request is accepted; database startup may still be in progress. Configure the frontend to use that machine's hostname:

```sh
export DATABASE_URL="postgresql://guide:${APP_DB_PASSWORD}@${DATABASE_VM_ID}.vm.vers.sh:5432/vers_guide?sslmode=verify-full&sslnegotiation=direct"

FRONTEND_VM_ID=$(vers run --local --detach \
  --name hello-vers-frontend \
  --cpus 1 --memory-mib 512 --disk-mib 4096 \
  --env DATABASE_URL \
  hello-vers-frontend:dev)

printf 'Open https://%s.vm.vers.sh:8080\n' "$FRONTEND_VM_ID"
```

The frontend connects to Postgres using native PostgreSQL over the Vers TLS proxy. `sslnegotiation=direct` starts TLS immediately, and `verify-full` checks the VM hostname using the runtime's trusted certificate store. The local Compose network uses `sslmode=disable` because neither service is exposed outside that private network.

The page is a shared demonstration, with no user accounts or private notes. Anyone who can access the frontend can read and add notes. Keep sensitive information out of it.

### Branching and state

Use the canvas to inspect the two machines, checkpoint a working state, and branch compute. A frontend branch **still uses the database hostname in its `DATABASE_URL`**, so branching the frontend alone shares the original notes. An independent stack needs its own database branch and a frontend configured to connect to it.

The database identity is stored in Postgres. It remains stable through restarts and is copied with a database checkpoint; it identifies the stored dataset, not a globally unique Vers VM.

When finished, delete the two VM IDs explicitly:

```sh
vers delete "$FRONTEND_VM_ID" --yes
vers delete "$DATABASE_VM_ID" --yes
```

Deleting the database VM removes its unsaved data. Keep a checkpoint first if you want to return to it.

## Develop and test

Install [Bun](https://bun.sh/), then:

```sh
bun install --frozen-lockfile
bun run check
bun test
```

Database integration tests run when `TEST_DATABASE_URL` points to a disposable initialized database, using the `guide` role. They otherwise skip. CI builds the same Postgres image, initializes a fresh database, and runs these tests plus a frontend readiness check.

The HTTP health endpoints are `/health/live` for the frontend process and `/health/ready` for a successful database query. Compose waits for database readiness before starting the frontend.

```text
frontend/           page, API, static assets, and frontend image
database/           Postgres image and first-start schema
compose.yaml        local two-service stack
scripts/setup.sh    generated local credentials
tests/              application and real-database tests
```
