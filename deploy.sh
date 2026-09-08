#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly PROJECT_ROOT="${PUER_PROJECT_ROOT:-$SCRIPT_DIR}"
readonly SERVER="${PUER_DEPLOY_SERVER:-puer-hk}"
readonly REMOTE_ROOT="${PUER_REMOTE_RELEASE_ROOT:-/opt/puer-hub/releases}"
readonly REMOTE_COMPOSE_FILES="${PUER_REMOTE_COMPOSE_FILES:-}"
readonly RELEASE_ROOT="${PUER_LOCAL_RELEASE_ROOT:-$PROJECT_ROOT/.releases}"
readonly APP_HEALTH_URL="${PUER_APP_HEALTH_URL:-http://127.0.0.1:3002/forum}"
readonly WS_HEALTH_URL="${PUER_WS_HEALTH_URL:-http://127.0.0.1:3011/health}"
readonly DOCKER_BIN="${PUER_DOCKER_BIN:-docker}"
readonly SSH_BIN="${PUER_SSH_BIN:-ssh}"
readonly SCP_BIN="${PUER_SCP_BIN:-scp}"

readonly -a APP_CONTEXT=(
  package.json package-lock.json tsconfig.json next.config.ts postcss.config.mjs
  eslint.config.mjs components.json prisma prisma.config.ts public src Dockerfile
)
readonly -a WS_CONTEXT=(
  ws-server/package.json ws-server/package-lock.json ws-server/tsconfig.json
  ws-server/src ws-server/Dockerfile
)
readonly -a PROTECTED_PATTERNS=(
  '.env' '.env.*' '*/.env' '*/.env.*'
  'uploads' 'uploads/*' '*/uploads' '*/uploads/*'
  'backups' 'backups/*' '*/backups' '*/backups/*'
  '.serena' '.serena/*' '*/.serena' '*/.serena/*'
  'src/generated' 'src/generated/*' '*/src/generated' '*/src/generated/*'
  '.git' '.git/*' '*/.git' '*/.git/*'
  '.next' '.next/*' '*/.next' '*/.next/*'
  'node_modules' 'node_modules/*' '*/node_modules' '*/node_modules/*'
  'evernote_export' 'evernote_export/*' '*/evernote_export' '*/evernote_export/*'
  '.releases' '.releases/*' '*/.releases' '*/.releases/*'
)

usage() {
  cat <<'USAGE'
Usage:
  ./deploy.sh plan [app|ws|all] <release-id> <baseline-dir> <overlay-manifest>
  ./deploy.sh build [app|ws|all] <release-id> <baseline-dir> <overlay-manifest>
  ./deploy.sh publish [app|ws|all] <release-id> --confirm-publish
  ./deploy.sh activate [app|ws] <release-id> --confirm-activate
  ./deploy.sh render-activate [app|ws] <release-id>

Activation also requires PUER_REMOTE_COMPOSE_FILES: a colon-separated list of
the exact production Compose files, all under /opt/puer-hub/.
A build starts from a read-only production source snapshot and applies only the
regular files listed in the overlay manifest. Manifest lines use:
  app<TAB>relative/path
  ws<TAB>ws-server/relative/path
Use an empty manifest for an unchanged baseline.
USAGE
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

validate_configuration() {
  [[ "$SERVER" =~ ^[A-Za-z0-9._-]+$ ]] || fail "deployment server contains unsafe characters"
  [[ "$REMOTE_ROOT" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail "remote release root must be a safe absolute path"
  if [[ -n "$REMOTE_COMPOSE_FILES" ]]; then
    [[ "$REMOTE_COMPOSE_FILES" =~ ^/opt/puer-hub/[A-Za-z0-9._/-]+(:/opt/puer-hub/[A-Za-z0-9._/-]+)*$ ]] ||
      fail "remote Compose files must be colon-separated safe paths under /opt/puer-hub"
  fi
  [[ "$APP_HEALTH_URL" =~ ^http://127\.0\.0\.1:[0-9]+/[A-Za-z0-9._/-]+$ ]] ||
    fail "App health URL must use loopback HTTP"
  [[ "$WS_HEALTH_URL" =~ ^http://127\.0\.0\.1:[0-9]+/[A-Za-z0-9._/-]+$ ]] ||
    fail "WS health URL must use loopback HTTP"
}

validate_service() {
  case "$1" in app|ws|all) ;; *) fail "service must be app, ws, or all" ;; esac
}

validate_release_id() {
  [[ "$1" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,12}$ ]] ||
    fail "release ID must match YYYYMMDDTHHMMSSZ-<7-12 lowercase hex>"
}

default_release_id() {
  local revision
  revision="$(git -C "$PROJECT_ROOT" rev-parse --short=12 HEAD 2>/dev/null || true)"
  [[ "$revision" =~ ^[a-f0-9]{7,12}$ ]] || fail "cannot derive a git revision; provide a release ID"
  printf '%s-%s\n' "$(date -u +%Y%m%dT%H%M%SZ)" "$revision"
}

release_dir() {
  printf '%s/%s\n' "$RELEASE_ROOT" "$1"
}

service_image() {
  printf 'puer-hub-%s:%s\n' "$1" "$2"
}

context_entries() {
  case "$1" in
    app) printf '%s\n' "${APP_CONTEXT[@]}" ;;
    ws) printf '%s\n' "${WS_CONTEXT[@]}" ;;
    *) fail "context entries require app or ws" ;;
  esac
}

assert_source_entry() {
  local source_root="$1" entry="$2" source="$source_root/$entry"
  [[ -e "$source" ]] || fail "allowlisted source entry is missing: $entry"
  [[ ! -L "$source" ]] || fail "allowlisted source entry must not be a symlink: $entry"
  if [[ -d "$source" ]] && find "$source" -type l -print -quit | grep -q .; then
    fail "allowlisted source directory contains a symlink: $entry"
  fi
}

is_protected_path() {
  local path="$1" pattern
  for pattern in "${PROTECTED_PATTERNS[@]}"; do
    case "$path" in $pattern) return 0 ;; esac
  done
  return 1
}

list_entry_files() {
  local source_root="$1" entry="$2" source="$source_root/$entry" relative
  assert_source_entry "$source_root" "$entry"
  if [[ -f "$source" ]]; then
    printf '%s\n' "$entry"
    return 0
  fi
  while IFS= read -r -d '' relative; do
    relative="${relative#./}"
    if [[ "$entry" == public && ( "$relative" == uploads || "$relative" == uploads/* ) ]]; then
      continue
    fi
    if [[ "$entry" == src && ( "$relative" == generated || "$relative" == generated/* ) ]]; then
      continue
    fi
    if [[ -f "$source/$relative" ]]; then
      printf '%s/%s\n' "$entry" "$relative"
    fi
  done < <(cd "$source" && find . -mindepth 1 -print0)
  return 0
}

list_context_files() {
  local service="$1" source_root="$2" entry
  while IFS= read -r entry; do
    list_entry_files "$source_root" "$entry"
  done < <(context_entries "$service")
}

copy_entry() {
  local source_root="$1" entry="$2" destination="$3"
  assert_source_entry "$source_root" "$entry"
  mkdir -p "$destination/$(dirname "$entry")"
  if [[ -d "$source_root/$entry" ]]; then
    mkdir -p "$destination/$entry"
    if [[ "$entry" == public ]]; then
      tar -C "$source_root/$entry" --exclude=uploads -cf - . | tar -C "$destination/$entry" -xf -
    elif [[ "$entry" == src ]]; then
      tar -C "$source_root/$entry" --exclude=generated -cf - . | tar -C "$destination/$entry" -xf -
    else
      tar -C "$source_root/$entry" -cf - . | tar -C "$destination/$entry" -xf -
    fi
  else
    cp "$source_root/$entry" "$destination/$entry"
  fi
}

assert_context_safe() {
  local context="$1" relative
  while IFS= read -r -d '' relative; do
    relative="${relative#./}"
    if is_protected_path "$relative"; then
      fail "protected path entered build context: $relative"
    fi
  done < <(cd "$context" && find . -mindepth 1 -print0)
  return 0
}

write_context_manifest() {
  local context="$1" output="$2"
  (
    cd "$context"
    find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256
  ) > "$output"
}

overlay_path_allowed() {
  local service="$1" path="$2" entry
  while IFS= read -r entry; do
    if [[ "$path" == "$entry" || "$path" == "$entry"/* ]]; then
      return 0
    fi
  done < <(context_entries "$service")
  return 1
}

validate_overlay_path() {
  local service="$1" path="$2" normalized="$path"
  [[ -n "$path" && "$path" != /* && "$path" != *'..'* && "$path" != *$'\n'* ]] ||
    fail "unsafe overlay path: $path"
  is_protected_path "$path" && fail "protected overlay path: $path"
  overlay_path_allowed "$service" "$path" || fail "overlay path is outside the service allowlist: $path"
  if [[ "$service" == ws ]]; then
    normalized="${path#ws-server/}"
  fi
  printf '%s\n' "$normalized"
}

apply_overlay() {
  local service="$1" manifest="$2" destination="$3" line_service path normalized source
  while IFS=$'\t' read -r line_service path extra; do
    [[ -z "$line_service" ]] && continue
    [[ "$line_service" == \#* ]] && continue
    [[ -z "${extra:-}" ]] || fail "overlay manifest has extra fields"
    [[ "$line_service" == app || "$line_service" == ws ]] || fail "invalid overlay service: $line_service"
    [[ "$line_service" == "$service" ]] || continue
    normalized="$(validate_overlay_path "$service" "$path")"
    source="$PROJECT_ROOT/$path"
    [[ -f "$source" && ! -L "$source" ]] || fail "overlay must name a regular non-symlink file: $path"
    mkdir -p "$destination/$(dirname "$normalized")"
    cp "$source" "$destination/$normalized"
  done < "$manifest"
}

create_context() {
  local service="$1" release_id="$2" baseline="$3" overlay_manifest="$4" build_root="$5" destination manifest entry
  destination="$build_root/contexts/$service"
  manifest="$build_root/$service.context.sha256"
  [[ ! -e "$destination" ]] || fail "release context already exists: $destination"
  mkdir -p "$destination"
  while IFS= read -r entry; do copy_entry "$baseline" "$entry" "$destination"; done < <(context_entries "$service")
  if [[ "$service" == ws ]]; then
    (
      shopt -s dotglob nullglob
      entries=("$destination/ws-server"/*)
      if ((${#entries[@]} > 0)); then
        mv "${entries[@]}" "$destination/"
      fi
    )
    rmdir "$destination/ws-server"
  fi
  apply_overlay "$service" "$overlay_manifest" "$destination"
  assert_context_safe "$destination"
  write_context_manifest "$destination" "$manifest"
}

write_release_plan() {
  local service="$1" release_id="$2" directory="$3" selected
  printf 'release_id=%s\nservice=%s\nserver=%s\nremote_root=%s\n' "$release_id" "$service" "$SERVER" "$REMOTE_ROOT"
  printf 'production_change=no\nschema_change=forbidden\n'
  for selected in app ws; do
    [[ "$service" == all || "$service" == "$selected" ]] || continue
    printf '\n[%s context sha256]\n' "$selected"
    cat "$directory/$selected.context.sha256"
    printf 'image=%s\n' "$(service_image "$selected" "$release_id")"
  done
}

plan_release() {
  local service="$1" release_id="$2" baseline="$3" overlay_manifest="$4" selected line_service path
  [[ -d "$baseline" ]] || fail "baseline directory is missing"
  [[ -f "$overlay_manifest" && ! -L "$overlay_manifest" ]] || fail "overlay manifest must be a regular file"
  [[ "$(cd "$baseline" && pwd -P)" != "$PROJECT_ROOT" ]] || fail "baseline must not be the current working tree"
  printf 'release_id=%s\nservice=%s\nserver=%s\nremote_root=%s\n' "$release_id" "$service" "$SERVER" "$REMOTE_ROOT"
  printf 'production_change=no\nschema_change=forbidden\n'
  for selected in app ws; do
    [[ "$service" == all || "$service" == "$selected" ]] || continue
    printf '\n[%s baseline files]\n' "$selected"
    list_context_files "$selected" "$baseline"
    printf '\n[%s overlay files]\n' "$selected"
    while IFS=$'\t' read -r line_service path extra; do
      [[ -z "$line_service" || "$line_service" == \#* || "$line_service" != "$selected" ]] && continue
      [[ -z "${extra:-}" ]] || fail "overlay manifest has extra fields"
      validate_overlay_path "$selected" "$path" >/dev/null
      [[ -f "$PROJECT_ROOT/$path" && ! -L "$PROJECT_ROOT/$path" ]] || fail "overlay must name a regular non-symlink file: $path"
      printf '%s\n' "$path"
    done < "$overlay_manifest"
    printf 'image=%s\n' "$(service_image "$selected" "$release_id")"
  done
}

build_release() {
  local service="$1" release_id="$2" baseline="$3" overlay_manifest="$4" selected final_directory staging_directory image archive
  [[ -d "$baseline" ]] || fail "baseline directory is missing"
  [[ -f "$overlay_manifest" && ! -L "$overlay_manifest" ]] || fail "overlay manifest must be a regular file"
  [[ "$(cd "$baseline" && pwd -P)" != "$PROJECT_ROOT" ]] || fail "baseline must not be the current working tree"
  final_directory="$(release_dir "$release_id")"
  staging_directory="$RELEASE_ROOT/.$release_id.staging"
  [[ ! -e "$final_directory" && ! -e "$staging_directory" ]] || fail "release ID already exists"
  mkdir -p "$staging_directory/contexts"
  cleanup_staging() { rm -rf "$staging_directory"; }
  trap cleanup_staging ERR
  for selected in app ws; do
    [[ "$service" == all || "$service" == "$selected" ]] || continue
    create_context "$selected" "$release_id" "$baseline" "$overlay_manifest" "$staging_directory"
    image="$(service_image "$selected" "$release_id")"
    "$DOCKER_BIN" build --pull=false --tag "$image" "$staging_directory/contexts/$selected"
    archive="$staging_directory/$selected.image.tar"
    "$DOCKER_BIN" image save --output "$archive" "$image"
    (cd "$staging_directory" && shasum -a 256 "$selected.image.tar" > "$selected.image.tar.sha256")
  done
  write_release_plan "$service" "$release_id" "$staging_directory" > "$staging_directory/release-plan.txt"
  mv "$staging_directory" "$final_directory"
  trap - ERR
  printf 'release_built=%s\n' "$final_directory"
}

publish_release() {
  local service="$1" release_id="$2" confirmation="$3" selected directory archive remote staging
  [[ "$confirmation" == --confirm-publish ]] || fail "publish requires --confirm-publish"
  directory="$(release_dir "$release_id")"
  [[ -f "$directory/release-plan.txt" ]] || fail "release is not built: $release_id"
  grep -Fxq "service=$service" "$directory/release-plan.txt" ||
    fail "publish service must match the built release plan"
  for selected in app ws; do
    [[ "$service" == all || "$service" == "$selected" ]] || continue
    archive="$directory/$selected.image.tar"
    [[ -f "$archive" && -f "$archive.sha256" ]] || fail "release artifact is missing: $selected"
    (cd "$directory" && shasum -a 256 -c "$selected.image.tar.sha256")
  done
  remote="$REMOTE_ROOT/$release_id"
  staging="$REMOTE_ROOT/.$release_id.staging"
  "$SSH_BIN" "$SERVER" "set -eu; umask 077; test ! -e '$remote'; test ! -e '$staging'; mkdir -p '$staging'"
  for selected in app ws; do
    [[ "$service" == all || "$service" == "$selected" ]] || continue
    archive="$directory/$selected.image.tar"
    "$SCP_BIN" "$archive" "$archive.sha256" "$SERVER:$staging/"
    "$SSH_BIN" "$SERVER" "cd '$staging' && sha256sum -c '$selected.image.tar.sha256'"
  done
  "$SCP_BIN" "$directory/release-plan.txt" "$SERVER:$staging/"
  "$SSH_BIN" "$SERVER" "mv '$staging' '$remote'"
  printf 'release_published=%s:%s\n' "$SERVER" "$remote"
}

remote_activate_script() {
  cat <<'REMOTE'
set -Eeuo pipefail
service="$1"
release_id="$2"
remote_root="$3"
health_url="$4"
compose_files="$5"
[[ -n "$compose_files" ]] || { printf 'missing production Compose file chain\n' >&2; exit 64; }
compose_args=()
IFS=: read -r -a compose_paths <<< "$compose_files"
for compose_file in "${compose_paths[@]}"; do
  [[ "$compose_file" == /opt/puer-hub/* && -f "$compose_file" ]] || { printf 'invalid Compose file: %s\n' "$compose_file" >&2; exit 64; }
  compose_args+=( -f "$compose_file" )
done
case "$service" in
  app) container=puer-hub-app; compose_service=app ;;
  ws) container=puer-hub-ws; compose_service=ws-server ;;
  *) exit 64 ;;
esac
archive="$remote_root/$release_id/$service.image.tar"
checksum="$archive.sha256"
cd "$(dirname "$archive")"
sha256sum -c "$(basename "$checksum")"
new_image="puer-hub-$service:$release_id"
old_image="$(docker inspect --format '{{.Image}}' "$container")"
rollback_tag="puer-hub-$service:rollback-$release_id"
override="$remote_root/$release_id/$service.active.override.yml"
rollback_override="$remote_root/$release_id/$service.rollback.override.yml"
printf 'services:\n  %s:\n    image: %s\n' "$compose_service" "$new_image" > "$override"
rollback() {
  trap - ERR
  printf 'services:\n  %s:\n    image: %s\n' "$compose_service" "$rollback_tag" > "$rollback_override"
  docker compose "${compose_args[@]}" -f "$rollback_override" up -d --no-deps --no-build "$compose_service"
}
docker image tag "$old_image" "$rollback_tag"
docker image load --input "$archive" >/dev/null
new_image_id="$(docker image inspect --format '{{.Id}}' "$new_image")"
trap rollback ERR
docker compose "${compose_args[@]}" -f "$override" up -d --no-deps --no-build "$compose_service"
for attempt in $(seq 1 30); do
  running_image_id="$(docker inspect --format '{{.Image}}' "$container" 2>/dev/null || true)"
  if [[ "$running_image_id" == "$new_image_id" ]] && curl --fail --silent --show-error --max-time 5 "$health_url" >/dev/null; then
    trap - ERR
    printf 'activated=%s\nprevious_image=%s\n' "$new_image" "$old_image"
    exit 0
  fi
  sleep 2
done
false
REMOTE
}

activate_release() {
  local service="$1" release_id="$2" confirmation="$3" health_url
  [[ "$service" != all ]] || fail "activate one service at a time"
  [[ "$confirmation" == --confirm-activate ]] || fail "activate requires --confirm-activate"
  [[ -n "$REMOTE_COMPOSE_FILES" ]] || fail "activate requires PUER_REMOTE_COMPOSE_FILES"
  health_url="$APP_HEALTH_URL"
  [[ "$service" == ws ]] && health_url="$WS_HEALTH_URL"
  remote_activate_script | "$SSH_BIN" "$SERVER" bash -s -- "$service" "$release_id" "$REMOTE_ROOT" "$health_url" "$REMOTE_COMPOSE_FILES"
}

main() {
  local command="${1:-plan}" service="${2:-all}" release_id="${3:-}" argument4="${4:-}" argument5="${5:-}"
  [[ "$command" == help || "$command" == --help || "$command" == -h ]] && { usage; return 0; }
  validate_configuration
  validate_service "$service"
  [[ -n "$release_id" ]] || release_id="$(default_release_id)"
  validate_release_id "$release_id"
  case "$command" in
    plan) plan_release "$service" "$release_id" "$argument4" "$argument5" ;;
    build) build_release "$service" "$release_id" "$argument4" "$argument5" ;;
    publish) publish_release "$service" "$release_id" "$argument4" ;;
    activate) activate_release "$service" "$release_id" "$argument4" ;;
    render-activate)
      [[ "$service" != all ]] || fail "render one service at a time"
      remote_activate_script
      ;;
    *) usage >&2; fail "unknown command: $command" ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
