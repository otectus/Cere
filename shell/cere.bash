# Cere telemetry v1. PROMPT_COMMAND is prepended without replacing other entries.
[[ $- == *i* ]] || return 0
[[ ${__cere_hook_pid-} != "$$" ]] || return 0
__cere_hook_pid=$$
IFS= read -r __cere_session < /proc/sys/kernel/random/uuid
__cere_seq=0
: "${CERE_REPORT:=cere-report}"
: "${CERE_RUN:=cere-run}"
__cere_prompt() {
    local cere_status=$?
    local cere_line='' cere_number='' HISTTIMEFORMAT=''
    if [[ ${__cere_wrapped-} ]]; then unset __cere_wrapped; return "$cere_status"; fi
    if [[ ${__cere_command-} ]]; then cere_line=$__cere_command; unset __cere_command
    else
        IFS=' ' read -r cere_number cere_line <<< "$(builtin history 1)"
        if [[ $cere_number == "${__cere_history_id-}" ]]; then cere_line=''; fi
        __cere_history_id=$cere_number
    fi
    __cere_seq=$((__cere_seq+1))
    { command "$CERE_REPORT" "$__cere_session" "$__cere_seq" "$$" "$PWD" "$cere_status" "$cere_line" '' & disown "$!"; } >/dev/null 2>&1
    return "$cere_status"
}
__cere_preexec() { local cere_status=$?; __cere_command=$1; return "$cere_status"; }
cere-run() {
    __cere_seq=$((__cere_seq+2)); __cere_wrapped=1
    command "$CERE_RUN" --run "$__cere_session" "$((__cere_seq-1))" "$$" "$PWD" "$@"
    return $?
}
if declare -p precmd_functions >/dev/null 2>&1 && declare -F __bp_precmd_invoke_cmd >/dev/null 2>&1; then
    precmd_functions=(__cere_prompt "${precmd_functions[@]}")
    preexec_functions+=(__cere_preexec)
elif [[ $(declare -p PROMPT_COMMAND 2>/dev/null) =~ ^declare\ -[^[:space:]]*a ]]; then
    PROMPT_COMMAND=(__cere_prompt "${PROMPT_COMMAND[@]}")
else
    PROMPT_COMMAND="__cere_prompt${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
fi
