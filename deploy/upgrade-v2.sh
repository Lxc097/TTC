#!/usr/bin/env bash
# Safe upgrade of an existing TTC production checkout. Never run the retired setup.sh.
set -Eeuo pipefail
umask 077

APP_DIR=/opt/ttc
BACKUP_ROOT=/opt/ttc-backups
ENV_FILE="$APP_DIR/backend/.env"
SITE=/etc/nginx/sites-available/woaiyrb.com
SNIPPET=/etc/nginx/snippets/ttc-v2-routes.conf
NODE_UNIT=/etc/systemd/system/ttc-interview-api.service
BACKEND_SERVICE=ttc-backend
NODE_SERVICE=ttc-interview-api
BACKEND_STOPPED=0
log() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
restore_backend_on_exit() {
  if [ "$BACKEND_STOPPED" -eq 1 ]; then systemctl start "$BACKEND_SERVICE" || true; fi
}
trap restore_backend_on_exit EXIT

[ "$(id -u)" -eq 0 ] || die 'Run as root on the existing production host.'
[ -d "$APP_DIR/.git" ] || die "$APP_DIR is not an existing Git checkout. No installation attempted."
[ -f "$ENV_FILE" ] || die "$ENV_FILE is missing. Preserve the production configuration first."
[ -f "$SITE" ] || die "$SITE is missing. Existing nginx/TLS configuration is required."
for binary in git python3 node npm nginx curl systemctl; do
  command -v "$binary" >/dev/null || die "Missing dependency: $binary"
done
[ "$(git -C "$APP_DIR" branch --show-current)" = main ] || die 'Production checkout must be on main.'
[ -z "$(git -C "$APP_DIR" status --porcelain --untracked-files=no)" ] || die 'Tracked production edits found; reconcile them before upgrading.'
node_ok=$(node -p "const [major, minor] = process.versions.node.split('.').map(Number); Number(major > 22 || (major === 22 && minor >= 12))")
[ "$node_ok" = 1 ] || die 'Node.js 22.12+ is required for the AI interview build.'
nginx -t >/dev/null
systemctl cat "$BACKEND_SERVICE" >/dev/null || die "Existing $BACKEND_SERVICE unit is missing."

log 'Create private backup of configuration and production data'
install -d -m 700 "$BACKUP_ROOT"
BACKUP_DIR=$(mktemp -d "$BACKUP_ROOT/v2-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
git -C "$APP_DIR" rev-parse HEAD > "$BACKUP_DIR/before-commit.txt"
cp -a "$ENV_FILE" "$BACKUP_DIR/backend.env"
while IFS= read -r -d '' env_path; do
  relative=$(realpath --relative-to="$APP_DIR" "$env_path")
  destination="$BACKUP_DIR/env-files/$relative"
  install -d -m 700 "$(dirname "$destination")"
  cp -a "$env_path" "$destination"
done < <(find "$APP_DIR" \( -name .git -o -name .venv -o -name node_modules \) -prune -o -type f \( -name .env -o -name .env.local \) -print0)
cp -a "$SITE" "$BACKUP_DIR/nginx-site.conf"
systemctl cat "$BACKEND_SERVICE" > "$BACKUP_DIR/ttc-backend.unit.txt"
[ ! -f "$NODE_UNIT" ] || cp -a "$NODE_UNIT" "$BACKUP_DIR/ttc-interview-api.service"
[ ! -f "$SNIPPET" ] || cp -a "$SNIPPET" "$BACKUP_DIR/ttc-v2-routes.conf"
# Stop SQLite writers while copying the database, WAL/SHM and uploaded resumes.
if systemctl is-active --quiet "$BACKEND_SERVICE"; then
  systemctl stop "$BACKEND_SERVICE"
  BACKEND_STOPPED=1
fi
backup_tree() {
  local source=$1 destination=$2
  [ -d "$source" ] || return 0
  install -d -m 700 "$destination"
  cp -a "$source/." "$destination/"
  printf '%s -> %s\n' "$source" "$destination" >> "$BACKUP_DIR/data-paths.txt"
}
while IFS= read -r -d '' path; do
  relative=$(realpath --relative-to="$APP_DIR" "$path")
  backup_tree "$path" "$BACKUP_DIR/local-data/$relative"
done < <(find "$APP_DIR" \( -name .git -o -name .venv -o -name node_modules \) -prune -o -type d -name .local-data -print0)
# Explicitly cover a symlink at the default path; find -type d does not follow it.
backup_tree "$APP_DIR/backend/candidate/.local-data" "$BACKUP_DIR/local-data/backend/candidate/.local-data"
custom_data=$(python3 - "$ENV_FILE" "$APP_DIR/backend" <<'PY'
import pathlib, sys
value = ""
for raw in pathlib.Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():
    line = raw.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, entry = line.split("=", 1)
    if key.strip() == "RECRUITMENT_DATA_DIR":
        value = entry.strip()
if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
    value = value[1:-1]
if value:
    path = pathlib.Path(value).expanduser()
    print((path if path.is_absolute() else pathlib.Path(sys.argv[2]) / path).resolve())
PY
)
if [ -n "$custom_data" ]; then
  backup_tree "$custom_data" "$BACKUP_DIR/custom-recruitment-data"
fi
log "Backup ready: $BACKUP_DIR"

log 'Fast-forward existing main without reset or clean'
git -C "$APP_DIR" fetch origin main
git -C "$APP_DIR" merge --ff-only origin/main
git -C "$APP_DIR" rev-parse HEAD > "$BACKUP_DIR/after-commit.txt"

log 'Install dependencies and build the formal interview UI'
[ -d "$APP_DIR/.venv" ] || python3 -m venv "$APP_DIR/.venv"
"$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/backend/requirements.txt"
(
  cd "$APP_DIR/ai-interview"
  npm ci --include=dev --no-audit --no-fund
  npm run build:formal
)
[ -f "$APP_DIR/ai-interview/dist/index.html" ] || die 'Formal interview build is missing.'

log 'Install loopback-only Node interview sidecar'
NODE_BIN=$(command -v node)
cat > "$NODE_UNIT" <<UNIT
[Unit]
Description=TTC AI interview Node sidecar
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR/ai-interview
EnvironmentFile=$ENV_FILE
Environment=NODE_ENV=production
ExecStart=$NODE_BIN --import tsx server/index.ts
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
chmod 644 "$NODE_UNIT"
systemctl daemon-reload
systemctl enable --now "$NODE_SERVICE"
systemctl restart "$NODE_SERVICE"
systemctl is-active --quiet "$NODE_SERVICE" || die "Node sidecar unit is inactive."
curl -fsS --max-time 10 http://127.0.0.1:8787/api/interview/status >/dev/null || die 'Node sidecar did not become healthy on 127.0.0.1:8787.'

log 'Add V2 routes while preserving nginx TLS and existing locations'
install -d -m 755 /etc/nginx/snippets
cat > "$SNIPPET" <<'NGINX'
# TTC V2 routes: included inside existing woaiyrb.com server blocks.
location = /classic { return 308 /classic/; }
location ^~ /classic/ {
    proxy_pass http://127.0.0.1:8000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
location = /ai-interview { return 308 /ai-interview/; }
location ^~ /ai-interview/ {
    proxy_pass http://127.0.0.1:8000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
# Authenticated interview endpoints stay in FastAPI; it calls the Node sidecar.
location ^~ /api/interview/ {
    proxy_pass http://127.0.0.1:8000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;
    client_max_body_size 48m;
}
# Batch uploads exceed the old generic /api/ 32 MB limit.
location = /api/hr/resumes/batch {
    proxy_pass http://127.0.0.1:8000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 600s;
    client_max_body_size 100m;
}
# Stream claim progress and architect answers without nginx response buffering.
location ~ ^/api/hr/(applications/[^/]+/progress/events|architect/sessions/[^/]+/messages/stream)$ {
    proxy_pass http://127.0.0.1:8000;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_cache off;
    gzip off;
    proxy_read_timeout 3600s;
}
NGINX
python3 - "$SITE" <<'PY'
import pathlib, re, sys
site = pathlib.Path(sys.argv[1])
text = site.read_text(encoding='utf-8')
needle = 'include /etc/nginx/snippets/ttc-v2-routes.conf;'
blocks = []
for match in re.finditer(r'^\s*server\s*\{', text, re.M):
    depth = 1
    end = match.end()
    while end < len(text) and depth:
        if text[end] == '{': depth += 1
        elif text[end] == '}': depth -= 1
        end += 1
    if depth:
        raise SystemExit('Unbalanced nginx server block; no changes applied.')
    body = text[match.end():end - 1]
    if re.search(r'^\s*server_name\s+[^;]*\bwoaiyrb\.com\b', body, re.M) and needle not in body:
        blocks.append(end - 1)
if not blocks and needle not in text:
    raise SystemExit('No woaiyrb.com server block found; no changes applied.')
for offset in reversed(blocks):
    text = text[:offset] + '    ' + needle + '\n' + text[offset:]
site.write_text(text, encoding='utf-8')
PY
if ! nginx -t; then
  cp -a "$BACKUP_DIR/nginx-site.conf" "$SITE"
  [ ! -f "$BACKUP_DIR/ttc-v2-routes.conf" ] || cp -a "$BACKUP_DIR/ttc-v2-routes.conf" "$SNIPPET"
  nginx -t || true
  die 'nginx validation failed; original site configuration restored.'
fi

log 'Restart the existing backend unit and reload nginx'
systemctl restart "$BACKEND_SERVICE"
systemctl is-active --quiet "$BACKEND_SERVICE" || die "Backend unit is inactive."
curl -fsS --max-time 15 http://127.0.0.1:8000/healthz >/dev/null || die 'FastAPI health check failed; inspect the backend journal and backup.'
BACKEND_STOPPED=0
systemctl reload nginx
curl -fsS --max-time 15 http://127.0.0.1:8000/classic/screening.html >/dev/null || die 'Classic screening page smoke check failed.'
curl -fsS --max-time 15 http://127.0.0.1:8000/ai-interview/ >/dev/null || die 'Formal interview page smoke check failed.'
log "Upgrade complete. Backup: $BACKUP_DIR"
log 'No production data, existing backend unit, or TLS certificate was deleted.'
