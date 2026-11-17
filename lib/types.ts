// What the server sends the app: the one contract. lib/view.ts builds it and web/src reads it; `npm run typecheck`
// checks both sides against it.

export type BodyType = 'markdown' | 'text' | 'diff' | 'questions' | 'findings';
export type KindName = 'review' | 'interview' | 'findings';
export type DecisionName = 'approve' | 'send-back' | 'drop' | 'answer' | 'findings';

/** The thing a question is about, shown with it or with an option: an attached image, recording or sound, lines of
 * code, a live local page, copy as text or markdown, or a component as HTML (rendered in a sandbox). */
export type Show =
  | { image: string } | { video: string } | { audio: string } | { file: string; start: number; lines: string[] } | { url: string }
  | { text: string } | { markdown: string } | { html: string };
export interface Option { label: string; description?: string; show?: Show[] }
export interface Question { id: string; title: string; body?: string; options: Option[]; recommended?: number; recommendation?: string; opens?: boolean; show?: Show[] }
export interface Round { questions: Question[] }

export interface Answer { id: string; choice: number | null; other?: string; accepted?: boolean }

export interface Anchor {
  kind: 'text' | 'item';
  quote?: string;
  prefix?: string;
  suffix?: string;
  start?: number;
  end?: number;
  file?: string;
  line?: number;
  side?: 'old' | 'new';
}
export interface Comment { id: string; anchor: Anchor; text: string }
export interface Reply { comment: number | string; addressed: boolean; text: string }

export interface Finding {
  id: string; title: string; severity: 'high' | 'medium' | 'low'; body: string; fix?: string;
  file?: string; line?: number; excerpt?: { start: number; lines: string[] };
}
export interface Mark { id: string; mark: 'keep' | 'dismiss'; reason?: string; comment?: string }

export interface Decision { decision: DecisionName; comments?: Comment[]; answers?: Answer[]; marks?: Mark[]; decidedAt?: string }


export interface Version {
  n: number;
  bodyType: BodyType;
  note?: string;
  createdAt: string;
  replaced: boolean;
  body: string | Round | { findings: Finding[] };
  files: string[];
}

/** Where an item was sent from: the folder, its checkout, the repository's name and the branch. */
export interface Source { agent?: string; cwd?: string; top?: string; repo?: string; branch?: string }

/** What was asked of the version before, each with the agent's reply in this one. */
export interface Asked { id: string; text: string; anchor: Anchor; title?: string; reply: Reply | null }

/** An item's colour: given once when it arrives, one that no waiting item has, and kept through every round. */
export type Hue = 'slate' | 'terracotta' | 'moss' | 'plum' | 'ochre';

export interface Item {
  id: string;
  hue: Hue;
  /** Which view shows it, and which decisions it takes. */
  kind: KindName;
  /** The decisions this item takes, each with what it is called once made ("Approved"). */
  decisions: Partial<Record<DecisionName, string>>;
  title: string;
  source?: Source;
  createdAt: string;
  version: Version;
  /** On a revision: the version before, and what you asked of it with the agent's replies. */
  previous: { n: number; bodyType: BodyType; body: string; comments: Asked[] } | null;
  history: { n: number; title?: string; note?: string; bodyType: BodyType; body?: Round; decision: Decision | null }[];
  waiting: boolean;
  /**
   * Where your decision goes: 'waiting', an agent is waiting and wakes with it; 'its-session', the session that
   * asked is open but stopped waiting, and gets it when you next write there; 'ended', that session has
   * ended, and gets it only if it is resumed (or an agent in its repository runs `bateson inbox`).
   */
  reach: 'waiting' | 'its-session' | 'ended';
}

export interface QueueRow { id: string; n: number; title: string; kind: KindName; repo?: string; waiting: boolean }

export interface Config {
  name: string;
  blocked: 'notify' | 'notify-forward' | 'none';
  sound: boolean;
  hotkey: 'ctrl+option+space' | 'option+q' | 'cmd+shift+space' | 'off';
  undoSeconds: number;
  stopCheck: boolean;
  theme: 'system' | 'light' | 'dark';
  /** The panel beside a question, for what it shows. Off, every question is centred and asked in words only. */
  preview: boolean;
  bring: { decisions: boolean; plans: boolean; findings: boolean; code: boolean };
  /** Once a day, ask GitHub whether there is a newer version (lib/update.ts). Nothing of theirs is sent. */
  updates: boolean;
}

/**
 * Where updating bateson stands (lib/update.ts, ~/.bateson/update.json). 'available': a new version that can be
 * installed from the app; 'blocked': one that cannot, because the checkout has changes or commits of its own
 * (`reason`); 'updating' (`step`); 'failed': it went back to the version before (`reason`); 'restart': updated,
 * but the server was started by hand and has to be started again.
 */
export interface UpdateView {
  state: 'current' | 'available' | 'blocked' | 'updating' | 'failed' | 'restart';
  checkedAt?: string;
  /** The new commits, newest first, at most 30, and how many more there are. */
  changes: { hash: string; subject: string }[];
  more: number;
  reason?: string;
  step?: string;
  /** The last check could not reach GitHub. */
  error?: string;
  updatedAt?: string;
  /** Said after an update: what did not work, such as rebuilding the Mac app. */
  note?: string;
}

export interface State {
  reviewer: string;
  queue: QueueRow[];
  current: Item | null;
  config: Config;
  writing: { id: string; title: string; next: number; sessionId?: string }[];
  /** Items their agent cancelled in the last ten minutes, because you called them off in its terminal. */
  cancelled: { id: string; title: string; at: string }[];
  agents: { sessionId: string; repo: string; title?: string; since: string }[];
  update: UpdateView;
}

export interface Summary {
  count: number;
  config: Config;
  waiting: { id: string; n: number; title: string; repo?: string }[];
}
