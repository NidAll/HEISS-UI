import { Modal } from './Modal';
import { Sheet } from './PhoneStudio';
import { mediaUrl } from './mediaUrl';
import type { GalleryItem } from './types';
import { SafeImg } from './SafeImg';

/**
 * Copy image where the browser can't write pictures to the clipboard: on a
 * phone reaching HEISS UI over plain HTTP. The picture is shown on its own, so
 * the system's press-and-hold menu can copy it.
 */
export function ManualCopy({ item, phone, onClose }: { item: GalleryItem | null; phone: boolean; onClose: () => void }) {
  const body = item ? (
    <div className="manual-copy">
      <SafeImg src={mediaUrl(item.url, item)} alt={item.prompt || 'Picture'} fallback={<span>This picture is gone.</span>} />
      <p>{phone ? 'Press and hold the picture, then choose Copy.' : 'Right-click the picture, then choose Copy image.'} This browser only lets HEISS UI copy pictures over HTTPS.</p>
    </div>
  ) : null;
  return phone
    ? <Sheet open={Boolean(item)} onClose={onClose} title="Copy image">{body}</Sheet>
    : <Modal open={Boolean(item)} onOpenChange={(next) => { if (!next) onClose(); }} title="Copy image" size="form">{body}</Modal>;
}
