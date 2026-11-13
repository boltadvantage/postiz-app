// uploads aren't exercised here, and the storage code pulls in an ESM-only package
jest.mock('@gitroom/nestjs-libraries/upload/upload.factory', () => ({ UploadFactory: {} }));

import sharp from 'sharp';
import { instagramSize, padForInstagram } from './instagram.fit';

const image = (width: number, height: number, format: 'png' | 'jpeg' = 'png') =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } } })[format]().toBuffer();

describe('Instagram image fit', () => {
  it('knows which shapes Instagram takes', () => {
    expect(instagramSize(1080, 1080)).toBeNull();
    expect(instagramSize(1080, 1350)).toBeNull(); // 4:5
    expect(instagramSize(1910, 1000)).toBeNull(); // 1.91:1
    expect(instagramSize(1080, 1920)).toEqual({ width: 1536, height: 1920 }); // phone 9:16 → 4:5
    expect(instagramSize(3000, 1000)).toEqual({ width: 3000, height: 1571 }); // banner → 1.91:1
  });

  it('pads a tall image to 4:5 as a JPEG, keeping the whole picture', async () => {
    const out = await padForInstagram(await image(900, 1600));
    const meta = await sharp(out!).metadata();
    expect(meta.format).toBe('jpeg');
    expect([meta.width, meta.height]).toEqual([1280, 1600]);
    // the edges take the picture's own color
    const { data } = await sharp(out!).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(150);
  });

  it('pads a wide banner to 1.91:1 and leaves good shapes alone', async () => {
    const out = await padForInstagram(await image(2000, 500, 'jpeg'));
    const meta = await sharp(out!).metadata();
    expect(meta.width).toBe(2000);
    expect(meta.height).toBe(1048);
    expect(await padForInstagram(await image(1080, 1080))).toBeNull();
  });
});
