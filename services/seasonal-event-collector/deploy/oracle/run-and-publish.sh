#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)
COMPOSE_FILE="$SCRIPT_DIR/compose.yml"
ENV_FILE="$SCRIPT_DIR/.env"
OUTPUT_ROOT="$SCRIPT_DIR/output"
STATUS_ROOT="$SCRIPT_DIR/status"
DATA_PATH="data/seasonal-event/events.json"
CANDIDATE_PATH="data/seasonal-event/candidates.json"
CURRENT_DATA="$REPOSITORY_ROOT/$DATA_PATH"
CURRENT_CANDIDATES="$REPOSITORY_ROOT/$CANDIDATE_PATH"
BRANCH="main"
DEPLOY_KEY_PATH=${DEPLOY_KEY_PATH:-"${HOME:-/home/ubuntu}/.ssh/seasonal-event-deploy"}
KNOWN_HOSTS_PATH=${GITHUB_KNOWN_HOSTS_PATH:-"${HOME:-/home/ubuntu}/.ssh/seasonal-event-known_hosts"}
DRY_RUN=0

case "${1:-}" in
  "") ;;
  --dry-run) DRY_RUN=1 ;;
  *)
    echo "usage: $0 [--dry-run]" >&2
    exit 64
    ;;
esac

for required_command in cmp cp date docker flock git id mktemp mv python3 rm; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "required command is unavailable: $required_command" >&2
    exit 69
  fi
done

STAGING_ROOT=""
PUBLISH_PHASE="preflight"
PUBLISH_OUTCOME="failed"
COLLECTOR_EXIT=""
COLLECTOR_STARTED=0
COLLECTOR_STATUS_PERSISTED=0
PREVIEW_PERSISTED=0
PUBLISHED_COMMIT=""
mkdir -p "$OUTPUT_ROOT" "$STATUS_ROOT"

write_wrapper_status() {
  wrapper_exit=$1
  collector_exit_json=${COLLECTOR_EXIT:-null}
  repository_head=$(git -C "$REPOSITORY_ROOT" rev-parse HEAD 2>/dev/null || true)
  finished_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  collector_status_json=null
  if [ "$COLLECTOR_STARTED" -eq 1 ] && [ "$COLLECTOR_STATUS_PERSISTED" -eq 1 ]; then
    collector_status_json='"collector.json"'
  fi
  preview_json=null
  if [ "$PREVIEW_PERSISTED" -eq 1 ]; then
    preview_json='"preview.json"'
  fi
  status_temporary="$STATUS_ROOT/latest.json.tmp.$$"
  printf '%s\n' "{\"type\":\"seasonal-event-publish-status\",\"schemaVersion\":1,\"finishedAt\":\"$finished_at\",\"phase\":\"$PUBLISH_PHASE\",\"outcome\":\"$PUBLISH_OUTCOME\",\"exitCode\":$wrapper_exit,\"collectorExitCode\":$collector_exit_json,\"repositoryHead\":\"$repository_head\",\"publishedCommit\":\"$PUBLISHED_COMMIT\",\"collectorStatusFile\":$collector_status_json,\"previewFile\":$preview_json}" >"$status_temporary"
  mv -f -- "$status_temporary" "$STATUS_ROOT/latest.json"
}

cleanup() {
  exit_status=$?
  trap - EXIT HUP INT TERM
  if [ -n "$STAGING_ROOT" ]; then
    case "$STAGING_ROOT" in
      "$OUTPUT_ROOT"/run.*) rm -rf -- "$STAGING_ROOT" ;;
      *) echo "refusing to remove unexpected staging path: $STAGING_ROOT" >&2 ;;
    esac
  fi
  if [ "$PUBLISH_OUTCOME" != "concurrent_skip" ] && ! write_wrapper_status "$exit_status"; then
    echo "warning: could not write final publication status" >&2
  fi
  exit "$exit_status"
}
trap cleanup EXIT HUP INT TERM

validate_collector_result() {
  generated_status="$CONTAINER_STATUS/collector.json"
  generated_candidates="$CONTAINER_OUTPUT/candidates.json"
  if [ ! -s "$generated_status" ] || [ ! -s "$generated_candidates" ]; then
    echo "collector did not produce status and candidate reports for this run" >&2
    exit 65
  fi

  if ! python3 - "$generated_status" "$generated_candidates" "$COLLECTOR_EXIT" <<'PY'
import json
import sys

status_path, candidate_path, exit_text = sys.argv[1:]
with open(status_path, encoding="utf-8") as handle:
    status = json.load(handle)
with open(candidate_path, encoding="utf-8") as handle:
    candidates = json.load(handle)

if not isinstance(status, dict) or status.get("type") != "seasonal-event-collector-status" or status.get("schemaVersion") != 1:
    raise SystemExit("invalid collector status header")
if not isinstance(candidates, dict) or candidates.get("schemaVersion") != 1 or not isinstance(candidates.get("candidates"), list):
    raise SystemExit("invalid candidate report header")

exit_code = int(exit_text)
expected = {0: {"ok"}, 1: {"error"}, 2: {"alert", "review_required"}}
if exit_code not in expected:
    raise SystemExit(f"unsupported collector exit code: {exit_code}")
if status.get("status") not in expected[exit_code]:
    raise SystemExit("collector exit code does not match its status document")
if candidates.get("status") != status.get("status"):
    raise SystemExit("collector status does not match its candidate report")
if not isinstance(status.get("code"), str) or not status["code"] or candidates.get("code") != status.get("code"):
    raise SystemExit("collector code does not match its candidate report")
PY
  then
    echo "collector produced an invalid or mismatched status document" >&2
    exit 65
  fi

  status_temporary="$STATUS_ROOT/collector.json.tmp.$$"
  cp -- "$generated_status" "$status_temporary"
  mv -f -- "$status_temporary" "$STATUS_ROOT/collector.json"
  COLLECTOR_STATUS_PERSISTED=1

  case "$COLLECTOR_EXIT" in
    0) ;;
    1)
      # A late failure can happen after the collector wrote a candidate events
      # document to staging. Error runs may publish diagnostics, never event data.
      cp -- "$CURRENT_DATA" "$CONTAINER_OUTPUT/events.json"
      ;;
    2) ;;
  esac
}

if [ ! -f "$CURRENT_DATA" ]; then
  echo "current data file is missing: $CURRENT_DATA" >&2
  exit 66
fi
if [ ! -f "$CURRENT_CANDIDATES" ]; then
  echo "current candidate report is missing: $CURRENT_CANDIDATES" >&2
  exit 66
fi
if [ ! -r "$ENV_FILE" ]; then
  echo "collector environment file is not readable: $ENV_FILE" >&2
  exit 66
fi

if [ ! -r "$DEPLOY_KEY_PATH" ]; then
  echo "repository deploy key is not readable: $DEPLOY_KEY_PATH" >&2
  exit 77
fi
if [ ! -r "$KNOWN_HOSTS_PATH" ]; then
  echo "dedicated GitHub known-hosts file is not readable: $KNOWN_HOSTS_PATH" >&2
  exit 77
fi

LOCK_FILE="$OUTPUT_ROOT/run-and-publish.json.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "another seasonal-event publication is already running; skipping"
  PUBLISH_PHASE="complete"
  PUBLISH_OUTCOME="concurrent_skip"
  exit 0
fi

if [ -n "$(git -C "$REPOSITORY_ROOT" status --porcelain --untracked-files=no)" ]; then
  echo "tracked files in the deployment checkout are modified; refusing to publish" >&2
  exit 65
fi

REMOTE_URL=$(git -C "$REPOSITORY_ROOT" remote get-url origin)
case "$REMOTE_URL" in
  git@github.com:Miraco33/seasonal-event|git@github.com:Miraco33/seasonal-event.git|ssh://git@github.com/Miraco33/seasonal-event|ssh://git@github.com/Miraco33/seasonal-event.git) ;;
  *)
    echo "origin must be the SSH URL for Miraco33/seasonal-event; found: $REMOTE_URL" >&2
    exit 78
    ;;
esac

GIT_SSH_COMMAND="/usr/bin/ssh -i $DEPLOY_KEY_PATH -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KNOWN_HOSTS_PATH"
export GIT_SSH_COMMAND

PUBLISH_PHASE="sync_repository"
git -C "$REPOSITORY_ROOT" pull --ff-only --no-rebase origin "$BRANCH"

if [ -n "$(git -C "$REPOSITORY_ROOT" status --porcelain --untracked-files=no)" ]; then
  echo "tracked files changed after pull; refusing to publish" >&2
  exit 65
fi

LOCAL_HEAD=$(git -C "$REPOSITORY_ROOT" rev-parse HEAD)
REMOTE_HEAD=$(git -C "$REPOSITORY_ROOT" rev-parse "refs/remotes/origin/$BRANCH")
if [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]; then
  echo "deployment checkout is not exactly at origin/$BRANCH" >&2
  exit 65
fi

STAGING_ROOT=$(mktemp -d "$OUTPUT_ROOT/run.XXXXXXXX")
CONTAINER_OUTPUT="$STAGING_ROOT/container"
CONTAINER_STATUS="$STAGING_ROOT/status"
PUBLISH_REPOSITORY="$STAGING_ROOT/repository"
mkdir -p "$CONTAINER_OUTPUT" "$CONTAINER_STATUS"
cp -- "$CURRENT_DATA" "$CONTAINER_OUTPUT/events.json"
cp -- "$CURRENT_CANDIDATES" "$CONTAINER_OUTPUT/candidates.json"

COLLECTOR_UID=$(id -u)
COLLECTOR_GID=$(id -g)
COLLECTOR_OUTPUT_DIR="$CONTAINER_OUTPUT"
COLLECTOR_STATUS_DIR="$CONTAINER_STATUS"
export COLLECTOR_UID COLLECTOR_GID COLLECTOR_OUTPUT_DIR COLLECTOR_STATUS_DIR

PUBLISH_PHASE="collect"
COLLECTOR_STARTED=1
if [ "$DRY_RUN" -eq 1 ]; then
  set +e
  docker compose -f "$COMPOSE_FILE" run --rm --no-deps collector --dry-run
  COLLECTOR_EXIT=$?
  set -e
  validate_collector_result
  if [ "$COLLECTOR_EXIT" -eq 0 ] || [ "$COLLECTOR_EXIT" -eq 2 ]; then
    generated_preview="$CONTAINER_STATUS/preview.json"
    if [ ! -s "$generated_preview" ] || ! python3 -m json.tool "$generated_preview" >/dev/null 2>&1; then
      echo "collector dry-run did not produce a valid preview document" >&2
      exit 65
    fi
    preview_temporary="$STATUS_ROOT/preview.json.tmp.$$"
    cp -- "$generated_preview" "$preview_temporary"
    mv -f -- "$preview_temporary" "$STATUS_ROOT/preview.json"
    PREVIEW_PERSISTED=1
  fi
  echo "dry-run completed; no commit or push was attempted"
  PUBLISH_PHASE="complete"
  if [ "$COLLECTOR_EXIT" -eq 1 ]; then
    PUBLISH_OUTCOME="dry_run_failed"
  else
    PUBLISH_OUTCOME="dry_run"
  fi
  exit "$COLLECTOR_EXIT"
fi

set +e
docker compose -f "$COMPOSE_FILE" run --rm --no-deps collector
COLLECTOR_EXIT=$?
set -e
validate_collector_result

PUBLISH_PHASE="validate_output"
GENERATED_DATA="$CONTAINER_OUTPUT/events.json"
GENERATED_CANDIDATES="$CONTAINER_OUTPUT/candidates.json"
if [ ! -s "$GENERATED_DATA" ]; then
  echo "collector did not produce a non-empty data file" >&2
  exit 65
fi
if [ ! -s "$GENERATED_CANDIDATES" ]; then
  echo "collector did not produce a non-empty candidate report" >&2
  exit 65
fi

if cmp -s "$CURRENT_DATA" "$GENERATED_DATA" && cmp -s "$CURRENT_CANDIDATES" "$GENERATED_CANDIDATES"; then
  echo "seasonal-event data and candidate report are unchanged; no commit is needed"
  PUBLISH_PHASE="complete"
  PUBLISH_OUTCOME="unchanged"
  exit "$COLLECTOR_EXIT"
fi

PUBLISH_PHASE="publish"
git clone --quiet --no-hardlinks --branch "$BRANCH" "$REPOSITORY_ROOT" "$PUBLISH_REPOSITORY"
git -C "$PUBLISH_REPOSITORY" remote set-url origin "$REMOTE_URL"
cp -- "$GENERATED_DATA" "$PUBLISH_REPOSITORY/$DATA_PATH"
cp -- "$GENERATED_CANDIDATES" "$PUBLISH_REPOSITORY/$CANDIDATE_PATH"
git -C "$PUBLISH_REPOSITORY" add -- "$DATA_PATH" "$CANDIDATE_PATH"

if git -C "$PUBLISH_REPOSITORY" diff --cached --quiet -- "$DATA_PATH" "$CANDIDATE_PATH"; then
  echo "seasonal-event data has no Git-visible change; no commit is needed"
  PUBLISH_PHASE="complete"
  PUBLISH_OUTCOME="unchanged"
  exit "$COLLECTOR_EXIT"
fi

git -C "$PUBLISH_REPOSITORY" \
  -c user.name="seasonal-event collector" \
  -c user.email="seasonal-event-collector@users.noreply.github.com" \
  -c commit.gpgSign=false \
  commit --quiet -m "data: update seasonal events" -- "$DATA_PATH" "$CANDIDATE_PATH"
git -C "$PUBLISH_REPOSITORY" push origin "HEAD:refs/heads/$BRANCH"
PUBLISHED_COMMIT=$(git -C "$PUBLISH_REPOSITORY" rev-parse HEAD)

# The remote is already authoritative after a successful push. Keep the long-lived
# checkout current when possible; a later invocation will retry this fast-forward.
if ! git -C "$REPOSITORY_ROOT" pull --ff-only --no-rebase origin "$BRANCH"; then
  echo "warning: data was published, but the deployment checkout could not fast-forward" >&2
fi

echo "seasonal-event data was committed and pushed successfully"
PUBLISH_PHASE="complete"
PUBLISH_OUTCOME="published"
exit "$COLLECTOR_EXIT"
