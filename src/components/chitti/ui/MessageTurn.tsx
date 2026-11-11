import type { ReactNode, Ref } from "react";
import { Heading } from "@astryxdesign/core/Heading";
import { MicroLabel } from "./primitives";

/**
 * One conversation turn: the question as asked (a heading, so the transcript
 * has an outline), an optional toolbar row, then Chitti's reply. Used for the
 * active turn and for every earlier turn in the branch.
 */
export function MessageTurn({
  who,
  question,
  aside,
  toolbar,
  children,
  isCurrent = false,
  turnRef,
}: {
  who: ReactNode;
  question: string;
  aside?: ReactNode;
  toolbar?: ReactNode;
  children?: ReactNode;
  isCurrent?: boolean;
  turnRef?: Ref<HTMLElement>;
}) {
  return (
    <article className="cx-turn" data-current={isCurrent || undefined} ref={turnRef}>
      <div className="cx-turn-ask">
        <MicroLabel>{who}</MicroLabel>
        <Heading level={2} className="cx-turn-question">
          {question}
        </Heading>
        {aside}
      </div>
      {toolbar}
      <div className="cx-turn-reply">
        <MicroLabel className="cx-turn-author">
          <span className="cx-author-mark" aria-hidden="true" />
          Chitti
        </MicroLabel>
        {children}
      </div>
    </article>
  );
}
