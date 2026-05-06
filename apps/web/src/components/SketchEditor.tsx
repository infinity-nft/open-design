import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { Icon } from './Icon';

export type Tool = 'select' | 'pen' | 'text' | 'rect' | 'arrow' | 'eraser' | 'hand';

interface Stroke {
  kind: 'pen';
  points: Array<{ x: number; y: number }>;
  color: string;
  size: number;
  // When true, the stroke removes pixels from the canvas instead of
  // adding them. Used by the eraser tool. The renderer flips
  // globalCompositeOperation to 'destination-out' before drawing the
  // path so the underlying preview iframe (overlay mode) shows through.
  erase?: boolean;
}
interface RectShape {
  kind: 'rect';
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  size: number;
}
interface ArrowShape {
  kind: 'arrow';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  size: number;
}
interface TextItem {
  kind: 'text';
  x: number;
  y: number;
  text: string;
  color: string;
  size: number;
}

export type SketchItem = Stroke | RectShape | ArrowShape | TextItem;

export interface SketchDocument {
  version: 1;
  items: SketchItem[];
}

interface Props {
  // Controlled items — the parent owns the strokes so switching to a different
  // tab and back doesn't lose the in-progress sketch. The editor only reports
  // changes via onItemsChange.
  items: SketchItem[];
  onItemsChange: (items: SketchItem[]) => void;
  onSave: () => Promise<void> | void;
  onCancel?: () => void;
  saving?: boolean;
  dirty?: boolean;
  fileName: string;
  // When true, renders as a transparent overlay on top of existing content
  // (no grid background, absolute-positioned canvas).
  overlay?: boolean;
  // Expose the canvas element to the parent (for PNG capture in overlay mode).
  canvasRef?: React.MutableRefObject<HTMLCanvasElement | null>;
  // Called when the hand tool drags or scrolls — parent decides what to scroll.
  onHandPan?: (dx: number, dy: number) => void;
  // Slot for parent-supplied controls rendered inside the toolbar (between
  // the drawing tools and the undo/clear/save block). Used by ProjectView
  // to host the zoom controls in the same toolbar.
  toolbarExtras?: React.ReactNode;
  // Slot rendered immediately after the hand tool — for navigation-y
  // toggles like Interact that sit visually next to "move/pan".
  toolbarLeft?: React.ReactNode;
}

export function SketchEditor({
  items,
  onItemsChange,
  onSave,
  onCancel,
  saving = false,
  dirty = false,
  fileName,
  overlay = false,
  canvasRef: externalCanvasRef,
  onHandPan,
  toolbarExtras,
  toolbarLeft,
}: Props) {
  const t = useT();
  const internalCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasRef = externalCanvasRef ?? internalCanvasRef;
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState('#ef4444');
  const [size, setSize] = useState(2);
  const drawingRef = useRef<SketchItem | null>(null);
  const handDragging = useRef(false);
  const [, force] = useState(0);
  // Text-tool modal. Replaces window.prompt() because Electron 28+
  // disables that API by default and silently returns null, making
  // the text tool a no-op in the desktop app. Same root cause as
  // issue #723 (FileViewer's Save-as-template flow).
  const [textModalOpen, setTextModalOpen] = useState(false);
  const [textModalValue, setTextModalValue] = useState('');
  const textAnchorRef = useRef<{ x: number; y: number } | null>(null);
  // Future stack for redo. Cleared on any non-undo mutation. Mirrors the
  // industry pattern (Figma / Excalidraw): undo pushes to future, redo
  // pops from future, drawing/erasing wipes future.
  const [redoStack, setRedoStack] = useState<SketchItem[]>([]);

  // Industry-standard color presets — 5 strong colors for quick selection.
  // Same set Figma / Excalidraw use for annotation: red is default, plus
  // blue/green/yellow for variety, plus black for outlines.
  const PRESETS = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#0f172a'];

  // Resize canvas to its container while keeping a high DPR for crisp lines.
  useEffect(() => {
    const wrap = wrapRef.current;
    const cvs = canvasRef.current;
    if (!wrap || !cvs) return;
    const dpr = window.devicePixelRatio || 1;
    const ro = new ResizeObserver(() => {
      const rect = wrap.getBoundingClientRect();
      cvs.width = Math.max(1, Math.round(rect.width * dpr));
      cvs.height = Math.max(1, Math.round(rect.height * dpr));
      cvs.style.width = `${rect.width}px`;
      cvs.style.height = `${rect.height}px`;
      const ctx = cvs.getContext('2d');
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      redraw();
    });
    ro.observe(wrap);
    return () => ro.disconnect();
    // redraw is closure-fresh each render via the items dep below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const redraw = useCallback(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    if (!ctx) return;
    const w = cvs.clientWidth;
    const h = cvs.clientHeight;
    ctx.clearRect(0, 0, w, h);
    if (!overlay) drawGrid(ctx, w, h);
    const all = drawingRef.current ? [...items, drawingRef.current] : items;
    for (const it of all) drawItem(ctx, it);
  }, [items, overlay]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  function pointerPos(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (tool === 'select') return;
    const cvs = canvasRef.current;
    if (!cvs) return;
    cvs.setPointerCapture(e.pointerId);
    if (tool === 'hand') {
      handDragging.current = true;
      return;
    }
    const pos = pointerPos(e);

    if (tool === 'text') {
      // Stash the click position and open the modal. The actual TextItem is
      // appended in submitTextModal, once the user confirms.
      textAnchorRef.current = pos;
      setTextModalValue('');
      setTextModalOpen(true);
      return;
    }

    if (tool === 'pen' || tool === 'eraser') {
      drawingRef.current = {
        kind: 'pen',
        points: [pos],
        color,
        size: tool === 'eraser' ? size * 6 : size,
        erase: tool === 'eraser',
      };
    } else if (tool === 'rect') {
      drawingRef.current = { kind: 'rect', x: pos.x, y: pos.y, w: 0, h: 0, color, size };
    } else if (tool === 'arrow') {
      drawingRef.current = {
        kind: 'arrow',
        x1: pos.x,
        y1: pos.y,
        x2: pos.x,
        y2: pos.y,
        color,
        size,
      };
    }
    force((n) => n + 1);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (tool === 'hand') {
      if (handDragging.current) {
        onHandPan?.(e.movementX, e.movementY);
      }
      return;
    }
    const cur = drawingRef.current;
    if (!cur) return;
    const pos = pointerPos(e);
    if (cur.kind === 'pen') {
      cur.points.push(pos);
    } else if (cur.kind === 'rect') {
      cur.w = pos.x - cur.x;
      cur.h = pos.y - cur.y;
    } else if (cur.kind === 'arrow') {
      cur.x2 = pos.x;
      cur.y2 = pos.y;
    }
    redraw();
  }

  function handlePointerUp() {
    if (tool === 'hand') {
      handDragging.current = false;
      return;
    }
    const cur = drawingRef.current;
    drawingRef.current = null;
    if (!cur) return;
    onItemsChange([...items, cur]);
    setRedoStack([]); // any new draw invalidates the redo branch
  }

  function handleUndo() {
    if (items.length === 0) return;
    const last = items[items.length - 1];
    if (last) setRedoStack((s) => [...s, last]);
    onItemsChange(items.slice(0, -1));
  }
  function handleRedo() {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    if (!next) return;
    setRedoStack((s) => s.slice(0, -1));
    onItemsChange([...items, next]);
  }
  function handleClear() {
    if (items.length > 0) setRedoStack(items.slice().reverse());
    onItemsChange([]);
  }

  function submitTextModal() {
    const text = textModalValue.trim();
    const anchor = textAnchorRef.current;
    if (!text || !anchor) {
      cancelTextModal();
      return;
    }
    onItemsChange([
      ...items,
      { kind: 'text', x: anchor.x, y: anchor.y, text, color, size: 16 + size * 4 },
    ]);
    setTextModalOpen(false);
    setTextModalValue('');
    textAnchorRef.current = null;
  }

  function cancelTextModal() {
    setTextModalOpen(false);
    setTextModalValue('');
    textAnchorRef.current = null;
  }

  // Tool & history keyboard shortcuts. Match the Figma / Excalidraw
  // convention: H hand, V/P pen, T text, R rect, A arrow, E eraser,
  // ⌘Z undo, ⌘⇧Z redo. Skip when the user is typing in an input
  // (color picker, range, future text fields) so we never steal keys.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          target.isContentEditable
        ) return;
      }
      const meta = e.metaKey || e.ctrlKey;
      if (meta && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) handleRedo(); else handleUndo();
        return;
      }
      if (meta) return;
      const k = e.key.toLowerCase();
      if (k === 'h') setTool('hand');
      else if (k === 'p' || k === 'v') setTool('pen');
      else if (k === 't') setTool('text');
      else if (k === 'r') setTool('rect');
      else if (k === 'a') setTool('arrow');
      else if (k === 'e') setTool('eraser');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, redoStack]);

  return (
    <div className={`sketch-editor${overlay ? ' sketch-overlay' : ''}`} data-tool={tool}>
      <div className="sketch-toolbar">
        <ToolBtn cur={tool} v="hand" onClick={setTool} title="Hand" shortcut="H" icon="hand" />
        {toolbarLeft}
        <span className="sketch-divider" />
        <ToolBtn cur={tool} v="pen" onClick={setTool} title={t('sketch.toolPen')} shortcut="P" icon="pencil" />
        <ToolBtn cur={tool} v="text" onClick={setTool} title={t('sketch.toolText')} shortcut="T" icon="text-tool" />
        <ToolBtn cur={tool} v="rect" onClick={setTool} title={t('sketch.toolRect')} shortcut="R" icon="rectangle" />
        <ToolBtn cur={tool} v="arrow" onClick={setTool} title={t('sketch.toolArrow')} shortcut="A" icon="arrow-tool" />
        <ToolBtn cur={tool} v="eraser" onClick={setTool} title={t('sketch.toolEraser')} shortcut="E" icon="eraser" />
        <span className="sketch-divider" />
        <div className="sketch-presets" role="group" aria-label="Color presets">
          {PRESETS.map((c) => (
            <button
              key={c}
              type="button"
              className={`sketch-preset${color.toLowerCase() === c.toLowerCase() ? ' active' : ''}`}
              style={{ background: c }}
              onClick={() => setColor(c)}
              title={c}
              aria-label={`Color ${c}`}
            />
          ))}
        </div>
        <input
          type="color"
          className="sketch-color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          title={t('sketch.color')}
        />
        <input
          type="range"
          min={1}
          max={8}
          value={size}
          onChange={(e) => setSize(Number(e.target.value))}
          title={t('sketch.strokeSize')}
          className="sketch-size"
        />
        {toolbarExtras ? (
          <>
            <span className="sketch-divider" />
            {toolbarExtras}
          </>
        ) : null}
        <span className="sketch-divider" />
        <button
          type="button"
          className="sketch-tool"
          onClick={handleUndo}
          disabled={items.length === 0}
          title="Undo (⌘Z)"
          aria-label="Undo"
        >
          <Icon name="arrow-left" size={14} />
        </button>
        <button
          type="button"
          className="sketch-tool"
          onClick={handleRedo}
          disabled={redoStack.length === 0}
          title="Redo (⌘⇧Z)"
          aria-label="Redo"
        >
          {/* Mirror of arrow-left to read as "redo" without adding a new icon. */}
          <span style={{ display: 'inline-flex', transform: 'scaleX(-1)' }}>
            <Icon name="arrow-left" size={14} />
          </span>
        </button>
        <button
          type="button"
          className="sketch-tool"
          onClick={handleClear}
          disabled={items.length === 0}
          title="Clear all"
          aria-label="Clear all"
        >
          <Icon name="close" size={14} />
        </button>
        <span className="sketch-spacer" />
        <span className="sketch-name" title={fileName}>
          {fileName}
          {dirty ? ' •' : ''}
        </span>
        {onCancel ? (
          <button className="ghost" onClick={onCancel}>
            {t('sketch.close')}
          </button>
        ) : null}
        <button
          className="primary"
          onClick={() => void onSave()}
          disabled={saving || items.length === 0}
        >
          {saving ? t('sketch.saving') : t('common.save')}
        </button>
      </div>
      <div
        className="sketch-canvas-wrap"
        ref={wrapRef}
        onWheel={tool === 'hand' ? (e) => {
          e.preventDefault();
          onHandPan?.(e.deltaX, e.deltaY);
        } : undefined}
      >
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          style={{ touchAction: 'none', cursor: tool === 'hand' ? 'grab' : undefined }}
        />
      </div>
      {textModalOpen ? (
        <div className="modal-backdrop" role="presentation">
          <div className="modal" role="dialog" aria-modal="true">
            <div className="modal-head">
              <h2>{t('sketch.textModalTitle')}</h2>
            </div>
            <label>
              <span>{t('sketch.textPrompt')}</span>
              <input
                type="text"
                value={textModalValue}
                autoFocus
                onChange={(e) => setTextModalValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && textModalValue.trim()) {
                    e.preventDefault();
                    submitTextModal();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelTextModal();
                  }
                }}
              />
            </label>
            <div className="modal-foot">
              <button type="button" className="ghost" onClick={cancelTextModal}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="primary"
                disabled={!textModalValue.trim()}
                onClick={submitTextModal}
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ToolBtn({
  cur,
  v,
  onClick,
  icon,
  title,
  shortcut,
}: {
  cur: Tool;
  v: Tool;
  onClick: (v: Tool) => void;
  icon: React.ComponentProps<typeof Icon>['name'];
  title: string;
  shortcut?: string;
}) {
  const fullTitle = shortcut ? `${title} (${shortcut})` : title;
  return (
    <button
      className={`sketch-tool ${cur === v ? 'active' : ''}`}
      onClick={() => onClick(v)}
      title={fullTitle}
      aria-label={fullTitle}
      aria-keyshortcuts={shortcut?.toLowerCase()}
    >
      <Icon name={icon} size={14} />
    </button>
  );
}

function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.save();
  ctx.fillStyle = '#bfbcb6';
  for (let y = 12; y < h; y += 16) {
    for (let x = 12; x < w; x += 16) {
      ctx.fillRect(x, y, 1, 1);
    }
  }
  ctx.restore();
}

function drawItem(ctx: CanvasRenderingContext2D, it: SketchItem) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = it.color;
  ctx.fillStyle = it.color;
  ctx.lineWidth = it.size;
  if (it.kind === 'pen') {
    if (it.points.length < 2) return ctx.restore();
    if (it.erase) {
      ctx.globalCompositeOperation = 'destination-out';
    }
    ctx.beginPath();
    ctx.moveTo(it.points[0]!.x, it.points[0]!.y);
    for (let i = 1; i < it.points.length; i++) {
      ctx.lineTo(it.points[i]!.x, it.points[i]!.y);
    }
    ctx.stroke();
  } else if (it.kind === 'rect') {
    ctx.strokeRect(it.x, it.y, it.w, it.h);
  } else if (it.kind === 'arrow') {
    ctx.beginPath();
    ctx.moveTo(it.x1, it.y1);
    ctx.lineTo(it.x2, it.y2);
    ctx.stroke();
    const ang = Math.atan2(it.y2 - it.y1, it.x2 - it.x1);
    const len = 10 + it.size * 2;
    ctx.beginPath();
    ctx.moveTo(it.x2, it.y2);
    ctx.lineTo(it.x2 - len * Math.cos(ang - Math.PI / 6), it.y2 - len * Math.sin(ang - Math.PI / 6));
    ctx.moveTo(it.x2, it.y2);
    ctx.lineTo(it.x2 - len * Math.cos(ang + Math.PI / 6), it.y2 - len * Math.sin(ang + Math.PI / 6));
    ctx.stroke();
  } else if (it.kind === 'text') {
    ctx.font = `${it.size}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    ctx.fillText(it.text, it.x, it.y);
  }
  ctx.restore();
}
