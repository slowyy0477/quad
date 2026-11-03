import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'

vi.mock('server-only', () => ({}))

import { normalizeImage } from '../../src/features/uploads/normalize'
import { IMAGE_RULES, IMAGE_UPLOAD_LIMITS, type ImageInputType } from '../../src/features/uploads/contracts'

const raster = () => sharp({ create: { width: 120, height: 80, channels: 4, background: '#567b4c' } })

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, payload: Buffer): Buffer {
  const chunk = Buffer.alloc(payload.length + 12)
  chunk.writeUInt32BE(payload.length)
  chunk.write(type, 4, 'ascii')
  payload.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4)
  return chunk
}

describe('bounded raster normalization (synthetic bytes only)', () => {
  it.each(['png', 'jpeg', 'webp'] as const)('decodes %s, strips metadata and emits only deterministic WebP', async format => {
    const input = await raster().toFormat(format).toBuffer()
    const mime = `image/${format}` as ImageInputType
    const first = await normalizeImage(input, 'avatar', mime)
    const second = await normalizeImage(input, 'avatar', mime)
    expect(first.data).toEqual(second.data)
    expect(first.sha256).toBe(createHash('sha256').update(first.data).digest('hex'))
    expect(first.bytes).toBe(first.data.length)
    const metadata = await sharp(first.data).metadata()
    expect(metadata.format).toBe('webp')
    expect(metadata.width).toBe(120)
    expect(metadata.height).toBe(80)
    expect(metadata.exif).toBeUndefined()
    expect(metadata.icc).toBeUndefined()
    expect(metadata.xmp).toBeUndefined()
    expect(first.bytes).toBeLessThanOrEqual(IMAGE_RULES.avatar.outputBytes)
  })

  it('applies orientation then removes EXIF/ICC and the synthetic metadata marker', async () => {
    const input = await raster().withExif({ IFD0: { ImageDescription: 'SYNTHETIC_IMAGE_METADATA_ONLY' } })
      .withMetadata({ orientation: 6 }).jpeg().toBuffer()
    expect(input.includes(Buffer.from('SYNTHETIC_IMAGE_METADATA_ONLY'))).toBe(true)
    const result = await normalizeImage(input, 'avatar', 'image/jpeg')
    const metadata = await sharp(result.data).metadata()
    expect([metadata.width, metadata.height]).toEqual([80, 120])
    expect(metadata.orientation).toBeUndefined()
    expect(metadata.exif).toBeUndefined()
    expect(metadata.icc).toBeUndefined()
    expect(result.data.includes(Buffer.from('SYNTHETIC_IMAGE_METADATA_ONLY'))).toBe(false)
  })

  it('bounds avatar and project output dimensions without enlarging small inputs', async () => {
    const large = await sharp({ create: { width: 1800, height: 1200, channels: 3, background: '#446655' } }).png().toBuffer()
    const avatar = await normalizeImage(large, 'avatar', 'image/png')
    const cover = await normalizeImage(large, 'project-cover', 'image/png')
    expect([avatar.width, avatar.height]).toEqual([512, 341])
    expect([cover.width, cover.height]).toEqual([1350, 900])
    expect(cover.bytes).toBeLessThanOrEqual(IMAGE_RULES['project-cover'].outputBytes)
  })

  it.each([
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    Buffer.from('<html><script>alert(1)</script></html>'),
    Buffer.from('GIF89a\x01\x00\x01\x00'),
    Buffer.from('%PDF-1.7 fake'),
    Buffer.from([0x49, 0x49, 0x2a, 0x00, 0, 0, 0, 0]),
  ])('rejects SVG/HTML/GIF/PDF/TIFF before a non-raster decoder can load it', async input => {
    await expect(normalizeImage(input, 'avatar', 'image/png')).rejects.toMatchObject({ status: 415, code: 'invalid_raster' })
  })

  it('rejects a MIME lie even when the bytes are a valid raster', async () => {
    await expect(normalizeImage(await raster().png().toBuffer(), 'avatar', 'image/jpeg'))
      .rejects.toMatchObject({ status: 415 })
  })

  it('rejects truncated PNG/JPEG/WebP and appended polyglot payloads', async () => {
    for (const format of ['png', 'jpeg', 'webp'] as const) {
      const input = await raster().toFormat(format).toBuffer()
      await expect(normalizeImage(input.subarray(0, input.length - 4), 'avatar', `image/${format}`))
        .rejects.toMatchObject({ status: 415 })
      await expect(normalizeImage(Buffer.concat([input, Buffer.from('<script>not-an-image</script>')]), 'avatar', `image/${format}`))
        .rejects.toMatchObject({ status: 415 })
    }
  })

  it('rejects JPEG suffixes hidden behind a second EOI or a concatenated image', async () => {
    const jpeg = await raster().jpeg().toBuffer()
    for (const tail of [
      Buffer.concat([Buffer.from('<html>SYNTHETIC_POLYGLOT</html>'), Buffer.from([0xff, 0xd9])]),
      jpeg,
    ]) {
      await expect(normalizeImage(Buffer.concat([jpeg, tail]), 'avatar', 'image/jpeg'))
        .rejects.toMatchObject({ status: 415 })
    }
  })

  it('accepts legitimate progressive scans while still stripping metadata', async () => {
    const jpeg = await raster().jpeg({ progressive: true }).toBuffer()
    await expect(normalizeImage(jpeg, 'avatar', 'image/jpeg')).resolves.toHaveProperty('contentType', 'image/webp')
  })

  it.each(['zTXt', 'iTXt', 'iCCP'])('bounds inflated PNG %s metadata independently of pixels and input bytes', async type => {
    const png = await raster().png().toBuffer()
    const compressed = deflateSync(Buffer.alloc(IMAGE_UPLOAD_LIMITS.sourceMetadataBytes + 1, 65))
    const prefix = type === 'iTXt'
      ? Buffer.concat([Buffer.from('Synthetic'), Buffer.from([0, 1, 0, 0, 0])])
      : Buffer.concat([Buffer.from('Synthetic'), Buffer.from([0, 0])])
    const input = Buffer.concat([png.subarray(0, 33), pngChunk(type, Buffer.concat([prefix, compressed])), png.subarray(33)])
    expect(input.length).toBeLessThan(4096)
    await expect(normalizeImage(input, 'avatar', 'image/png')).rejects.toMatchObject({ status: 415 })
  })

  it('accepts bounded compressed text but strips its synthetic marker from the output', async () => {
    const png = await raster().png().toBuffer()
    const text = Buffer.from('SYNTHETIC_COMPRESSED_TEXT_NOT_FOR_PUBLICATION')
    const chunk = pngChunk('zTXt', Buffer.concat([Buffer.from('Comment'), Buffer.from([0, 0]), deflateSync(text)]))
    const input = Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)])
    const result = await normalizeImage(input, 'avatar', 'image/png')
    expect(result.data.includes(text)).toBe(false)
    expect((await sharp(result.data).metadata()).format).toBe('webp')
  })

  it('bounds aggregate JPEG application metadata before decoder invocation', async () => {
    const jpeg = await raster().jpeg().toBuffer()
    const segment = Buffer.alloc(60_004, 65)
    segment[0] = 0xff
    segment[1] = 0xfe
    segment.writeUInt16BE(segment.length - 2, 2)
    const input = Buffer.concat([jpeg.subarray(0, 2), ...Array.from({ length: 5 }, () => segment), jpeg.subarray(2)])
    expect(input.length).toBeLessThan(IMAGE_UPLOAD_LIMITS.inputBytes)
    await expect(normalizeImage(input, 'avatar', 'image/jpeg')).rejects.toMatchObject({ status: 415 })
  })

  it('rejects APNG control chunks and WebP animation chunks', async () => {
    const png = await raster().png().toBuffer()
    const animatedPng = Buffer.concat([png.subarray(0, 33), pngChunk('acTL', Buffer.from([0, 0, 0, 2, 0, 0, 0, 0])), png.subarray(33)])
    await expect(normalizeImage(animatedPng, 'avatar', 'image/png')).rejects.toMatchObject({ status: 415 })
    const webp = await raster().webp().toBuffer()
    const animatedWebp = Buffer.concat([webp, Buffer.from('ANIM'), Buffer.from([6, 0, 0, 0, 0, 0, 0, 0, 0, 0])])
    animatedWebp.writeUInt32LE(animatedWebp.length - 8, 4)
    await expect(normalizeImage(animatedWebp, 'avatar', 'image/webp')).rejects.toMatchObject({ status: 415 })
  })

  it('rejects a dimension limit violation with very small compressed input', async () => {
    const input = await sharp({ create: { width: 8193, height: 1, channels: 3, background: '#333333' } }).png().toBuffer()
    expect(input.length).toBeLessThan(4096)
    await expect(normalizeImage(input, 'avatar', 'image/png')).rejects.toMatchObject({ status: 415 })
  })

  it('rejects a decompression-bomb header before allocating its claimed pixels', async () => {
    const input = await raster().png().toBuffer()
    input.writeUInt32BE(8192, 16)
    input.writeUInt32BE(8192, 20)
    input.writeUInt32BE(crc32(input.subarray(12, 29)), 29)
    expect(input.length).toBeLessThan(4096)
    await expect(normalizeImage(input, 'avatar', 'image/png')).rejects.toMatchObject({ status: 415 })
  })

  it('independently rejects input buffers above the byte limit', async () => {
    await expect(normalizeImage(Buffer.alloc(IMAGE_UPLOAD_LIMITS.inputBytes + 1), 'avatar', 'image/png'))
      .rejects.toMatchObject({ status: 413 })
  })

  it('bounds concurrent decoders and releases the gate after completion', async () => {
    const input = await raster().png().toBuffer()
    const results = await Promise.allSettled(Array.from({ length: 3 }, () => normalizeImage(input, 'avatar', 'image/png')))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2)
    const refused = results.find(result => result.status === 'rejected')
    expect(refused?.status === 'rejected' && refused.reason).toMatchObject({ status: 429, code: 'image_processor_busy' })
    await expect(normalizeImage(input, 'avatar', 'image/png')).resolves.toHaveProperty('contentType', 'image/webp')
  })
})
