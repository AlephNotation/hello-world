#!/usr/bin/env bash
set -euo pipefail

# Temporary ingress for Vers's IPv6 transport. Bun retains its IPv4 listener.
# Both processes run as the image's unprivileged bun user.
app_pid=
nginx_pid=
cleanup() {
    trap '' TERM INT
    if [[ -n "$nginx_pid" ]]; then
        kill -QUIT "$nginx_pid" 2>/dev/null || true
        wait "$nginx_pid" 2>/dev/null || true
    fi
    if [[ -n "$app_pid" ]]; then
        kill -TERM "$app_pid" 2>/dev/null || true
        wait "$app_pid" 2>/dev/null || true
    fi
}
trap cleanup EXIT
trap 'exit 0' TERM INT

mkdir -p /tmp/hello-vers-nginx
nginx -t -c /app/frontend/nginx.conf

PORT=3000 bun run /app/frontend/server.ts &
app_pid=$!
nginx -c /app/frontend/nginx.conf -g 'daemon off;' &
nginx_pid=$!

# A dead app or proxy must fail the workload, so its restart policy can act.
status=0
wait -n "$app_pid" "$nginx_pid" || status=$?
if [[ "$status" -eq 0 ]]; then status=1; fi
exit "$status"
