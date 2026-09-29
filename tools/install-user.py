#!/usr/bin/env python3
"""Install a built Cere under ~/.local, or stage it with --prefix."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--prefix', type=Path, default=Path.home() / '.local')
args = parser.parse_args()
repo = Path(__file__).resolve().parent.parent
prefix = args.prefix.resolve()
local = repo / '.local-deps/usr'
env = os.environ.copy()
cmake = shutil.which('cmake')
if not cmake:
    cmake = str(local / 'bin/cmake')
    env['LD_LIBRARY_PATH'] = str(local / 'lib') + ':' + env.get('LD_LIBRARY_PATH', '')
subprocess.run([cmake, '--install', str(repo / 'build'), '--prefix', str(prefix)], env=env, check=True)

# Arch's Qt and Node remain system dependencies. Bundle the optional layer-shell
# integration when development used a locally extracted package.
if (local / 'lib/libLayerShellQtInterface.so.6').exists():
    shutil.copy2(local / 'lib/libLayerShellQtInterface.so.6', prefix / 'lib/cere/libLayerShellQtInterface.so.6')
    plugins = prefix / 'lib/cere/plugins/wayland-shell-integration'
    plugins.mkdir(parents=True, exist_ok=True)
    shutil.copy2(local / 'lib/qt6/plugins/wayland-shell-integration/liblayer-shell.so', plugins)

def desktop_quote(value):
    return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"').replace('`', '\\`').replace('$', '\\$').replace('%', '%%') + '"'

launcher = prefix / 'bin/cere'
desktop = (repo / 'packaging/cere.desktop').read_text().replace('Exec=cere --show', 'Exec=' + desktop_quote(launcher) + ' --show')
(prefix / 'share/applications/cere.desktop').write_text(desktop)

# The user data unit directory is in systemd's standard per-user search path.
units = prefix / 'share/systemd/user'
units.mkdir(parents=True, exist_ok=True)
unit = (repo / 'packaging/cere-broker.service').read_text()
broker = str(prefix / 'share/cere/broker/main.ts').replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%')
unit = unit.replace('/usr/share/cere/broker/main.ts', '"' + broker + '"')
(units / 'cere-broker.service').write_text(unit)
(prefix / 'lib/systemd/user/cere-broker.service').write_text(unit)

if prefix == Path.home() / '.local':
    # Keep the user's existing choice to launch at login, using installed files.
    autostart = Path(os.environ.get('XDG_CONFIG_HOME', str(Path.home() / '.config'))) / 'autostart/cere.desktop'
    if autostart.exists():
        autostart.write_text(desktop.replace(' --show\n', '\n'))
    subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
    for command in (['update-desktop-database', str(prefix / 'share/applications')],
                    ['gtk-update-icon-cache', '-f', '-t', str(prefix / 'share/icons/hicolor')]):
        if shutil.which(command[0]):
            subprocess.run(command, check=True)
print(f'Installed Cere: {launcher}')
