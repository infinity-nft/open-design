/**
 * FeedbackBar — thumbs-up / thumbs-down affordance with an optional
 * one-line "why?" expansion. Lives in the assistant message footer
 * for the LAST assistant turn so users can register their verdict on
 * the run as a whole.
 *
 * Wires to POST `/api/feedback`, which records taste signals scoped
 * to the project / user. See `apps/daemon/src/TASTE-MEMORY.md` and
 * docs/prompt-engineering.md Layer 6 for the full memory pipeline.
 *
 * Local state only — once the verdict is sent, the bar locks into a
 * "thank you" state. Re-clicking the chosen verdict is a no-op so
 * users can't accidentally double-fire signals; the verdict can be
 * removed (and re-cast) through the memory inspector when that ships.
 */
import { useState } from 'react';
import { postFeedback } from '../providers/registry';

interface Props {
  runId: string | null | undefined;
  projectId: string | null | undefined;
  conversationId: string | null | undefined;
  skillId?: string | null;
  designSystemId?: string | null;
}

type Verdict = 'up' | 'down' | null;

export function FeedbackBar({
  runId,
  projectId,
  conversationId,
  skillId,
  designSystemId,
}: Props) {
  const [verdict, setVerdict] = useState<Verdict>(null);
  const [why, setWhy] = useState('');
  const [whyVisible, setWhyVisible] = useState(false);
  const [submitted, setSubmitted] = useState<Verdict>(null);
  const [submitting, setSubmitting] = useState(false);

  const send = async (v: 'up' | 'down', whyText: string) => {
    setSubmitting(true);
    const ok = await postFeedback({
      polarity: v === 'up' ? 1 : -1,
      runId: runId ?? null,
      projectId: projectId ?? null,
      conversationId: conversationId ?? null,
      skillId: skillId ?? null,
      designSystemId: designSystemId ?? null,
      why: whyText || null,
    });
    setSubmitting(false);
    if (ok) {
      setSubmitted(v);
      setWhyVisible(false);
    }
  };

  if (submitted) {
    return (
      <div className={`feedback-bar feedback-bar--submitted feedback-bar--${submitted}`}>
        <span className="feedback-thanks">
          {submitted === 'up' ? 'Saved as preference' : 'Saved as something to avoid'}
        </span>
      </div>
    );
  }

  return (
    <div className="feedback-bar" role="group" aria-label="Rate this response">
      <div className="feedback-bar-row">
        <span className="feedback-prompt">Was this on track?</span>
        <button
          type="button"
          className={`feedback-btn feedback-btn--up ${verdict === 'up' ? 'is-active' : ''}`}
          aria-pressed={verdict === 'up'}
          onClick={() => {
            setVerdict('up');
            setWhyVisible(true);
          }}
          disabled={submitting}
          aria-label="Thumbs up"
          title="Save as a preference"
        >
          <span aria-hidden>▲</span>
        </button>
        <button
          type="button"
          className={`feedback-btn feedback-btn--down ${verdict === 'down' ? 'is-active' : ''}`}
          aria-pressed={verdict === 'down'}
          onClick={() => {
            setVerdict('down');
            setWhyVisible(true);
          }}
          disabled={submitting}
          aria-label="Thumbs down"
          title="Save as something to avoid"
        >
          <span aria-hidden>▼</span>
        </button>
        {verdict && !whyVisible ? (
          <button
            type="button"
            className="feedback-skip"
            onClick={() => verdict && void send(verdict, '')}
            disabled={submitting}
          >
            Skip
          </button>
        ) : null}
      </div>
      {whyVisible && verdict ? (
        <form
          className="feedback-why"
          onSubmit={(e) => {
            e.preventDefault();
            void send(verdict, why.trim());
          }}
        >
          <input
            type="text"
            className="feedback-why-input"
            placeholder={
              verdict === 'up'
                ? 'What worked? (optional, e.g. "loved the type pairing")'
                : 'What was off? (optional, e.g. "too busy in the hero")'
            }
            value={why}
            onChange={(e) => setWhy(e.target.value)}
            maxLength={500}
            autoFocus
            disabled={submitting}
          />
          <button type="submit" className="feedback-why-submit" disabled={submitting}>
            {submitting ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            className="feedback-why-skip"
            onClick={() => verdict && void send(verdict, '')}
            disabled={submitting}
          >
            Skip
          </button>
        </form>
      ) : null}
    </div>
  );
}
