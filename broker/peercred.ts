import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Socket } from "node:net";
const require = createRequire(import.meta.url);
const locations = [
  new URL("../native/cere-peercred.node", import.meta.url),
  new URL("../build/cere-peercred.node", import.meta.url),
];
const path = locations.map((url) => fileURLToPath(url)).find(existsSync);
const native = path ? require(path) : undefined;
/** Node's fd bridge is feature-tested on every connection; credential failure closes it. */
export function sameUserPeer(socket: Socket) {
  const fd = (socket as any)._handle?.fd;
  if (!native || !Number.isInteger(fd)) return false;
  try {
    return native.credentials(fd).uid === process.getuid?.();
  } catch {
    return false;
  }
}
export function requirePeerCredentials() {
  if (!native)
    throw new Error(
      "Cere peer credential helper is missing. Run npm run build before starting the broker.",
    );
}
