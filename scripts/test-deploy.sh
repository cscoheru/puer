#!/usr/bin/env bash
set -Eeuo pipefail

readonly PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly DEPLOY_SCRIPT="$PROJECT_ROOT/deploy.sh"
readonly RELEASE_ID="20260801T000000Z-cd5f6d2a"
readonly TEST_ROOT="$(mktemp -d /tmp/puer-deploy-test.XXXXXX)"
trap 'rm -rf "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/bin" "$TEST_ROOT/releases" "$TEST_ROOT/baseline"
for entry in package.json package-lock.json tsconfig.json next.config.ts postcss.config.mjs \
  eslint.config.mjs components.json prisma prisma.config.ts public src Dockerfile \
  ws-server/package.json ws-server/package-lock.json ws-server/tsconfig.json \
  ws-server/src ws-server/Dockerfile; do
  mkdir -p "$TEST_ROOT/baseline/$(dirname "$entry")"
  if [[ -d "$PROJECT_ROOT/$entry" ]]; then
    mkdir -p "$TEST_ROOT/baseline/$entry"
    tar -C "$PROJECT_ROOT/$entry" --exclude=node_modules --exclude=.next \
      --exclude=uploads --exclude=generated -cf - . | tar -C "$TEST_ROOT/baseline/$entry" -xf -
  else
    cp "$PROJECT_ROOT/$entry" "$TEST_ROOT/baseline/$entry"
  fi
done
printf 'app\tsrc/lib/utils.ts\nws\tws-server/src/index.ts\n' > "$TEST_ROOT/overlay.tsv"

cat > "$TEST_ROOT/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >> "$PUER_MOCK_LOG"
if [[ "$1 $2" == 'image save' ]]; then
  while (($#)); do
    if [[ "$1" == --output ]]; then
      printf 'mock image archive\n' > "$2"
      exit 0
    fi
    shift
  done
fi
MOCK

cat > "$TEST_ROOT/bin/network-guard" <<'MOCK'
#!/usr/bin/env bash
printf 'unexpected network call: %s\n' "$*" >&2
exit 99
MOCK
chmod +x "$TEST_ROOT/bin/docker" "$TEST_ROOT/bin/network-guard"

export PUER_LOCAL_RELEASE_ROOT="$TEST_ROOT/releases"
export PUER_DOCKER_BIN="$TEST_ROOT/bin/docker"
export PUER_SSH_BIN="$TEST_ROOT/bin/network-guard"
export PUER_SCP_BIN="$TEST_ROOT/bin/network-guard"
export PUER_MOCK_LOG="$TEST_ROOT/docker.log"

bash -n "$DEPLOY_SCRIPT"
bash "$DEPLOY_SCRIPT" plan all "$RELEASE_ID" "$TEST_ROOT/baseline" "$TEST_ROOT/overlay.tsv" > "$TEST_ROOT/plan.txt"
bash "$DEPLOY_SCRIPT" build all "$RELEASE_ID" "$TEST_ROOT/baseline" "$TEST_ROOT/overlay.tsv" > "$TEST_ROOT/build.txt"

if bash "$DEPLOY_SCRIPT" build app 20260801T000001Z-cd5f6d2a "$PROJECT_ROOT" "$TEST_ROOT/overlay.tsv" \
  >"$TEST_ROOT/current-baseline.out" 2>"$TEST_ROOT/current-baseline.err"; then
  printf 'current working tree was accepted as baseline\n' >&2
  exit 1
fi
printf 'app\t.env.local\n' > "$TEST_ROOT/protected-overlay.tsv"
if bash "$DEPLOY_SCRIPT" build app 20260801T000002Z-cd5f6d2a "$TEST_ROOT/baseline" "$TEST_ROOT/protected-overlay.tsv" \
  >"$TEST_ROOT/protected-overlay.out" 2>"$TEST_ROOT/protected-overlay.err"; then
  printf 'protected overlay path was accepted\n' >&2
  exit 1
fi
printf 'app\tws-server/src/index.ts\n' > "$TEST_ROOT/cross-service-overlay.tsv"
if bash "$DEPLOY_SCRIPT" build app 20260801T000003Z-cd5f6d2a "$TEST_ROOT/baseline" "$TEST_ROOT/cross-service-overlay.tsv" \
  >"$TEST_ROOT/cross-service-overlay.out" 2>"$TEST_ROOT/cross-service-overlay.err"; then
  printf 'cross-service overlay path was accepted\n' >&2
  exit 1
fi

if [[ -e "$TEST_ROOT/releases/.20260801T000002Z-cd5f6d2a.staging" || -e "$TEST_ROOT/releases/20260801T000002Z-cd5f6d2a" ]]; then
  printf 'failed build left publishable or staging artifacts\n' >&2
  exit 1
fi

if find "$TEST_ROOT/releases/$RELEASE_ID/contexts" \
  \( -name .env -o -name '.env.*' -o -name uploads -o -name backups \
     -o -name .serena -o -name .git -o -name .next -o -name node_modules \
     -o -name evernote_export -o -name generated \) -print -quit | grep -q .; then
  printf 'protected path entered release context\n' >&2
  exit 1
fi

if grep -E 'accept-data-loss|prisma db push|rsync[^[:cntrl:]]*--delete' "$DEPLOY_SCRIPT"; then
  printf 'forbidden command found in deploy script\n' >&2
  exit 1
fi

(
  cd "$TEST_ROOT/releases/$RELEASE_ID"
  shasum -a 256 -c app.image.tar.sha256
  shasum -a 256 -c ws.image.tar.sha256
)

if bash "$DEPLOY_SCRIPT" publish app "$RELEASE_ID" >"$TEST_ROOT/publish.out" 2>"$TEST_ROOT/publish.err"; then
  printf 'publish succeeded without confirmation\n' >&2
  exit 1
fi
if bash "$DEPLOY_SCRIPT" activate app "$RELEASE_ID" >"$TEST_ROOT/activate.out" 2>"$TEST_ROOT/activate.err"; then
  printf 'activate succeeded without confirmation\n' >&2
  exit 1
fi
if grep -q 'unexpected network call' "$TEST_ROOT/publish.err" "$TEST_ROOT/activate.err"; then
  printf 'confirmation gate allowed a network call\n' >&2
  exit 1
fi

bash "$DEPLOY_SCRIPT" render-activate app "$RELEASE_ID" > "$TEST_ROOT/remote-activate.sh"
bash -n "$TEST_ROOT/remote-activate.sh"
grep -q -- '--no-deps --no-build' "$TEST_ROOT/remote-activate.sh"
grep -q 'trap rollback ERR' "$TEST_ROOT/remote-activate.sh"
grep -q 'trap - ERR' "$TEST_ROOT/remote-activate.sh"

printf '%s\n' \
  'syntax=OK' \
  'plan=OK' \
  'mock_build=OK' \
  'protected_paths=ABSENT' \
  'forbidden_commands=ABSENT' \
  'publish_without_confirmation=BLOCKED' \
  'activate_without_confirmation=BLOCKED' \
  'rollback_script_syntax=OK'
