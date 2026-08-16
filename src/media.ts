import { createHash, randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import { config } from './config.js';

export type MediaFolder = 'banners' | 'tours' | 'hotels' | 'homes' | 'destinations' | 'services' | 'testimonials' | 'logos' | 'general';
export type DetectedImage = { mimeType: 'image/jpeg' | 'image/png' | 'image/webp'; format: 'jpg' | 'png' | 'webp' };

const FOLDERS = new Set<MediaFolder>(['banners','tours','hotels','homes','destinations','services','testimonials','logos','general']);
function cloudinaryBase() { return `https://api.cloudinary.com/v1_1/${encodeURIComponent(config.cloudinaryCloudName)}`; }
function signature(params: Record<string, string>) { const serialized = Object.entries(params).filter(([, value]) => value !== '').sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('&'); return createHash('sha1').update(`${serialized}${config.cloudinaryApiSecret}`).digest('hex'); }
function timeoutSignal() { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), config.mediaTimeoutMs); return { controller, timer }; }

export function detectImage(buffer: Buffer, declaredMime?: string): DetectedImage {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return { mimeType: 'image/png', format: 'png' };
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mimeType: 'image/jpeg', format: 'jpg' };
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return { mimeType: 'image/webp', format: 'webp' };
  throw new AppError(415, 'UNSUPPORTED_IMAGE_FORMAT', `Unsupported image format${declaredMime ? `: ${declaredMime}` : ''}`);
}

export function optimizedMediaUrl(url: string | undefined, options: { width?: number; quality?: string } = {}) { if (!url || !url.includes('res.cloudinary.com')) return url; const transformations = ['f_auto', `q_${options.quality || 'auto'}`]; if (options.width) transformations.push(`w_${Math.max(160, Math.floor(options.width))}`, 'c_limit'); return url.replace('/upload/', `/upload/${transformations.join(',')}/`); }

export class MediaService {
  isConfigured() { return Boolean(config.cloudinaryCloudName && config.cloudinaryApiKey && config.cloudinaryApiSecret); }
  private assertConfigured() { if (!this.isConfigured()) throw new AppError(503, 'MEDIA_NOT_CONFIGURED', 'Persistent image storage is not configured'); }
  async upload(buffer: Buffer, input: { folder: string; originalFilename: string; declaredMime?: string; altText?: string }) {
    this.assertConfigured();
    if (buffer.length > config.mediaMaxUploadBytes) throw new AppError(413, 'IMAGE_TOO_LARGE', 'Image exceeds the maximum allowed size');
    const detected = detectImage(buffer, input.declaredMime);
    const folder = (FOLDERS.has(input.folder as MediaFolder) ? input.folder : 'general') as MediaFolder;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const publicId = `asset-${randomUUID()}`;
    const params = { folder: `sadik-travels/${folder}`, public_id: publicId, timestamp };
    const form = new FormData();
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    form.append('file', new Blob([arrayBuffer], { type: detected.mimeType }), input.originalFilename || `${publicId}.${detected.format}`);
    form.append('api_key', config.cloudinaryApiKey);
    form.append('folder', params.folder);
    form.append('public_id', params.public_id);
    form.append('timestamp', params.timestamp);
    form.append('signature', signature(params));
    const { controller, timer } = timeoutSignal();
    try {
      const response = await fetch(`${cloudinaryBase()}/image/upload`, { method: 'POST', body: form, signal: controller.signal });
      const body = await response.json().catch(() => ({})) as any;
      if (!response.ok || !body.secure_url || !body.public_id) throw new AppError(502, 'MEDIA_UPLOAD_FAILED', 'Image upload failed. Please try again.');
      return { publicId: String(body.public_id), secureUrl: String(body.secure_url), originalFilename: input.originalFilename || String(body.original_filename || publicId), mimeType: detected.mimeType, format: detected.format, width: Number(body.width || 0) || undefined, height: Number(body.height || 0) || undefined, bytes: Number(body.bytes || buffer.length), folder, altText: input.altText?.trim() || undefined };
    } catch (error) { if (error instanceof AppError) throw error; throw new AppError(502, 'MEDIA_UPLOAD_FAILED', 'Image upload failed. Please try again.'); }
    finally { clearTimeout(timer); }
  }
  async delete(publicId: string) {
    this.assertConfigured();
    const timestamp = String(Math.floor(Date.now() / 1000)); const params = { public_id: publicId, timestamp }; const form = new URLSearchParams({ public_id: publicId, timestamp, api_key: config.cloudinaryApiKey, signature: signature(params) }); const { controller, timer } = timeoutSignal();
    try { const response = await fetch(`${cloudinaryBase()}/image/destroy`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form, signal: controller.signal }); const body = await response.json().catch(() => ({})) as any; if (!response.ok || !['ok','not found'].includes(String(body.result))) throw new AppError(502, 'MEDIA_DELETE_FAILED', 'Image removal failed. Please try again.'); return body; } catch (error) { if (error instanceof AppError) throw error; throw new AppError(502, 'MEDIA_DELETE_FAILED', 'Image removal failed. Please try again.'); } finally { clearTimeout(timer); }
  }
}
