# Source this file from config.fish. Handlers are installed immediately and emit no command lines.
if status is-interactive
    if not set -q CERE_MEMORY_EMITTER
        set -gx CERE_MEMORY_EMITTER (path resolve (status dirname)/cere-memory-emitter.py)
    end
    if test -x "$CERE_MEMORY_EMITTER"
        set -g __cere_memory_session (command "$CERE_MEMORY_EMITTER" --print-session-id 2>/dev/null)
        set -g __cere_memory_sequence 0

        function __cere_memory_emit
            set -g __cere_memory_sequence (math $__cere_memory_sequence + 1)
            set -l cere_binding
            if set -q KITTY_WINDOW_ID
                set cere_binding --kitty-window-id "$KITTY_WINDOW_ID"
            end
            command "$CERE_MEMORY_EMITTER" --event $argv[1] --session-id "$__cere_memory_session" \
                --sequence $__cere_memory_sequence --cwd "$PWD" $argv[2..] $cere_binding >/dev/null 2>&1 &
        end

        function __cere_memory_pwd --on-variable PWD
            __cere_memory_emit cwd
        end

        function __cere_memory_preexec --on-event fish_preexec
            # The event's command argument is deliberately ignored.
            true
        end

        function __cere_memory_postexec --on-event fish_postexec
            set -l cere_status_snapshot $status $pipestatus
            set -l cere_status $cere_status_snapshot[1]
            set -l cere_pipeline $cere_status_snapshot[2..]
            set -l cere_args --status $cere_status --duration-ms "$CMD_DURATION"
            for value in $cere_pipeline
                set -a cere_args --pipeline-status $value
            end
            __cere_memory_emit postexec $cere_args
            return $cere_status
        end

        function __cere_memory_posterror --on-event fish_posterror
            set -l cere_status_snapshot $status $pipestatus
            set -l cere_status $cere_status_snapshot[1]
            set -l cere_pipeline $cere_status_snapshot[2..]
            set -l cere_args --status $cere_status --duration-ms "$CMD_DURATION"
            for value in $cere_pipeline
                set -a cere_args --pipeline-status $value
            end
            __cere_memory_emit posterror $cere_args
            return $cere_status
        end

        function __cere_memory_focus_in --on-event fish_focus_in
            __cere_memory_emit focus_in
        end

        function __cere_memory_focus_out --on-event fish_focus_out
            __cere_memory_emit focus_out
        end

        function __cere_memory_exit --on-event fish_exit
            set -l cere_status_snapshot $status $pipestatus
            __cere_memory_emit exit --status $cere_status_snapshot[1]
        end

        __cere_memory_emit start
    end
end
