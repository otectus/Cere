# Release evidence records

The mobile release workflow signs an APK only when `docs/mobile/release-evidence/<tag>.json` certifies it (`tools/mobile-release-evidence.ts check`, run in `.github/workflows/mobile-release.yml` before signing). A record binds the results to:

- the **tag** and its version (`versionName`/`versionCode`), and the **source commit** that was tested. The tag may point to a later commit only if that commit changes nothing outside this directory;
- the **unsigned release APK's SHA-256** — the artifact the release job is about to sign must have exactly these bytes;
- the **signing certificate** SHA-256 the release environment uses;
- the **desktop build** (version, commit, dirty flag) the phone was tested against;
- the **device and OS** (model, OS build, SDK level), the **date** (at most 45 days old when signing) and **who** ran the gates;
- every **required gate** (`fresh-install`, `upgrade`, `pairing`, `reconnect`, `notifications`, `attachments`, `accessibility`, `no-play`, `paired-desktop`), each `passed`, or `not-applicable` with a reason.

To prepare one, download the unsigned release APK from the `mobile-check` run of the commit to be released, then:

```sh
node tools/mobile-release-evidence.ts template app-release-unsigned.apk mobile-vX.Y.Z docs/mobile/release-evidence/mobile-vX.Y.Z.json
```

Install that APK (signed with the release certificate) on the target device, run each gate described in [`../TESTING.md`](../TESTING.md), fill in the tester, device, signer and results, and commit the record. Do not mark a gate passed that was not run on that device with those bytes. A record cannot be reused for another APK, signer, version or source change; tag the commit that contains it.
