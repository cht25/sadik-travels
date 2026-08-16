import { v2 as cloudinary } from 'cloudinary';
import { config } from './config.js';
import { AppError, assert } from './errors.js';

const configured = Boolean(config.cloudinaryCloudName && config.cloudinaryApiKey && config.cloudinaryApiSecret);
if (configured) cloudinary.config({ cloud_name: config.cloudinaryCloudName, api_key: config.cloudinaryApiKey, api_secret: config.cloudinaryApiSecret, secure: true });

const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);
const dataUrlMatch = /^data:([^;,]+);base64,([a-z0-9+/=\s]+)$/i;

function validateDataUrl(dataUrl: string) {
  const match = dataUrlMatch.exec(dataUrl);
  assert(match, 400, 'INVALID_IMAGE', 'Upload a valid JPEG, PNG, WebP, or AVIF image');
  const mime = match[1].toLowerCase();
  assert(imageTypes.has(mime), 400, 'INVALID_IMAGE_TYPE', 'Only JPEG, PNG, WebP, and AVIF images are accepted');
  const bytes = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  assert(bytes.length > 0 && bytes.length <= config.maxUploadBytes, 400, 'IMAGE_TOO_LARGE', `Image must be smaller than ${Math.floor(config.maxUploadBytes / 1024 / 1024)} MB`);
  return { mime, bytes };
}

export async function uploadImage(dataUrl: string, fileName?: string) {
  validateDataUrl(dataUrl);
  if (!configured) throw new AppError(503, 'MEDIA_NOT_CONFIGURED', 'Image storage is not configured. Set Cloudinary credentials before uploading media.');
  try {
    const result = await cloudinary.uploader.upload(dataUrl, {
      folder: config.cloudinaryFolder,
      resource_type: 'image',
      allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'avif'],
      transformation: [{ quality: 'auto', fetch_format: 'auto' }],
      public_id: fileName?.replace(/[^a-z0-9_-]/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || undefined,
      overwrite: false,
      unique_filename: true
    });
    return { url: result.secure_url, publicId: result.public_id, width: result.width, height: result.height, bytes: result.bytes, format: result.format };
  } catch (error) {
    throw new AppError(502, 'MEDIA_UPLOAD_FAILED', 'Image storage could not accept this file');
  }
}

export async function deleteImage(publicId: string) {
  assert(configured, 503, 'MEDIA_NOT_CONFIGURED', 'Image storage is not configured');
  assert(publicId.startsWith(`${config.cloudinaryFolder}/`) || publicId === config.cloudinaryFolder, 400, 'INVALID_MEDIA_ID', 'The media item is outside the Sadik Travels storage folder');
  await cloudinary.uploader.destroy(publicId, { resource_type: 'image', invalidate: true });
}
