import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const [tag, apk, fingerprint, destination] = process.argv.slice(2);
// mobile-dev-vX.Y.Z: a development snapshot (the .debug package's R8 dev build, mobile-development.json),
// the metadata a development install's update check requires (ReleaseCheck.kt).
const match=/^mobile-(dev-)?v(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(tag||'');
if(!match||!apk||!destination||!/^[a-fA-F0-9]{64}$/.test(fingerprint||''))throw new Error('Usage: mobile-release.ts mobile-vX.Y.Z|mobile-dev-vX.Y.Z signed.apk CERT_SHA256 output-directory');
const development=!!match[1],packageId=development?'dev.otectus.cere.mobile.debug':'dev.otectus.cere.mobile';
const versionName=match.slice(2).join('.'),versionCode=Number(match[2])*1000000+Number(match[3])*1000+Number(match[4]);
const gradle=readFileSync(new URL('../mobile/android/app/build.gradle.kts',import.meta.url),'utf8');
if(!gradle.includes(`versionName = "${versionName}"`)||!gradle.includes(`versionCode = ${versionCode}`))throw new Error('Tag and Android version do not match');
const sdk=process.env.ANDROID_HOME||process.env.ANDROID_SDK_ROOT;if(!sdk)throw new Error('Set ANDROID_HOME to the release Android SDK');
const buildTools=join(sdk,'build-tools','36.0.0');
const badging=execFileSync(join(buildTools,'aapt2'),['dump','badging',apk],{encoding:'utf8'});
if(!badging.includes(`name='${packageId}'`)||!badging.includes(`versionCode='${versionCode}'`)||!badging.includes(`versionName='${versionName}'`)||!/^(?:min)?sdkVersion:'30'$/im.test(badging))throw new Error('APK package/version/minSdk differs from reviewed release metadata');
const verified=execFileSync(join(buildTools,'apksigner'),['verify','--verbose','--print-certs',apk],{encoding:'utf8'});
const signer=/^Signer #1 certificate SHA-256 digest: ([a-fA-F0-9]{64})$/m.exec(verified)?.[1];if(signer?.toLowerCase()!==fingerprint.toLowerCase())throw new Error('APK signer differs from the reviewed certificate');
if(development&&badging.includes('application-debuggable'))throw new Error('A development snapshot is the R8 dev build, not a debuggable one');
const output=resolve(destination),name=development?`cere-mobile-v${versionName}-dev.apk`:`cere-${tag}.apk`,bytes=readFileSync(apk),sha256=createHash('sha256').update(bytes).digest('hex');mkdirSync(output,{recursive:true});
if(resolve(apk)!==join(output,name))copyFileSync(apk,join(output,name));
// The APK speaks protocol 1 at hello revision 0 and uses each newer feature only when a desktop
// offers it, so any desktop serving cere.mobile.v1 works; features names what it can use.
const contract=JSON.parse(readFileSync(new URL('../protocol/mobile/v1/CONTRACT.json',import.meta.url),'utf8'));
// W16: the evidence record that certified these bytes (checked by tools/mobile-release-evidence.ts before signing).
const evidencePath=process.env.RELEASE_EVIDENCE,evidence=evidencePath?readFileSync(evidencePath):undefined;
if(evidence)writeFileSync(join(output,'RELEASE-EVIDENCE.json'),evidence);
// A locally built candidate names its source through SOURCE_COMMIT (and SOURCE_DIRTY=1 for uncommitted changes).
const sourceCommit=process.env.GITHUB_SHA||process.env.SOURCE_COMMIT||null,sourceDirty=process.env.SOURCE_DIRTY==='1';
const metadata={packageId,versionName,versionCode,minSdk:30,
  protocol:{major:contract.protocol.major,minMinor:0,maxMinor:0,desktopMinor:contract.protocol.minor,features:Object.keys(contract.features||{})},
  minimumDesktop:'0.1.0/mobile-v1',...(development?{development:true}:{}),sourceCommit,...(sourceDirty?{sourceDirty:true}:{}),sourceRepository:'https://github.com/otectus/Cere',apk:{name,sha256},signingCertificateSha256:fingerprint.toLowerCase(),
  ...(evidence?{evidence:{file:'RELEASE-EVIDENCE.json',sha256:createHash('sha256').update(evidence).digest('hex')}}:{})};
writeFileSync(join(output,development?'mobile-development.json':'mobile-release.json'),JSON.stringify(metadata,null,2)+'\n');
writeFileSync(join(output,'SIGNING-CERTIFICATE-SHA256.txt'),fingerprint.toLowerCase()+'\n');
writeFileSync(join(output,'SHA256SUMS'),`${sha256}  ${name}\n`);
writeFileSync(join(output,'BUILD-PROVENANCE.json'),JSON.stringify({repository:'https://github.com/otectus/Cere',tag,commit:sourceCommit,...(sourceDirty?{dirty:true}:{}),workflowRun:process.env.GITHUB_RUN_ID||null,artifact:name,sha256},null,2)+'\n');
console.log(`Prepared ${name} (${bytes.length} bytes); SHA-256 ${sha256}`);
