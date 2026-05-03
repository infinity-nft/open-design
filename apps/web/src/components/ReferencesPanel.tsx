import { useEffect, useState } from 'react';
import {
  fetchProjectReferences,
  removeProjectReference,
  toggleProjectReference,
  type ProjectReference,
} from '../providers/registry';
import type { DesignSystemSummary } from '../types';

interface Props {
  projectId: string;
  designSystems: DesignSystemSummary[];
  onClose: () => void;
}

export function ReferencesPanel({ projectId, designSystems, onClose }: Props) {
  const [refs, setRefs] = useState<ProjectReference[]>([]);
  const [urlInput, setUrlInput] = useState('');
  const [urlError, setUrlError] = useState('');
  const [dsFilter, setDsFilter] = useState('');
  const [showDsPicker, setShowDsPicker] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void fetchProjectReferences(projectId).then(setRefs);
  }, [projectId]);

  const isStarred = (dsId: string) =>
    refs.some((r) => r.kind === 'design-system' && r.value === dsId);

  const handleToggleDs = async (system: DesignSystemSummary) => {
    setSaving(true);
    try {
      const result = await toggleProjectReference(projectId, {
        kind: 'design-system',
        value: system.id,
        label: system.title,
      });
      if (result.state === 'added' && result.reference) {
        setRefs((prev) => [...prev, result.reference!]);
      } else {
        setRefs((prev) =>
          prev.filter((r) => !(r.kind === 'design-system' && r.value === system.id)),
        );
      }
    } finally {
      setSaving(false);
    }
  };

  const handleAddUrl = async () => {
    const trimmed = urlInput.trim();
    if (!trimmed) return;
    if (!/^https?:\/\/.+/.test(trimmed)) {
      setUrlError('URL must start with http:// or https://');
      return;
    }
    setUrlError('');
    setSaving(true);
    try {
      const result = await toggleProjectReference(projectId, {
        kind: 'url',
        value: trimmed,
      });
      if (result.state === 'added' && result.reference) {
        setRefs((prev) => [...prev, result.reference!]);
        setUrlInput('');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (ref: ProjectReference) => {
    setSaving(true);
    try {
      await removeProjectReference(projectId, ref.id);
      setRefs((prev) => prev.filter((r) => r.id !== ref.id));
    } finally {
      setSaving(false);
    }
  };

  const filteredDs = dsFilter
    ? designSystems.filter((s) => s.title.toLowerCase().includes(dsFilter.toLowerCase()))
    : designSystems.slice(0, 30);

  const dsRefs = refs.filter((r) => r.kind === 'design-system');
  const otherRefs = refs.filter((r) => r.kind !== 'design-system');

  return (
    <div className="refs-panel" role="dialog" aria-label="References">
      <div className="refs-panel-head">
        <span className="refs-panel-title">References</span>
        <button type="button" className="refs-panel-close icon-only" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      {refs.length === 0 ? (
        <div className="refs-panel-empty">
          No references yet. Star a design system or add a URL to give the agent taste signals.
        </div>
      ) : (
        <ul className="refs-list">
          {dsRefs.map((r) => (
            <li key={r.id} className="refs-item refs-item--ds">
              <span className="refs-item-kind">DS</span>
              <span className="refs-item-label">{r.label ?? r.value}</span>
              <button
                type="button"
                className="refs-item-remove"
                disabled={saving}
                onClick={() => void handleRemove(r)}
                aria-label={`Remove ${r.label ?? r.value}`}
              >
                ×
              </button>
            </li>
          ))}
          {otherRefs.map((r) => (
            <li key={r.id} className="refs-item refs-item--url">
              <span className="refs-item-kind">URL</span>
              <span className="refs-item-label" title={r.value}>
                {r.note ?? new URL(r.value).hostname}
              </span>
              <button
                type="button"
                className="refs-item-remove"
                disabled={saving}
                onClick={() => void handleRemove(r)}
                aria-label={`Remove ${r.value}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="refs-panel-section">
        <div className="refs-url-row">
          <input
            className="refs-url-input"
            type="url"
            placeholder="https://example.com"
            value={urlInput}
            onChange={(e) => {
              setUrlInput(e.target.value);
              setUrlError('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleAddUrl();
            }}
          />
          <button
            type="button"
            className="refs-url-add"
            disabled={saving || !urlInput.trim()}
            onClick={() => void handleAddUrl()}
          >
            Add URL
          </button>
        </div>
        {urlError ? <div className="refs-url-error">{urlError}</div> : null}
      </div>

      <div className="refs-panel-section">
        <button
          type="button"
          className="refs-ds-toggle"
          onClick={() => setShowDsPicker((v) => !v)}
        >
          {showDsPicker ? '▾' : '▸'} Design systems
        </button>
        {showDsPicker ? (
          <div className="refs-ds-picker">
            <input
              className="refs-ds-filter"
              placeholder="Filter…"
              value={dsFilter}
              onChange={(e) => setDsFilter(e.target.value)}
              autoFocus
            />
            <ul className="refs-ds-list">
              {filteredDs.map((s) => {
                const starred = isStarred(s.id);
                return (
                  <li key={s.id} className="refs-ds-item">
                    <button
                      type="button"
                      className={`refs-ds-star${starred ? ' starred' : ''}`}
                      disabled={saving}
                      onClick={() => void handleToggleDs(s)}
                      aria-label={starred ? `Unstar ${s.title}` : `Star ${s.title}`}
                      title={starred ? 'Remove from references' : 'Add to references'}
                    >
                      {starred ? '★' : '☆'}
                    </button>
                    <span className="refs-ds-name">{s.title}</span>
                  </li>
                );
              })}
              {filteredDs.length === 0 ? (
                <li className="refs-ds-empty">No match</li>
              ) : null}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}
