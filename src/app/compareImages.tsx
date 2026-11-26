import React from 'react';
import { ArrowLeftRight, GitCompareArrows } from 'lucide-react';
import type { Extension, ExtensionContext } from './extensions';
import { mediaUrl } from './mediaUrl';
import { UpscaleCompare } from './UpscaleCompare';
import type { GalleryItem } from './types';
import { SafeImg } from './SafeImg';

/*
 * Compare two pictures from the gallery. One action, Compare: the first time it
 * picks the picture as A; on another picture it opens A beside it, split by a
 * line or side by side. Not for Hidden pictures, which never leave Hidden.
 */

type Pair = { a: GalleryItem | null; b: GalleryItem | null };
let pair: Pair = { a: null, b: null };
const listeners = new Set<() => void>();
function setPair(next: Pair) {
  pair = next;
  for (const listener of listeners) listener();
}
function usePair() {
  return React.useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => pair);
}

const comparable = (item: GalleryItem) => item.status === 'done' && item.type === 'image' && Boolean(item.url) && !item.privateVault && !item.vaultLocked;
const name = (item: GalleryItem) => (item.prompt || item.outputName || 'Picture').slice(0, 48);

function ComparePanel() {
  const { a, b } = usePair();
  const [mode, setMode] = React.useState<'split' | 'side'>('split');
  if (!a || !b) return null;
  const src = (item: GalleryItem) => mediaUrl(item.url, item);
  return (
    <div className="compare-panel">
      <div className="compare-panel-bar">
        {/* Settings' Segmented markup, kept here so this file doesn't pull in the Settings dialog. */}
        <div className="segmented" role="radiogroup" aria-label="Compare as">
          {([['split', 'Split'], ['side', 'Side by side']] as const).map(([value, label]) => (
            <button key={value} type="button" role="radio" aria-checked={mode === value} className={mode === value ? 'active' : undefined} onClick={() => setMode(value)}>{label}</button>
          ))}
        </div>
        <button type="button" className="btn is-ghost" onClick={() => setPair({ a: b, b: a })}><ArrowLeftRight size={14} /> Swap</button>
      </div>
      {mode === 'split' ? (
        <div className="compare-panel-stage">
          <UpscaleCompare item={b} zoomed={false} pair={{ before: { src: src(a), label: 'A' }, after: { src: src(b), label: 'B' } }} />
        </div>
      ) : (
        <div className="compare-panel-side">
          {[['A', a], ['B', b]].map(([label, item]) => (
            <figure key={label as string}>
              <SafeImg src={src(item as GalleryItem)} alt={`${label}: ${name(item as GalleryItem)}`} draggable={false} fallback={<span>This picture is gone.</span>} />
              <figcaption><b>{label as string}</b> {name(item as GalleryItem)}</figcaption>
            </figure>
          ))}
        </div>
      )}
    </div>
  );
}

const compare = {
  id: 'compare',
  label: 'Compare',
  icon: GitCompareArrows,
  when: (item: GalleryItem) => comparable(item),
  run: (item: GalleryItem, context: ExtensionContext) => {
    const { a } = pair;
    if (!a || a.id === item.id) {
      setPair({ a: item, b: null });
      context.showToast('Picked as A. Choose Compare on another picture.', 'default');
      return;
    }
    setPair({ a, b: item });
    context.openPanel('compare');
  }
};

export const compareImages: Extension = {
  id: 'compare',
  name: 'Compare',
  viewer: [compare],
  panels: [{ id: 'compare', title: 'Compare', description: 'A on the left, B on the right. Drag the line or use the arrow keys.', size: 'wide', render: () => <ComparePanel /> }],
  settings: { description: 'A Compare button in the viewer: pick one picture as A, then compare another with it.' }
};
