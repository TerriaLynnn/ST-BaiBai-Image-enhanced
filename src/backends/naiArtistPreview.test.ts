import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_NAI_ARTISTS } from '@/backends/nai';
import { artistPreviewSrc, saveArtistPreview, uploadingArtistPreview } from './naiArtistPreview';
import { settings, type NaiArtistPreset } from '@/state/settings';
import { makeJpegThumbnail } from '@/st/imageFile';
import { ARTIST_PREVIEW_FOLDER, deleteUserImage, uploadUserImage } from '@/st/images';

vi.mock('@/state/settings', () => ({
  settings: { nai: { artistPresets: [], builtinArtistPreviews: {}, activeArtistId: '' } },
}));
vi.mock('@/st/imageFile', () => ({ makeJpegThumbnail: vi.fn() }));
vi.mock('@/st/images', () => ({
  ARTIST_PREVIEW_FOLDER: 'artist-previews',
  uploadUserImage: vi.fn(),
  deleteUserImage: vi.fn(),
}));

let artist: NaiArtistPreset;
beforeEach(() => {
  vi.resetAllMocks();
  artist = { id: 'art_a', name: 'A', prompt: 'artist:a', quality: '', negative: '', previewPath: '/old.jpg' };
  settings.nai.artistPresets = [artist];
  settings.nai.builtinArtistPreviews = {};
  vi.mocked(makeJpegThumbnail).mockResolvedValue('data:image/jpeg;base64,thumbnail');
  vi.mocked(uploadUserImage).mockResolvedValue('/cover.jpg');
  vi.mocked(deleteUserImage).mockResolvedValue(true);
});

describe('artist covers', () => {
  it('stores an independent thumbnail and refreshes the same preview URL on replacement', async () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValueOnce(200);
    await saveArtistPreview(artist, '/generated.png');
    expect(makeJpegThumbnail).toHaveBeenCalledWith('/generated.png', 512, 0.85);
    expect(uploadUserImage).toHaveBeenCalledWith(ARTIST_PREVIEW_FOLDER, 'art_a', 'thumbnail', 'jpg');
    expect(artist.previewPath).toBe('/cover.jpg');
    expect(artistPreviewSrc(artist)).toBe('/cover.jpg?v=100');
    await saveArtistPreview(artist, '/next.png');
    expect(artistPreviewSrc(artist)).toBe('/cover.jpg?v=200');
    expect(deleteUserImage).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('saves a builtin cover without modifying its recipe or switching artists', async () => {
    const builtin = BUILTIN_NAI_ARTISTS[0];
    const original = { ...builtin };
    settings.nai.activeArtistId = builtin.id;
    await saveArtistPreview(builtin, '/generated.png');
    expect(settings.nai.builtinArtistPreviews?.[builtin.id]).toBe('/cover.jpg');
    expect(artistPreviewSrc(builtin)).toMatch(/^\/cover.jpg\?v=/);
    expect(builtin).toEqual(original);
    expect(settings.nai.artistPresets).toEqual([artist]);
    expect(settings.nai.activeArtistId).toBe(builtin.id);
  });

  it('keeps the previous cover and clears busy state on upload failure', async () => {
    vi.mocked(uploadUserImage).mockRejectedValue(new Error('upload failed'));
    await expect(saveArtistPreview(artist, '/generated.png')).rejects.toThrow('upload failed');
    expect(artist.previewPath).toBe('/old.jpg');
    expect(uploadingArtistPreview.value.size).toBe(0);
  });

  it('pins the clicked artist and rejects duplicate saves while a thumbnail is loading', async () => {
    let finish!: (value: string) => void;
    vi.mocked(makeJpegThumbnail).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const saving = saveArtistPreview(artist, '/generated.png');
    await expect(saveArtistPreview(artist, '/other.png')).rejects.toThrow('正在保存');
    settings.nai.activeArtistId = BUILTIN_NAI_ARTISTS[0].id;
    finish('data:image/jpeg;base64,thumbnail');
    await saving;
    expect(artist.previewPath).toBe('/cover.jpg');
    expect(settings.nai.builtinArtistPreviews).toEqual({});
  });

  it('does not upload a cover for an artist deleted during thumbnail creation', async () => {
    vi.mocked(makeJpegThumbnail).mockImplementation(async () => {
      settings.nai.artistPresets = [];
      return 'data:image/jpeg;base64,thumbnail';
    });
    await expect(saveArtistPreview(artist, '/generated.png')).rejects.toThrow('已被删除');
    expect(uploadUserImage).not.toHaveBeenCalled();
    expect(uploadingArtistPreview.value.size).toBe(0);
  });

  it('cleans up the uploaded cover if its artist was deleted during upload', async () => {
    vi.mocked(uploadUserImage).mockImplementation(async () => {
      settings.nai.artistPresets = [];
      return '/cover.jpg';
    });
    await expect(saveArtistPreview(artist, '/generated.png')).rejects.toThrow('已被删除');
    expect(deleteUserImage).toHaveBeenCalledWith('/cover.jpg');
    expect(artist.previewPath).toBe('/old.jpg');
  });
});
