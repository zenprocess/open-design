#!/usr/bin/env bash
set -euo pipefail

for name in GITHUB_REPOSITORY GITHUB_RUN_ID; do
  if [ -z "${!name:-}" ]; then
    echo "$name is required" >&2
    exit 1
  fi
done

if [ -z "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]; then
  echo "GH_TOKEN or GITHUB_TOKEN is required" >&2
  exit 1
fi

artifacts_file="$(mktemp)"
trap 'rm -f "$artifacts_file"' EXIT
artifact_name_regex="${ARTIFACT_NAME_REGEX:-}"
cleanup_description="${ARTIFACT_CLEANUP_DESCRIPTION:-intermediate Actions artifacts after publish}"
api_attempts="${ARTIFACT_CLEANUP_API_ATTEMPTS:-5}"
initial_retry_delay_seconds="${ARTIFACT_CLEANUP_RETRY_DELAY_SECONDS:-2}"

retry_gh_api() {
  local operation="$1"
  shift
  local attempt=1
  local delay_seconds="$initial_retry_delay_seconds"
  local exit_code=0

  while true; do
    if gh api "$@"; then
      return 0
    else
      exit_code=$?
    fi

    if [ "$attempt" -ge "$api_attempts" ]; then
      echo "::warning title=Workflow artifact cleanup deferred::$operation failed after $attempt attempts; GitHub will expire the artifact normally"
      return "$exit_code"
    fi

    echo "GitHub API failed while attempting to $operation; retrying in ${delay_seconds}s ($attempt/$api_attempts)" >&2
    sleep "$delay_seconds"
    attempt=$((attempt + 1))
    delay_seconds=$((delay_seconds * 2))
  done
}

if ! retry_gh_api "list workflow artifacts" \
  --paginate \
  -H "Accept: application/vnd.github+json" \
  "/repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/artifacts?per_page=100" \
  --jq '.artifacts[] | select(.expired | not) | [.id, .name] | @tsv' \
  > "$artifacts_file"; then
  exit 0
fi

if [ ! -s "$artifacts_file" ]; then
  echo "No workflow artifacts to delete for run $GITHUB_RUN_ID"
  exit 0
fi

deleted_count=0
deferred_count=0
matched_count=0
while IFS=$'\t' read -r artifact_id artifact_name; do
  if [ -z "$artifact_id" ]; then
    continue
  fi
  if [ -n "$artifact_name_regex" ] && ! [[ "$artifact_name" =~ $artifact_name_regex ]]; then
    continue
  fi

  matched_count=$((matched_count + 1))
  echo "Deleting workflow artifact $artifact_name ($artifact_id)"
  if retry_gh_api "delete workflow artifact $artifact_name ($artifact_id)" \
    -X DELETE \
    -H "Accept: application/vnd.github+json" \
    "/repos/$GITHUB_REPOSITORY/actions/artifacts/$artifact_id"; then
    deleted_count=$((deleted_count + 1))
  else
    deferred_count=$((deferred_count + 1))
  fi
done < "$artifacts_file"

if [ "$matched_count" -eq 0 ] && [ -n "$artifact_name_regex" ]; then
  echo "No workflow artifacts matched ARTIFACT_NAME_REGEX=$artifact_name_regex for run $GITHUB_RUN_ID"
  exit 0
fi

echo "Deleted $deleted_count workflow artifacts from run $GITHUB_RUN_ID"
if [ "$deferred_count" -gt 0 ]; then
  echo "Deferred cleanup of $deferred_count workflow artifacts to GitHub retention"
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo ""
    echo "### Workflow artifacts"
    echo ""
    echo "Deleted $deleted_count $cleanup_description; deferred $deferred_count to GitHub retention."
  } >> "$GITHUB_STEP_SUMMARY"
fi
