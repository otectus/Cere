import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import sharp from 'sharp';
import { captureDisplay, captureInSatty } from '../desktop.ts';
import { remoteError } from '../execution.ts';
import { bytesDigest } from './crypto.ts';
import type { Router } from './router.ts';
import type { Device } from './store.ts';

type State = 'capturing' | 'editing' | 'ready' | 'attached' | 'cancelled' | 'failed' | 'expired';
type Job = {
  id: string; deviceId: string; projectId: string; edit: boolean; state: State; message: string;
  startedAt: number; updatedAt: number; expiresAt: number; controller: AbortController;
  path?: string; imageDigest?: string; size?: number; width?: number; height?: number;
};
/** How long a ready capture waits to be attached or discarded, and how long Satty may stay open. */
export const captureLimits = { readyMs: 15 * 60_000, editMs: 10 * 60_000, captureMs: 30_000, perDevice: 4 };

/**
 * W10: screen captures a paired phone starts. Each is an accepted job: started at once, then
 * capturing, editing (Satty open on the desktop, waiting for whoever is there to save or close it),
 * ready, attached, cancelled, failed or expired. A ready image is immutable and identified by its
 * digest; the phone previews a reduced copy and attaches the exact original by that digest. Nothing
 * reaches a provider until the phone attaches it to a message and sends that message, under the
 * ordinary attachment rules. Revocation, a scope change, Stop and shutdown cancel open captures.
 */
export class Captures {
  router: Router; jobs = new Map<string, Job>();
  /** The gateway tells the device's phones that a capture changed. */
  changed?: (deviceId: string, dto: ReturnType<Captures['dto']>) => void;
  constructor(router: Router) { this.router = router; }
  dto(job: Job) {
    return { captureId: job.id, projectId: job.projectId, edit: job.edit, state: job.state, message: job.message, startedAt: job.startedAt, updatedAt: job.updatedAt, expiresAt: job.expiresAt,
      ...(job.state === 'ready' ? { imageDigest: job.imageDigest, size: job.size, width: job.width, height: job.height } : {}) };
  }
  owned(device: Device, id: string) {
    this.router.current(device);
    const job = this.jobs.get(id);
    if (!job || job.deviceId !== device.id) throw remoteError('INVALID_ARGUMENT', 'This capture is no longer available.');
    this.expire(job);
    return job;
  }
  start(device: Device, p: { projectId: string; edit: boolean }) {
    this.router.category(device, p.projectId, 'capture');
    const mine = [...this.jobs.values()].filter(job => job.deviceId === device.id);
    if (mine.some(job => job.state === 'capturing' || job.state === 'editing')) throw remoteError('SESSION_BUSY', 'A capture from this phone is still in progress.');
    if (mine.filter(job => job.state === 'ready').length >= captureLimits.perDevice) throw remoteError('LIMIT_EXCEEDED', 'Attach or discard an earlier capture first.');
    for (const job of mine) if (job.state !== 'ready') this.jobs.delete(job.id);
    const now = Date.now(), job: Job = { id: randomUUID(), deviceId: device.id, projectId: p.projectId, edit: p.edit, state: 'capturing', message: 'Capturing the desktop display', startedAt: now, updatedAt: now, expiresAt: now + (p.edit ? captureLimits.editMs : captureLimits.captureMs), controller: new AbortController() };
    this.jobs.set(job.id, job);
    void this.run(device, job);
    return this.dto(job);
  }
  private update(job: Job, state: State, message: string) { job.state = state; job.message = message; job.updatedAt = Date.now(); this.changed?.(job.deviceId, this.dto(job)); }
  private async run(device: Device, job: Job) {
    const signal = job.controller.signal;
    const timer = setTimeout(() => job.controller.abort(remoteError('CAPTURE_EXPIRED', job.edit ? 'Satty stayed open too long; the capture was cancelled.' : 'The capture took too long.')), job.expiresAt - Date.now());
    timer.unref();
    const check = () => { this.router.category(device, job.projectId, 'capture'); signal.throwIfAborted(); };
    try {
      check();
      if (job.edit) this.update(job, 'editing', 'Waiting for the capture to be saved in Satty on the desktop');
      const result: { path?: string; cancelled?: boolean } = job.edit ? await captureInSatty(signal) : await captureDisplay(signal);
      check();
      if (result.cancelled || !result.path) { this.update(job, 'cancelled', 'Satty was closed without saving the capture.'); return; }
      job.path = result.path;
      // Checked and identified once: the bytes the digest names are the bytes later attached.
      const bytes = await readFile(job.path);
      if (bytes.length > 20 * 1024 * 1024) throw remoteError('LIMIT_EXCEEDED', 'The capture is too large to share from the phone.');
      const metadata = await sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'error' }).metadata();
      if (metadata.format !== 'png' || !metadata.width || !metadata.height) throw remoteError('ATTACHMENT_INVALID', 'The capture is not a readable image.');
      check();
      Object.assign(job, { imageDigest: bytesDigest(bytes), size: bytes.length, width: metadata.width, height: metadata.height, expiresAt: Date.now() + captureLimits.readyMs });
      this.update(job, 'ready', 'Captured. Review it, then attach it to a message or discard it.');
    } catch (error: any) {
      if (job.path) await unlink(job.path).catch(() => {});
      job.path = undefined;
      const reason = signal.aborted ? signal.reason : error;
      const expired = reason?.code === 'CAPTURE_EXPIRED';
      this.update(job, expired ? 'expired' : signal.aborted ? 'cancelled' : 'failed',
        reason?.remote === true ? reason.message : signal.aborted ? 'The capture was cancelled.' : 'The desktop could not capture its display. Check that grim (and Satty for editing) are installed.');
    } finally { clearTimeout(timer); }
  }
  private expire(job: Job) {
    if (job.state === 'ready' && job.expiresAt < Date.now()) { if (job.path) void unlink(job.path).catch(() => {}); job.path = undefined; this.update(job, 'expired', 'The capture expired before it was attached.'); }
  }
  /** The exact ready image, for a preview or an attachment. */
  async image(device: Device, id: string, imageDigest?: string) {
    const job = this.owned(device, id);
    if (job.state !== 'ready' || !job.path) throw remoteError('ATTACHMENT_INVALID', 'This capture is not ready.');
    const bytes = await readFile(job.path);
    if (bytesDigest(bytes) !== job.imageDigest || (imageDigest !== undefined && imageDigest !== job.imageDigest)) throw remoteError('REVISION_CONFLICT', 'Review the current capture before attaching it.');
    return { job, bytes };
  }
  attached(job: Job) { if (job.path) void unlink(job.path).catch(() => {}); job.path = undefined; this.update(job, 'attached', 'Attached to a message draft.'); }
  async discard(device: Device, id: string) {
    const job = this.owned(device, id);
    job.controller.abort(remoteError('CAPTURE_CANCELLED', 'The capture was cancelled.'));
    if (job.path) await unlink(job.path).catch(() => {});
    this.jobs.delete(job.id);
    return true;
  }
  /** Revocation, a scope change or shutdown: open captures stop and ready ones are removed. */
  async abort(deviceId?: string) {
    for (const job of [...this.jobs.values()]) if (!deviceId || job.deviceId === deviceId) {
      job.controller.abort(remoteError('CAPTURE_CANCELLED', 'The capture was cancelled.'));
      if (job.state === 'ready' && job.path) await unlink(job.path).catch(() => {});
      this.jobs.delete(job.id);
    }
  }
}
