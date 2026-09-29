#!/usr/bin/env python3
"""Read resource usage of this workspace's running Cere processes for 60 seconds."""
from pathlib import Path
import json, os, time
root = Path(__file__).resolve().parents[1]
def sample():
    result = {}
    for p in Path('/proc').iterdir():
        if not p.name.isdecimal():
            continue
        try:
            args = (p/'cmdline').read_bytes().split(b'\0')
            if not args or not (args[0].decode() in [str(root/'build/cere'), './build/cere'] or (str(root/'broker/main.ts').encode() in args)):
                continue
            stat = (p/'stat').read_text().rsplit(')', 1)[1].split()
            rss = pss = 0
            for line in (p/'smaps_rollup').read_text().splitlines():
                if line.startswith('Rss:'): rss = int(line.split()[1])
                if line.startswith('Pss:'): pss = int(line.split()[1])
            result[p.name] = dict(ticks=int(stat[11])+int(stat[12]),rssKiB=rss,pssKiB=pss)
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
    return result
before=sample()
start=time.monotonic()
for _ in range(60): time.sleep(1)
after=sample()
seconds=time.monotonic()-start
ticks=sum(v['ticks']-before[pid]['ticks'] for pid,v in after.items() if pid in before)
print(json.dumps(dict(seconds=round(seconds,1),processes=len(after),cpuPercentOneCore=round(ticks/os.sysconf('SC_CLK_TCK')/seconds*100,2),rssMiB=round(sum(v['rssKiB'] for v in after.values())/1024,1),pssMiB=round(sum(v['pssKiB'] for v in after.values())/1024,1))))
