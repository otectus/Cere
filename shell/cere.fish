# Cere telemetry v1. Source only; never modifies shell history.
if not status is-interactive
    return
end
if set -q __cere_hook_pid; and test "$__cere_hook_pid" = "$fish_pid"
    return
end
set -g __cere_hook_pid $fish_pid
read -l cere_uuid < /proc/sys/kernel/random/uuid
set -g __cere_session $cere_uuid
set -g __cere_seq 0
if not set -q CERE_REPORT
    set -g CERE_REPORT cere-report
end
if not set -q CERE_RUN
    set -g CERE_RUN cere-run
end
function __cere_postexec --on-event fish_postexec
    set -l cere_snapshot $status $pipestatus
    if set -q __cere_wrapped
        set -e __cere_wrapped
        return $cere_snapshot[1]
    end
    set -g __cere_seq (math $__cere_seq + 1)
    begin
        command "$CERE_REPORT" "$__cere_session" "$__cere_seq" "$fish_pid" "$PWD" "$cere_snapshot[1]" "$argv[1]" "" &
        disown $last_pid
    end >/dev/null 2>&1
    return $cere_snapshot[1]
end
function cere-run
    set -g __cere_seq (math $__cere_seq + 2)
    set -g __cere_wrapped 1
    command "$CERE_RUN" --run "$__cere_session" (math $__cere_seq - 1) "$fish_pid" "$PWD" $argv
    return $status
end
