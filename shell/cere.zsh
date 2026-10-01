# Cere telemetry v1.
[[ -o interactive ]] || return 0
[[ ${__cere_hook_pid-} != $$ ]] || return 0
typeset -g __cere_hook_pid=$$
IFS= read -r __cere_session < /proc/sys/kernel/random/uuid
typeset -g __cere_seq=0
: ${CERE_REPORT:=cere-report}
: ${CERE_RUN:=cere-run}
autoload -Uz add-zsh-hook
__cere_preexec() { local cere_status=$?; typeset -g __cere_command=$1; return $cere_status; }
__cere_precmd() {
    local cere_status=$?
    if [[ -n ${__cere_wrapped-} ]]; then unset __cere_wrapped; return $cere_status; fi
    __cere_seq=$((__cere_seq+1))
    command "$CERE_REPORT" "$__cere_session" "$__cere_seq" "$$" "$PWD" "$cere_status" "${__cere_command-}" '' >/dev/null 2>&1 &!
    unset __cere_command
    return $cere_status
}
cere-run() {
    __cere_seq=$((__cere_seq+2)); typeset -g __cere_wrapped=1
    command "$CERE_RUN" --run "$__cere_session" "$((__cere_seq-1))" "$$" "$PWD" "$@"
    return $?
}
add-zsh-hook preexec __cere_preexec
add-zsh-hook precmd __cere_precmd
# Run first so the captured status belongs to the user command.
precmd_functions=(__cere_precmd ${precmd_functions:#__cere_precmd})
