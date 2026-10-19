// src/swarm/blackboard.ts
// Shared blackboard (item 5). A single coordination surface visible to every
// worker round: the structured plan, the open gaps, the merged evidence cards,
// the blocked URLs, and the live time budget. The orchestrator only ASSIGNS gaps
// and MERGES cards onto the blackboard; it never writes report prose. In the
// single-threaded Node event loop the mutators below are synchronous, so there
// is no read-modify-write race between parallel workers.
import {
  ResearchPlan,
  EvidenceCard,
  GradedEvidenceCard,
  BlockedUrlEntry,
} from "../types";

export interface BlackboardSnapshot {
  readonly plan: ResearchPlan | null;
  readonly gaps: ReadonlyArray<string>;
  readonly cards: ReadonlyArray<EvidenceCard>;
  readonly gradedCards: ReadonlyArray<GradedEvidenceCard>;
  readonly blockedUrls: ReadonlyArray<BlockedUrlEntry>;
  readonly timeLeftMs: number;
  readonly memoryContext: string | null;
}

export interface Blackboard {
  readonly plan: ResearchPlan | null;
  readonly gaps: ReadonlyArray<string>;
  readonly cards: ReadonlyArray<EvidenceCard>;
  readonly gradedCards: ReadonlyArray<GradedEvidenceCard>;
  readonly blockedUrls: ReadonlyArray<BlockedUrlEntry>;
  /** Merged prior-run + sibling-plugin memory text for this topic (if any). */
  readonly memoryContext: string | null;
  /** Milliseconds remaining until the crawl deadline (Infinity when unbounded). */
  timeLeft(): number;
  attachPlan(plan: ResearchPlan | null): void;
  setMemoryContext(text: string | null): void;
  addGap(gap: string): void;
  mergeCards(cards: ReadonlyArray<EvidenceCard>): void;
  mergeGraded(graded: ReadonlyArray<GradedEvidenceCard>): void;
  snapshot(): BlackboardSnapshot;
}

export type BlockedUrlsSource = () => ReadonlyArray<BlockedUrlEntry>;

export class SwarmBlackboard implements Blackboard {
  private _plan: ResearchPlan | null = null;
  private _memoryContext: string | null = null;
  private readonly _gaps: string[] = [];
  private readonly _cards: EvidenceCard[] = [];
  private readonly _graded: GradedEvidenceCard[] = [];
  private readonly blockedSource: BlockedUrlsSource;
  private readonly deadline: number;

  constructor(blockedSource: BlockedUrlsSource, deadline: number) {
    this.blockedSource = blockedSource;
    this.deadline = deadline;
  }

  get plan(): ResearchPlan | null {
    return this._plan;
  }

  get gaps(): ReadonlyArray<string> {
    return this._gaps;
  }

  get cards(): ReadonlyArray<EvidenceCard> {
    return this._cards;
  }

  get gradedCards(): ReadonlyArray<GradedEvidenceCard> {
    return this._graded;
  }

  get blockedUrls(): ReadonlyArray<BlockedUrlEntry> {
    return this.blockedSource();
  }

  get memoryContext(): string | null {
    return this._memoryContext;
  }

  timeLeft(): number {
    if (!Number.isFinite(this.deadline)) return Infinity;
    return Math.max(0, this.deadline - Date.now());
  }

  attachPlan(plan: ResearchPlan | null): void {
    this._plan = plan;
  }

  setMemoryContext(text: string | null): void {
    this._memoryContext = text && text.trim().length > 0 ? text : null;
  }

  addGap(gap: string): void {
    if (gap && !this._gaps.includes(gap)) this._gaps.push(gap);
  }

  mergeCards(cards: ReadonlyArray<EvidenceCard>): void {
    const known = new Set(this._cards.map((c) => c.id));
    for (const card of cards) {
      if (!known.has(card.id)) {
        known.add(card.id);
        this._cards.push(card);
      }
    }
  }

  mergeGraded(graded: ReadonlyArray<GradedEvidenceCard>): void {
    const known = new Set(this._graded.map((c) => c.id));
    for (const card of graded) {
      if (!known.has(card.id)) {
        known.add(card.id);
        this._graded.push(card);
      }
    }
  }

  replaceGraded(graded: ReadonlyArray<GradedEvidenceCard>): void {
    this._graded.length = 0;
    this.mergeGraded(graded);
  }

  snapshot(): BlackboardSnapshot {
    return {
      plan: this._plan,
      gaps: [...this._gaps],
      cards: [...this._cards],
      gradedCards: [...this._graded],
      blockedUrls: this.blockedUrls,
      timeLeftMs: this.timeLeft(),
      memoryContext: this._memoryContext,
    };
  }
}