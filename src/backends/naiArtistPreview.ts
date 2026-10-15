import { ref } from 'vue';
import { isBuiltinNaiArtist } from '@/backends/nai';
import { settings, type NaiArtistPreset } from '@/state/settings';
import { makeJpegThumbnail } from '@/st/imageFile';
import { ARTIST_PREVIEW_FOLDER, deleteUserImage, uploadUserImage } from '@/st/images';

// 管理器上传与楼层设置封面共用版本号,同名覆盖后立即更新所有已打开的卡片。
const versions = ref<ReadonlyMap<string, number>>(new Map());
export const uploadingArtistPreview = ref<ReadonlySet<string>>(new Set());

export function artistPreviewSrc(preset: NaiArtistPreset): string {
  const path = isBuiltinNaiArtist(preset.id)
    ? settings.nai.builtinArtistPreviews?.[preset.id] ?? preset.previewPath
    : preset.previewPath;
  if (!path) return '';
  const version = versions.value.get(preset.id);
  return version ? `${path}${path.includes('?') ? '&' : '?'}v=${version}` : path;
}

/** 独立保存缩略图,不与聊天原图共用文件生命周期。 */
export async function saveArtistPreview(preset: NaiArtistPreset, src: string): Promise<void> {
  const id = preset.id;
  if (uploadingArtistPreview.value.has(id)) throw new Error('该画师串封面正在保存中');
  const builtin = isBuiltinNaiArtist(id);
  const target = () => settings.nai.artistPresets.find(p => p.id === id);
  const ensureTarget = () => {
    if (!builtin && !target()) throw new Error('该画师串已被删除');
  };
  uploadingArtistPreview.value = new Set(uploadingArtistPreview.value).add(id);
  try {
    ensureTarget();
    const jpeg = await makeJpegThumbnail(src, 512, 0.85);
    ensureTarget();
    const path = await uploadUserImage(ARTIST_PREVIEW_FOLDER, id, jpeg.split(',')[1] ?? '', 'jpg');
    if (!builtin && !target()) {
      await deleteUserImage(path).catch(() => {});
      throw new Error('该画师串已被删除');
    }
    if (builtin) {
      settings.nai.builtinArtistPreviews = { ...settings.nai.builtinArtistPreviews, [id]: path };
    } else {
      target()!.previewPath = path;
    }
    versions.value = new Map(versions.value).set(id, Date.now());
  } finally {
    const next = new Set(uploadingArtistPreview.value);
    next.delete(id);
    uploadingArtistPreview.value = next;
  }
}
