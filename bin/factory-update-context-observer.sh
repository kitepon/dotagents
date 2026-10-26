#!/usr/bin/env bash
# Optional observation of the running launcher, never a replacement launcher.
dotagents_observe_context() {
  [[ "${DOTAGENTS_UPDATE_CONTEXT_OBSERVER:-0}" == 1 ]] || return 0
  if [[ -z "${DOTAGENTS_UPDATE_CONTEXT_SOURCE_ROOT:-}" ]]; then
    printf 'WARN: update-context-observer source root missing; observation unknown, ordinary update continues\n' >&2
    return 0
  fi
  local phase="$1" entry="$2" parent_pid="$BASHPID" name present exported value declaration rc
  shift 2
  local -a inputs=()
  for name in HOME PATH PWD SHELL NVM_DIR AGENTS_UPDATE_PATH_PREFIX XDG_STATE_HOME XDG_CONFIG_HOME BASH_ENV ENV NVM_SYMLINK_CURRENT NVM_CD_FLAGS MANPATH; do
    present=no; exported=no; value=''
    if [[ -v "$name" ]]; then
      present=yes; value="${!name}"
      declaration="$(declare -p "$name" 2>/dev/null)" || declaration=''
      [[ "$declaration" =~ ^declare\ -[^[:space:]]*x ]] && exported=yes
    fi
    inputs+=(--input "$name" "$present" "$exported" "v:$value")
  done
  if /usr/bin/python3 "${DOTAGENTS_UPDATE_CONTEXT_SOURCE_ROOT}/bin/factory-update-context-observer.py" \
    --phase "$phase" --parent-pid "$parent_pid" --entry "$entry" \
    --output-dir "${DOTAGENTS_UPDATE_CONTEXT_DIR:-}" --expires-at "${DOTAGENTS_UPDATE_CONTEXT_EXPIRES_AT:-0}" "${inputs[@]}" "$@"; then
    return 0
  else
    rc=$?
    printf 'WARN: update-context-observer phase=%s exit=%s; observation unknown, ordinary update continues\n' "$phase" "$rc" >&2
    return 0
  fi
}

# Resolution is shell metadata only, never node/npm execution or runtime proof.
dotagents_observe_operation() {
  [[ "${DOTAGENTS_UPDATE_CONTEXT_OBSERVER:-0}" == 1 ]] || return 0
  local phase="$1" entry="$2" name kind resolved
  shift 2
  local -a resolution=()
  for name in node npm; do
    kind="$(type -t "$name" 2>/dev/null)" || kind='missing'
    resolved=''
    if [[ "$kind" == file ]]; then
      resolved="$(type -P "$name" 2>/dev/null)" || resolved=''
    fi
    resolution+=(--resolution "$name" "$kind" "v:$resolved")
  done
  dotagents_observe_context "$phase" "$entry" "${resolution[@]}" "$@"
}
