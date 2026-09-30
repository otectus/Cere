#!/usr/bin/env python3
"""One owned SSIP connection per utterance; cancellation affects only this client."""
import json
import os
import signal
import sys
import threading


def main():
    import speechd

    request = json.load(sys.stdin)
    stopped = threading.Event()
    ended = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    signal.signal(signal.SIGINT, lambda *_: stopped.set())
    runtime = os.environ.get('XDG_RUNTIME_DIR') or os.environ.get('XDG_CACHE_HOME') or os.path.expanduser('~/.cache')
    address = os.environ.get('SPEECHD_ADDRESS') or 'unix_socket:' + os.path.join(runtime, 'speech-dispatcher/speechd.sock')
    if address.startswith('unix:'):
        address = 'unix_socket:' + address[len('unix:'):]
    if not address.startswith('unix_socket:'):
        raise RuntimeError('Cere requires a local Speech Dispatcher socket')
    client = speechd.SSIPClient('cere', component='response', address=address)
    try:
        # Explicitly select our local module: never silently speak with a system
        # default that might use a network service or an unrelated screen reader.
        client.set_output_module('cere-piper')
        if request['voice'] not in [voice[0] for voice in client.list_synthesis_voices()]:
            raise RuntimeError('Selected Piper voice is not registered')
        client.set_synthesis_voice(request['voice'])
        client.set_punctuation(speechd.PunctuationMode.NONE)

        def event(kind, **_):
            if kind in (speechd.CallbackType.END, speechd.CallbackType.CANCEL):
                ended.set()

        if stopped.is_set():
            return
        client.speak(request['text'], callback=event)
        print('accepted', flush=True)
        while not ended.wait(0.05):
            if stopped.is_set():
                client.cancel()  # Scope.SELF; leave other applications alone.
                break
    finally:
        try:
            client.cancel()
        finally:
            client.close()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Diagnostics live in the broker; never echo private response text.
        sys.exit(69)
