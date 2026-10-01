"""Interactive shell acceptance and prompt latency, isolated from user rc/history."""
import json
import os
from pathlib import Path
import pty
import re
import select
import socket
import statistics
import subprocess
import tempfile
import termios
import fcntl
import threading
import time

ROOT = Path(__file__).resolve().parent.parent

class Shell:
    def __init__(self, name, directory):
        self.name = name
        self.master, slave = pty.openpty()
        attrs = termios.tcgetattr(slave); attrs[3] &= ~termios.ECHO; termios.tcsetattr(slave, termios.TCSANOW, attrs)
        env = dict(os.environ, HOME=directory, XDG_CONFIG_HOME=directory, XDG_RUNTIME_DIR=directory,
                   ZDOTDIR=directory, TERM='dumb', CERE_REPORT=str(ROOT/'build/cere-report'), CERE_RUN=str(ROOT/'tools/cere-run'))
        args = {'bash':['bash','--noprofile','--norc','-i'], 'fish':['fish','--no-config','-i'], 'zsh':['zsh','-df','-i']}[name]
        def terminal():
            os.setsid(); fcntl.ioctl(0, termios.TIOCSCTTY, 0)
        self.child = subprocess.Popen(args, stdin=slave, stdout=slave, stderr=slave, env=env, preexec_fn=terminal)
        os.close(slave)
        setup = {'bash':"PS1='CERE_DONE> '; PROMPT_COMMAND=''; set +o history",
                 'fish':"function fish_prompt; printf 'CERE_DONE> '; end; function fish_greeting; end",
                 'zsh':"PROMPT='CERE_DONE> '; RPROMPT=''; unsetopt zle"}[name]
        os.write(self.master, ("printf '\\036CERE_START\\037'; "+setup+'\n').encode()); self.read()
    def read(self, timeout=5):
        result=b''; deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            if select.select([self.master],[],[],.1)[0]:
                try: result+=os.read(self.master,65536)
                except OSError: break
                marker=result.find(b'\x1eCERE_START\x1f')
                if marker>=0 and b'CERE_DONE> ' in result[marker:]: return result[marker:].decode(errors='replace')
        raise AssertionError('Shell prompt timeout: '+result.decode(errors='replace'))
    def command(self, text):
        os.write(self.master,("printf '\\036CERE_START\\037'; "+text+'\n').encode()); return self.read()
    def close(self):
        self.child.terminate()
        try:self.child.wait(timeout=2)
        except subprocess.TimeoutExpired:self.child.kill();self.child.wait()
        os.close(self.master)

def measure(shell, n=40):
    times=[]
    for _ in range(n):
        start=time.perf_counter();shell.command('true');times.append((time.perf_counter()-start)*1000)
    times.sort()
    return {'p50_ms':statistics.median(times),'p95_ms':times[int(len(times)*.95)-1],'p99_ms':times[-1]}

def main():
    results={}
    with tempfile.TemporaryDirectory(prefix='cere-shell-tests-') as directory:
        os.mkdir(directory+'/cere'); server=socket.socket(socket.AF_UNIX);server.bind(directory+'/cere/telemetry.sock');server.listen(32);server.settimeout(.1)
        events=[]; done=threading.Event()
        def serve():
            while not done.is_set():
                try:client,_=server.accept()
                except socket.timeout:continue
                except OSError:break
                with client:
                    client.settimeout(.4)
                    try:
                        client.sendall(b'{"enabled":true,"commands":true,"output":true}\n');raw=b''
                        while True:
                            chunk=client.recv(16384)
                            if not chunk:break
                            raw+=chunk
                        events.extend(json.loads(line) for line in raw.splitlines())
                    except (OSError,ValueError):pass
        thread=threading.Thread(target=serve);thread.start()
        try:
            for name in ('fish','bash','zsh'):
                shell=Shell(name,directory)
                try:
                    disabled=measure(shell)
                    source='source '+str(ROOT/'shell'/('cere.'+name))
                    shell.command(source)
                    # Re-sourcing preserves identity and counter, with no duplicate prompt entries.
                    output=shell.command({'fish':'set -l before $__cere_session; '+source+'; test "$before" = "$__cere_session"; printf "RESOURCED:%s\\n" $status',
                      'bash':'before=$__cere_session; '+source+'; test "$before" = "$__cere_session"; printf "RESOURCED:%s\\n" "$?"',
                      'zsh':'before=$__cere_session; '+source+'; test "$before" = "$__cere_session"; printf "RESOURCED:%s\\n" "$?"'}[name])
                    assert 'RESOURCED:0' in output,(name,output)
                    enabled=measure(shell)
                    output=shell.command('false')
                    assert not re.search(r'\[\d+\]|Job \d|ended|Done',output),(name,output)
                    if name=='bash':
                        shell.command("prior(){ local s=$?; printf 'PRIOR:%s\\n' \"$s\"; return \"$s\"; }; PROMPT_COMMAND=(__cere_prompt prior)")
                        assert 'PRIOR:1' in shell.command('false')
                        shell.command("PROMPT_COMMAND='__cere_prompt; prior'")
                        assert 'PRIOR:1' in shell.command('false')
                    if name=='fish':
                        shell.command("function fish_prompt; set -l snapshot $status $pipestatus; printf 'PIPE:%s STATUS:%s\\n' (string join , $snapshot[2..]) $snapshot[1]; printf 'CERE_DONE> '; end")
                        output=shell.command('false | true');assert 'PIPE:1,0 STATUS:0' in output,output
                        output=shell.command('true | false');assert 'PIPE:0,1 STATUS:1' in output,output
                    # Child shells must replace inherited identities, even if exported explicitly.
                    if name=='fish':
                        nested="set -gx CERE_PARENT $__cere_session; fish --no-config -ic 'source "+str(ROOT/'shell/cere.fish')+"; test \"$CERE_PARENT\" != \"$__cere_session\"; printf \"NESTED:%s\\n\" $status'"
                    else:
                        flags='--noprofile --norc' if name=='bash' else '-df'
                        nested="export CERE_PARENT=$__cere_session; "+name+' '+flags+" -ic 'source "+str(ROOT/'shell'/('cere.'+name))+"; test \"$CERE_PARENT\" != \"$__cere_session\"; printf \"NESTED:%s\\n\" \"$?\"'"
                    assert 'NESTED:0' in shell.command(nested)
                    # A real terminal interrupt must be reported as SIGINT, not as reporter success.
                    os.write(shell.master,b"printf '\\036CERE_START\\037'; sleep 10\n")
                    time.sleep(.1);os.write(shell.master,b'\x03');shell.read()
                    shell.command("cere-run sh -c 'echo wrapped-error >&2; exit 7'")
                    time.sleep(.25)
                    own=[e for e in events if e['pid']==shell.child.pid]
                    assert any(e['status']==1 for e in own if e['type']=='command'),(name,own[-3:])
                    assert any(e['status']==130 for e in own if e['type']=='command'),(name,own[-3:])
                    assert any(e['type']=='output' and e['lines']==['wrapped-error'] for e in own),(name,own[-3:])
                    results[name]={'disabled':disabled,'enabled':enabled,'added_p95_ms':enabled['p95_ms']-disabled['p95_ms'],'events':len(own)}
                finally:shell.close()
            for mode in ('string','array','preexec'):
                shell=Shell('bash',directory)
                try:
                    setup="prior(){ local s=$?; printf 'EXISTING:%s\\n' \"$s\"; return \"$s\"; }; "
                    setup+= {'string':"PROMPT_COMMAND='prior'",'array':'PROMPT_COMMAND=(prior)',
                             'preexec':"precmd_functions=(prior); preexec_functions=(); __bp_precmd_invoke_cmd(){ :; }; PROMPT_COMMAND='__cere_prompt; prior'"}[mode]
                    shell.command(setup);shell.command('source '+str(ROOT/'shell/cere.bash'))
                    assert 'EXISTING:1' in shell.command('false'),mode
                finally:shell.close()
            for name in ('fish','bash','zsh'):
                rc=Path(directory)/('test.'+name);rc.write_text('# existing user content\n')
                args=[str(ROOT/'tools/cere-telemetry-hooks'),'install',name,'--rc',str(rc)]
                subprocess.run(args,check=True,capture_output=True);first=rc.read_text();subprocess.run(args,check=True,capture_output=True);assert rc.read_text()==first
                args[1]='uninstall';subprocess.run(args,check=True,capture_output=True);assert rc.read_text()=='# existing user content\n'
        finally:done.set();server.close();thread.join()
    print(json.dumps(results,indent=2))

if __name__=='__main__':main()
