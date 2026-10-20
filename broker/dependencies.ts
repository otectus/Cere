import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * W10: the external programs desktop features rely on, found on PATH without running them. A
 * missing one disables only the feature it serves (capture, volume, playback, speech, recording),
 * never chat; Health and the phone's desktop status say which and why.
 */
export const desktopDependencies = [
  { name: 'hyprctl', feature: 'Window, workspace and display control (Hyprland)' },
  { name: 'grim', feature: 'Screen capture' },
  { name: 'satty', feature: 'Editing a capture before sharing it' },
  { name: 'wpctl', feature: 'Volume and mute (PipeWire / WirePlumber)' },
  { name: 'busctl', feature: 'Media playback control (MPRIS over D-Bus)' },
  { name: 'gtk-launch', feature: 'Launching applications' },
  { name: 'xdg-open', feature: 'Opening files' },
  { name: 'notify-send', feature: 'Desktop notifications for timers' },
  { name: 'aplay', feature: 'Speech playback (ALSA)' },
  { name: 'sox', feature: 'Voice tuning for speech' },
  { name: 'pw-record', feature: 'Recording for dictation (PipeWire)', absolute: '/usr/bin/pw-record' },
  { name: 'arecord', feature: 'Recording for dictation (ALSA fallback)', absolute: '/usr/bin/arecord' },
] as const;

export function onPath(name: string, path = process.env.PATH || '') {
  for (const directory of path.split(delimiter)) {
    if (!directory) continue;
    try { accessSync(join(directory, name), constants.X_OK); return true; } catch {}
  }
  return false;
}

export function dependencyReport(path?: string) {
  return desktopDependencies.map(dependency => {
    const absolute = 'absolute' in dependency ? dependency.absolute : undefined;
    let available = onPath(dependency.name, path);
    if (!available && absolute) try { accessSync(absolute, constants.X_OK); available = true; } catch {}
    return { name: dependency.name, feature: dependency.feature, available };
  });
}
