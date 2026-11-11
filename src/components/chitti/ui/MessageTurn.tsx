import type { ReactNode, Ref } from "react";

/**
 * One conversation turn: the user's message as a bubble (its text is a
 * heading, so the transcript has an outline), then Chitti's reply. Used for
 * the active turn, earlier turns and the in-flight request.
 */
export function MessageTurn({
  who,
  question,
  meta,
  children,
  isCurrent = false,
  turnRef,
  label,
}: {
  /** Shown above the bubble when it is not simply "You" (a recorded example…). */
  who?: ReactNode;
  question: string;
  meta?: ReactNode;
  children?: ReactNode;
  isCurrent?: boolean;
  turnRef?: Ref<HTMLElement>;
  label?: string;
}) {
  return (
    <article className="cx-turn" data-current={isCurrent || undefined} ref={turnRef} aria-label={label}>
      <div className="cx-ask">
        {who && <span className="cx-micro">{who}</span>}
        <div className="cx-you">
          <h2>{question}</h2>
        </div>
        {meta && <div className="cx-ask-meta">{meta}</div>}
      </div>
      <div className="cx-reply">
        <div className="cx-who">
          <span className="cx-glyph" aria-hidden="true" />
          Chitti
        </div>
        {children}
      </div>
    </article>
  );
}
