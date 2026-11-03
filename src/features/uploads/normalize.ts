import 'server-only'

import { createHash } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import sharp, { type SharpOptions } from 'sharp'
import { IMAGE_RULES, IMAGE_UPLOAD_LIMITS, type ImageInputType, type ImageKind } from './contracts'
import { ImageUploadError } from './errors'
import type { NormalizedImage } from './types'

const invalid = () => new ImageUploadError(
  415, 'invalid_raster', 'Choose a complete, static PNG, JPEG or WebP image within the pixel and metadata limits.',
)

/** Bound compressed ancillary metadata before libvips/libpng can inflate it. */
function pngInflatedMetadata(type: string, payload: Buffer, remaining: number): number {
  if (!['iCCP', 'zTXt', 'iTXt'].includes(type)) return 0
  const keywordEnd = payload.indexOf(0)
  if (keywordEnd < 1 || keywordEnd > 79 || keywordEnd + 2 >= payload.length) throw invalid()
  let textStart = keywordEnd + 2
  if (type === 'iTXt') {
    const compressed = payload[keywordEnd + 1]
    if ((compressed !== 0 && compressed !== 1) || payload[keywordEnd + 2] !== 0) throw invalid()
    const languageEnd = payload.indexOf(0, keywordEnd + 3)
    const translatedEnd = languageEnd < 0 ? -1 : payload.indexOf(0, languageEnd + 1)
    if (translatedEnd < 0) throw invalid()
    if (compressed === 0) return 0 // Uncompressed bytes are already charged.
    textStart = translatedEnd + 1
  } else if (payload[keywordEnd + 1] !== 0) throw invalid()
  if (remaining < 1 || textStart >= payload.length) throw invalid()
  try {
    return inflateSync(payload.subarray(textStart), { maxOutputLength: remaining }).length
  } catch { throw invalid() }
}

/** Walk scans/markers: a second EOI must not hide trailing HTML or another JPEG. */
function completeJpeg(data: Buffer): void {
  let offset = 2
  let sawScan = false
  let metadataBytes = 0
  while (offset < data.length) {
    if (data[offset++] !== 0xff) throw invalid()
    while (data[offset] === 0xff) offset += 1
    if (offset >= data.length) throw invalid()
    const marker = data[offset++]
    if (marker === 0xd9) {
      if (!sawScan || offset !== data.length) throw invalid()
      return
    }
    if (marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) throw invalid()
    if (marker === 0x01) continue // TEM is the other standalone marker.
    if (offset + 2 > data.length) throw invalid()
    const length = data.readUInt16BE(offset)
    if (length < 2 || offset + length > data.length) throw invalid()
    if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) {
      metadataBytes += length - 2
      if (metadataBytes > IMAGE_UPLOAD_LIMITS.sourceMetadataBytes) throw invalid()
    }
    offset += length
    if (marker !== 0xda) continue
    sawScan = true
    while (offset < data.length) {
      const start = offset
      if (data[offset++] !== 0xff) continue
      while (data[offset] === 0xff) offset += 1
      if (offset >= data.length) throw invalid()
      const next = data[offset]
      if (next === 0 || (next >= 0xd0 && next <= 0xd7)) { offset += 1; continue }
      offset = start // Next structural marker, including another progressive scan.
      break
    }
  }
  throw invalid()
}

/** Reject non-rasters before libvips can invoke an SVG/PDF/other format loader. */
function rasterType(data: Buffer): ImageInputType {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    let offset = 8
    let ended = false
    let metadataBytes = 0
    while (offset + 12 <= data.length) {
      const length = data.readUInt32BE(offset)
      const next = offset + 12 + length
      if (next > data.length) throw invalid()
      const type = data.toString('ascii', offset + 4, offset + 8)
      if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') throw invalid()
      if (type !== 'IDAT') {
        metadataBytes += length
        if (metadataBytes > IMAGE_UPLOAD_LIMITS.sourceMetadataBytes) throw invalid()
        metadataBytes += pngInflatedMetadata(type, data.subarray(offset + 8, next - 4),
          IMAGE_UPLOAD_LIMITS.sourceMetadataBytes - metadataBytes)
      }
      offset = next
      if (type === 'IEND') { ended = true; break }
    }
    if (!ended || offset !== data.length) throw invalid()
    return 'image/png'
  }
  if (data.length >= 4 && data[0] === 255 && data[1] === 216 && data[2] === 255) {
    completeJpeg(data)
    return 'image/jpeg'
  }
  if (data.length >= 20 && data.toString('ascii', 0, 4) === 'RIFF' &&
      data.toString('ascii', 8, 12) === 'WEBP' && data.readUInt32LE(4) + 8 === data.length) {
    let offset = 12
    let metadataBytes = 0
    while (offset + 8 <= data.length) {
      const type = data.toString('ascii', offset, offset + 4)
      const length = data.readUInt32LE(offset + 4)
      const next = offset + 8 + length + (length % 2)
      if (next > data.length || type === 'ANIM' || type === 'ANMF' ||
          (type === 'VP8X' && length > 0 && (data[offset + 8] & 2) !== 0)) throw invalid()
      if (['ICCP', 'EXIF', 'XMP '].includes(type)) {
        metadataBytes += length
        if (metadataBytes > IMAGE_UPLOAD_LIMITS.sourceMetadataBytes) throw invalid()
      }
      offset = next
    }
    if (offset !== data.length) throw invalid()
    return 'image/webp'
  }
  throw invalid()
}

// Process-wide across separately imported adapters/HMR. Database/file reservations
// additionally bound in-flight uploads across workers; this is not a fleet limiter.
const gateKey = Symbol.for('bulla.private-image-decode-gate')
const globals = globalThis as typeof globalThis & { [gateKey]?: { active: number } }
const gate = globals[gateKey] ??= { active: 0 }

export async function normalizeImage(
  data: Buffer, kind: ImageKind, inputType: ImageInputType,
): Promise<NormalizedImage> {
  if (!data.length || data.length > IMAGE_UPLOAD_LIMITS.inputBytes) {
    throw new ImageUploadError(413, 'image_too_large', 'Images must be 5 MiB or smaller.')
  }
  if (rasterType(data) !== inputType) throw invalid()
  if (gate.active >= IMAGE_UPLOAD_LIMITS.decodeConcurrency) {
    throw new ImageUploadError(429, 'image_processor_busy', 'The image processor is busy. Try again shortly.', 5)
  }
  gate.active += 1
  const options: SharpOptions = {
    failOn: 'warning',
    limitInputPixels: IMAGE_UPLOAD_LIMITS.sourcePixels,
    unlimited: false,
    sequentialRead: true,
    pages: 1,
  }
  try {
    const metadata = await sharp(data, options).metadata()
    const width = metadata.width ?? 0
    const height = metadata.height ?? 0
    if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '') ||
        (metadata.pages ?? 1) !== 1 || width < 1 || height < 1 ||
        width > IMAGE_UPLOAD_LIMITS.sourceDimension || height > IMAGE_UPLOAD_LIMITS.sourceDimension ||
        width * height > IMAGE_UPLOAD_LIMITS.sourcePixels) throw invalid()

    const rules = IMAGE_RULES[kind]
    // Default sharp output strips EXIF/XMP/ICC/etc. Do not add keepMetadata or
    // withMetadata here. There are no caller-supplied encoder/resize options.
    const output = await sharp(data, options)
      .timeout({ seconds: IMAGE_UPLOAD_LIMITS.encodeTimeoutSeconds })
      .autoOrient()
      .toColourspace('srgb')
      .resize({ width: rules.width, height: rules.height, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, effort: 4, smartSubsample: false })
      .toBuffer({ resolveWithObject: true })
    if (output.info.width < 1 || output.info.height < 1 ||
        output.info.width > rules.width || output.info.height > rules.height ||
        output.data.length > rules.outputBytes) throw invalid()
    return {
      data: output.data, width: output.info.width, height: output.info.height,
      bytes: output.data.length, contentType: 'image/webp',
      sha256: createHash('sha256').update(output.data).digest('hex'),
    }
  } catch (error) {
    if (error instanceof ImageUploadError) throw error
    throw invalid()
  } finally {
    gate.active -= 1
  }
}
