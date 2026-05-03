import { useEffect, useState } from 'react';
import {
  clearTasteScope,
  deleteTasteSignal,
  fetchTasteAggregates,
  fetchTasteSignals,
  type TasteAggregate,
  type TasteSignal,
} from '../providers/registry';

type Scope = 'user' | 'project' | 'session';
type View = 'aggregated' | 'raw';

interface Props {
  projectId?: string | null;
}

export function TasteMemoryTab({ projectId }: Props) {
  const [scope, setScope] = useState<Scope>('user');
  const [view, setView] = useState<View>('aggregated');
  const [aggregates, setAggregates] = useState<TasteAggregate[]>([]);
  const [signals, setSignals] = useState<TasteSignal[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const scopeId = scope === 'project' ? (projectId ?? null) : null;

  useEffect(() => {
    setLoading(true);
    if (view === 'aggregated') {
      void fetchTasteAggregates(scope, scopeId).then((data) => {
        setAggregates(data);
        setLoading(false);
      });
    } else {
      void fetchTasteSignals(scope, scopeId).then((data) => {
        setSignals(data);
        setLoading(false);
      });
    }
  }, [scope, scopeId, view]);

  const handleDeleteSignal = async (id: string) => {
    await deleteTasteSignal(id);
    setSignals((prev) => prev.filter((s) => s.id !== id));
  };

  const handleClearScope = async () => {
    await clearTasteScope(scope, scopeId);
    setAggregates([]);
    setSignals([]);
    setConfirmClear(false);
  };

  const prefer = aggregates.filter((a) => a.score > 0).sort((a, b) => b.score - a.score);
  const avoid = aggregates.filter((a) => a.score <= 0).sort((a, b) => a.score - b.score);

  return (
    <section className="settings-section taste-section">
      <div className="section-head">
        <div>
          <h3>Taste memory</h3>
          <p className="hint">Signals the agent uses to personalise output.</p>
        </div>
        <span className="taste-privacy-chip">On-device only</span>
      </div>

      <div className="taste-scope-row">
        <div className="seg-control taste-scope-seg">
          <button
            type="button"
            className={`seg-btn${scope === 'user' ? ' active' : ''}`}
            onClick={() => setScope('user')}
          >
            <span className="seg-title">User</span>
            <span className="seg-meta">all projects</span>
          </button>
          <button
            type="button"
            className={`seg-btn${scope === 'project' ? ' active' : ''}`}
            disabled={!projectId}
            title={!projectId ? 'Open a project to view project-level taste' : undefined}
            onClick={() => setScope('project')}
          >
            <span className="seg-title">Project</span>
            <span className="seg-meta">{projectId ? 'this project' : 'no project'}</span>
          </button>
        </div>
        <div className="taste-view-toggle">
          <button
            type="button"
            className={`taste-view-btn${view === 'aggregated' ? ' active' : ''}`}
            onClick={() => setView('aggregated')}
          >
            Aggregated
          </button>
          <button
            type="button"
            className={`taste-view-btn${view === 'raw' ? ' active' : ''}`}
            onClick={() => setView('raw')}
          >
            Raw signals
          </button>
        </div>
      </div>

      {loading ? (
        <div className="taste-empty">Loading…</div>
      ) : view === 'aggregated' ? (
        aggregates.length === 0 ? (
          <div className="taste-empty">
            No taste signals yet for this scope. They accumulate as you generate and refine artifacts.
          </div>
        ) : (
          <div className="taste-agg-body">
            {prefer.length > 0 ? (
              <div className="taste-group">
                <div className="taste-group-label taste-group-label--prefer">Prefer</div>
                {prefer.map((a) => (
                  <AggregateRow key={a.subject} agg={a} />
                ))}
              </div>
            ) : null}
            {avoid.length > 0 ? (
              <div className="taste-group">
                <div className="taste-group-label taste-group-label--avoid">Avoid</div>
                {avoid.map((a) => (
                  <AggregateRow key={a.subject} agg={a} />
                ))}
              </div>
            ) : null}
          </div>
        )
      ) : (
        signals.length === 0 ? (
          <div className="taste-empty">No raw signals for this scope.</div>
        ) : (
          <ul className="taste-signals-list">
            {signals.map((s) => (
              <SignalRow key={s.id} signal={s} onDelete={() => void handleDeleteSignal(s.id)} />
            ))}
          </ul>
        )
      )}

      {!loading && (aggregates.length > 0 || signals.length > 0) ? (
        <div className="taste-footer">
          {confirmClear ? (
            <span className="taste-confirm-row">
              Clear all {scope}-scope signals?{' '}
              <button
                type="button"
                className="taste-confirm-yes"
                onClick={() => void handleClearScope()}
              >
                Yes, clear
              </button>
              <button
                type="button"
                className="taste-confirm-no"
                onClick={() => setConfirmClear(false)}
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="taste-clear-btn"
              onClick={() => setConfirmClear(true)}
            >
              Clear {scope} scope
            </button>
          )}
        </div>
      ) : null}
    </section>
  );
}

function AggregateRow({ agg }: { agg: TasteAggregate }) {
  const [kind, ...rest] = agg.subject.split(':');
  const value = rest.join(':');
  return (
    <div className="taste-agg-row">
      <span className="taste-subject-kind">{kind}</span>
      <span className="taste-subject-value">{value}</span>
      <span className={`taste-conf-badge taste-conf-badge--${agg.confidence}`}>
        {agg.confidence}
      </span>
      <span className="taste-score">{agg.score > 0 ? `+${agg.score.toFixed(1)}` : agg.score.toFixed(1)}</span>
      <span className="taste-count">{agg.count}×</span>
    </div>
  );
}

function SignalRow({ signal, onDelete }: { signal: TasteSignal; onDelete: () => void }) {
  const date = new Date(signal.createdAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  return (
    <li className={`taste-signal-row taste-signal-row--${signal.polarity > 0 ? 'pos' : 'neg'}`}>
      <span className="taste-signal-pol">{signal.polarity > 0 ? '+' : '−'}</span>
      <span className="taste-signal-subject">{signal.subject}</span>
      <span className="taste-signal-source">{signal.source}</span>
      <span className="taste-signal-date">{date}</span>
      <button
        type="button"
        className="taste-signal-del"
        onClick={onDelete}
        aria-label={`Delete signal ${signal.subject}`}
      >
        ×
      </button>
    </li>
  );
}
