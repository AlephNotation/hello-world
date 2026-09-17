# Hello, Vers

A small, working introduction to Vers: a frontend that explains the platform, backed by a real PostgreSQL database. Write a note, reload the page, and see how state survives a frontend restart.

The stack has exactly two machines:

```text
Browser ──HTTP──▶ Frontend ──PostgreSQL──▶ Postgres
                 Bun / TypeScript       PostgreSQL 17
                 port 8080              port 5432
```

The frontend serves the page and its API in one process. There is no separate backend VM. Postgres stores the notes and a persistent database identity displayed by the page.

For now, the frontend image also includes Nginx on port 8080, accepting IPv4 and IPv6 and forwarding to Bun's IPv4 listener on port 3000. This is an explicit, temporary part of this image while native IPv4 ingress is added to Vers. Both processes run as the unprivileged `bun` user; if either exits, the frontend workload stops. Local `bun run start` still serves directly on port 8080.

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

### Import the images

Use a Vers CLI with `vers image import` and `vers run` support. See the [CLI reference](https://docs.vers.sh/cli-reference/overview#run) and [installation guide](https://docs.vers.sh/installation). The commands below use Bun to read the image IDs from the CLI's JSON output.

Authenticate with your Vers API key using the CLI's configuration. Check the target organization before creating resources:

```sh
vers whoami

POSTGRES_IMAGE_ID=$(vers image import --local --json hello-vers-postgres:dev \
  | bun -e 'const image = await Bun.stdin.json(); if (!image.image_id) throw new Error("Image import did not return an ID"); console.log(image.image_id)')
FRONTEND_IMAGE_ID=$(vers image import --local --json hello-vers-frontend:dev \
  | bun -e 'const image = await Bun.stdin.json(); if (!image.image_id) throw new Error("Image import did not return an ID"); console.log(image.image_id)')
```

The import uploads and prepares each image. Launching from the returned immutable IDs keeps image preparation separate from VM creation.

### Launch Postgres, then the frontend

Load the generated database credentials without printing them:

```sh
set -a
. ./.env
set +a
export POSTGRES_DB=vers_guide

DATABASE_VM_ID=$(vers run --detach \
  --name hello-vers-postgres \
  --cpus 1 --memory-mib 1024 --disk-mib 8192 \
  --env POSTGRES_DB --env POSTGRES_PASSWORD --env APP_DB_PASSWORD \
  "$POSTGRES_IMAGE_ID")
```

`--detach` prints the VM ID after the create request is accepted; database startup may still be in progress. Check that Postgres accepts connections before continuing:

```sh
vers exec "$DATABASE_VM_ID" -- pg_isready -h 127.0.0.1 -U postgres -d vers_guide
```

Once it reports `accepting connections`, configure the frontend to use that machine's hostname:

```sh
export DATABASE_URL="postgresql://guide:${APP_DB_PASSWORD}@${DATABASE_VM_ID}.vm.vers.sh:5432/vers_guide?sslmode=verify-full&sslnegotiation=direct"

FRONTEND_VM_ID=$(vers run --detach \
  --name hello-vers-frontend \
  --cpus 1 --memory-mib 512 --disk-mib 4096 \
  --env DATABASE_URL \
  "$FRONTEND_IMAGE_ID")

printf 'Open https://%s.vm.vers.sh:8080\n' "$FRONTEND_VM_ID"
```

The frontend connects to Postgres using native PostgreSQL over the Vers TLS proxy. `sslnegotiation=direct` starts TLS immediately, and `verify-full` checks the VM hostname using the runtime's trusted certificate store. The local Compose network uses `sslmode=disable` because neither service is exposed outside that private network.

For a private development environment, configure its API endpoint **and** VM networking. The database hostname must resolve to that environment's proxy, and its certificate authority must be trusted by the frontend. Selecting a development API endpoint alone does not change DNS or certificate trust inside a VM.

To embed the frontend in a canvas hosted at another origin, set `VERS_CANVAS_ORIGIN`
on the frontend, for example `http://localhost:3010`. Use the canvas page's exact
scheme, hostname, and port, without a path or trailing slash. This adds that origin
to the page's framing policy; the default policy already allows `https://vers.sh`,
`https://www.vers.sh`, and `http://localhost:3000`. Pass it with
`--env VERS_CANVAS_ORIGIN` when launching the frontend VM, or set it in `.env` for
Compose. The setting does not change the frontend's listening port.

Check the deployed application's database connection:

```sh
curl --fail "https://${FRONTEND_VM_ID}.vm.vers.sh:8080/health/ready"
```

This must return `{"status":"ok"}`. Open the page, save a note, and reload to verify the full browser-to-database path. If a machine starts but its application exits, `vers workload-logs "$DATABASE_VM_ID"` or `vers workload-logs "$FRONTEND_VM_ID"` shows the startup failure.

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

### Brand assets

The wordmark and favicon use the original Vers SVG artwork from Chelsea's `website/public/logo/vers_white_small.svg` and `vers_v_only.svg`. The mark is shown in Vers green. The page uses the current Vers charcoal (`#2A2828`), cream (`#F6F1EC`), green (`#92BF2D`), and amber (`#FFB224`) palette. Its existing typography is unchanged.

### Checks

Install [Bun](https://bun.sh/), then:

```sh
bun install --frozen-lockfile
bun run check
bun test
```

Database integration tests run when `TEST_DATABASE_URL` points to a disposable initialized database, using the `guide` role. They otherwise skip. CI builds the same Postgres image, initializes a fresh database, and runs these tests plus a frontend readiness check.

After building the frontend image, `TEST_FRONTEND_IMAGE=hello-vers-frontend:dev bun test tests/frontend-image.test.ts` checks IPv4/IPv6 access, non-root execution, graceful shutdown, and failure handling for both processes. CI runs these image checks too.

The HTTP health endpoints are `/health/live` for the frontend process and `/health/ready` for a successful database query. Compose waits for database readiness before starting the frontend.

```text
frontend/           page, API, static assets, and frontend image
database/           Postgres image and first-start schema
compose.yaml        local two-service stack
scripts/setup.sh    generated local credentials
tests/              application and real-database tests
```
