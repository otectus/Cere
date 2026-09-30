# Cere Mobile setup

The Android client lives in [`mobile/android`](../../mobile/android/README.md). It needs Android 11/API 30 or newer; this build targets Android 17/API 37. Desktop Cere remains responsible for providers, tools, projects, memory and timers. Keep the desktop awake and connected. The app needs no Google Play services, account server or relay, and does not configure router forwarding or firewall rules automatically.

## Build and install for development

Use JDK 17 and an Android SDK containing platform 37 and Build Tools 36.0.0. The checked-in wrapper and dependency verification metadata pin the Android build. Run:

```sh
cd mobile/android
./gradlew :core:protocol:test :core:data:testDebugUnitTest :app:lintDebug :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

The debug package is `dev.otectus.cere.mobile.debug`; it can coexist with the future signed stable package, `dev.otectus.cere.mobile`. Do not treat a debug signing key as a release identity. The Cere face PNG and its generation prompt are in [`mobile/artwork`](../../mobile/artwork/).

Build the matching desktop source with `npm ci` and `npm run build`. Installed desktop packaging includes the gateway, protocol files and Node dependencies. `openssl` creates the private desktop pairing certificate. Starting the desktop does **not** enable network listening.

## Pair locally

1. On desktop, open **Settings → Cere Mobile**. Select one to three literal IP addresses belonging to this desktop, such as its LAN and existing WireGuard addresses. Wildcard listening is rejected. The default TCP port is 8443.
2. Prepare the offline QR offer. On Android, scan it or paste its complete `cere-pair://v1/…` text. Give the phone a recognizable name. Authenticate the device key creation with a strong biometric or device credential.
3. Copy the phone's signed public response back to desktop and verify it. Compare all six words on both screens. An offer lasts five minutes and is single use.
4. Select exact approved project folders and individual capabilities/categories. Native provider execution loads those projects' CLI configuration. Desktop ordinary permissions still apply; local bypass switches never expand remote authority. An Ollama grant pins the current desktop Ollama server as well as its projects.
5. Confirm the matching words on desktop. Finish pairing on Android and allow the contextual notification/local-network permissions. The app should show **Online**. Connection status does not guarantee a particular provider is installed or authorized.

The persistent monitoring notification is opt-in. Its Stop action disconnects monitoring; it does not cancel an already accepted desktop turn. Use the session's **Stop** control to interrupt that work. Android force-stop, a locked work/private profile, desktop sleep, a missing VPN or battery restrictions can prevent delivery. Settings shows battery status and opens Android's battery settings; the app never silently requests an exemption.

For use away from home, configure and verify your existing WireGuard VPN first, then pair its desktop address. Cere does not configure a VPN or expose a public server.

## If pairing succeeds but the phone stays offline

First check that desktop `cere remote status` reports an enabled listener and that Android has local-network permission with **Monitor desktop** enabled. On a desktop using UFW, kernel entries containing `UFW BLOCK` and `DPT=8443` identify a firewall block. Add an administrator-approved TCP rule for the phone's source IP, the desktop's selected IP/interface, and the configured port. Do not disable the firewall. For example, replace the placeholders before running:

```sh
sudo ufw allow in on DESKTOP_INTERFACE proto tcp from PHONE_IP to DESKTOP_IP port 8443 comment 'Cere phone'
```

This rule needs updating if DHCP changes either address. A changed desktop address also needs an updated signed pairing endpoint. A successful TCP probe alone does not prove authentication: verify **Online** on Android and that the same phone appears in desktop `remote status` under `connected`.

If the app reports missing pairing keys, install the corrected build, revoke that device on desktop, then use **Forget desktop** and pair again. Android Keystore private keys cannot be reconstructed from the saved public pairing details. A connection limit can temporarily mask the first failure after repeated retries; stop monitoring for one minute before checking a single new attempt.

## Manage access

Desktop settings can disable the gateway, revoke a phone, reduce/change its grants, renew a live device for 90 days, or clear its retained uploaded images. Disable and revoke stop remotely controlled work and close sockets. Ordinary phone disconnection leaves accepted work running. Renewing a device does not add capabilities.

`cere remote status` and `cere remote off` provide local CLI status and shutdown. The tray also exposes remote shutdown. No remote method can re-enable the gateway, edit endpoints, grant privileges, change scripts, or invoke general local RPC.

Changed desktop address or expired one-year certificate: use **Reset gateway identity** on desktop, explicitly confirm that all phones will need pairing again, then forget the old desktop on each phone and repeat offline pairing. Reset revokes devices and deletes old pairing material. Automatic signed certificate/endpoint rotation is not implemented in this protocol build.

Use **Forget desktop** on Android to erase pairing keys and the encrypted cache. It does not revoke the old record on an unreachable desktop; revoke there as well when reachable. A confirmed online revocation clears the phone's local pairing.

See [current implementation and validation limits](TESTING.md) before using this development build for unattended control.

## Connection timeouts after Wi-Fi reconnect

If the desktop listener is running and the phone can reach the PC but TCP 8443 times out, compare the phone’s current Wi-Fi IP with the source IP in the desktop firewall rule. A DHCP change invalidates a rule limited to the previous phone address. Keep the rule limited to the intended phone/interface/desktop endpoint; reserve the phone’s Wi-Fi address in the router (using its per-network MAC address) for a lasting fix. Changing the source rule does not require deleting the pairing or its keys. A changed desktop address also requires updating the paired endpoint using the supported local pairing flow.
