import { useEffect, useMemo, useRef, useState } from 'react';
import type { Answer, Decision, Item, Question, Round, Show } from '@lib/types';
import { Markdown } from './Markdown';
import { Ring } from './Ring';
import { isTyping, Reach } from './App';
import { ArrowRight, Pause, Play, Volume2, VolumeX, X } from 'lucide-react';
import { toast } from 'sonner';
import { keptKey, useKept, useKeptRef } from './lib/kept';

// One question at a time. Choosing moves you on; the recommendation is preselected (dashed) until you touch it.

// `images`: screenshots pasted or dropped into your own answer, by the name the server saved them under.
interface Draft { choice: number | null; other: string; images?: string[]; writing: boolean; touched: boolean }

const pics = (d: Draft) => d.images ?? [];
const said = (d: Draft) => d.other.trim().length > 0 || pics(d).length > 0;

const ADVANCE_MS = 260;
// How long the pointer rests on an option before its sound plays: crossing the list on the way somewhere stays silent.
const REST_MS = 150;

export function Interview({ item, panel, onDecide }: { item: Item; panel: boolean; onDecide: (i: Item, d: Decision) => void }) {
  const round = item.version.body as Round;
  const qs = round.questions ?? [];
  // The rounds you already answered in this interview, for the dots.
  const past = useMemo(() => item.history
    .filter((h) => h.bodyType === 'questions' && h.body?.questions?.length && h.decision?.answers)
    .map((h) => ({ n: h.n, questions: h.body!.questions, answers: h.decision!.answers! })), [item.history]);
  const kk = keptKey(item);
  const [drafts, setDrafts] = useKept<Record<string, Draft>>(`${kk}:drafts`, () =>
    Object.fromEntries(qs.map((q) => [q.id, { choice: q.recommended ?? null, other: '', writing: false, touched: false }])),
  );
  const [kept, setAt] = useKept(`${kk}:at`, () => 0);
  // The questions you moved on from: a recommendation you went past counts as given, one you never reached does not.
  const [passed, setPassed] = useKept<string[]>(`${kk}:passed`, () => []);
  // Kept from before the answers screen went, a place past the last question means the last one.
  const at = Math.min(kept, Math.max(0, qs.length - 1));
  const [dir, setDir] = useState<'fwd' | 'back'>('fwd');
  // The option under the pointer or the focus: the preview shows what it would look like.
  const [peek, setPeek] = useState<string | null>(null);
  const [replay, setReplay] = useState(0);
  // A picture opened large, over everything, until a click or a key puts it back.
  const [zoom, setZoom] = useState<string | null>(null);
  const otherRef = useRef<HTMLTextAreaElement | null>(null);
  const advanceTimer = useRef<number | undefined>(undefined);

  const answered = (id: string) => {
    const d = drafts[id];
    return d.writing ? said(d) : d.choice != null;
  };
  const ready = qs.every((q) => answered(q.id));
  // What Send now sends: an answer you touched, or a recommendation you saw and went past.
  const given = (id: string) => answered(id) && (drafts[id].touched || passed.includes(id));
  const givenCount = qs.filter((x) => given(x.id)).length;
  // Send now is offered once something is given and something is not: with everything given, Send does it.
  const early = givenCount > 0 && givenCount < qs.length;
  const last = at === qs.length - 1;
  const q = qs[at] as (typeof qs)[number] | undefined;
  const d = q ? drafts[q.id] : null;

  const filesBase = `/api/items/${item.id}/files/${item.version.n}/`;
  const pastedBase = `/api/items/${item.id}/pasted/${item.version.n}/`;

  // Screenshots on their way to the server: until they arrive, the answer cannot be sent without them.
  const [adding, setAdding] = useState(0);
  const addingRef = useRef(0);
  addingRef.current = adding;

  // Sounds are heard, not shown: an option's sound plays when the pointer rests on it or you press its letter, and
  // the panel keeps only what can be looked at. The rest starts on pointer movement, never on the page appearing
  // under a still pointer, so opening a question is always silent.
  const sound = useSound();
  // Options with something to see or hear are compared by letter, so a letter does not move on: ⏎ does. Pointing
  // already showed the option, so a click picks it and moves on, as it does everywhere else.
  const compared = !!q?.options.some((o) => o.show?.some((s) => panel || isSound(s)));
  const rest = useRef<{ oi: number; timer: number } | null>(null);
  const hear = (oi: number) => {
    const s = q?.options[oi]?.show?.find(isSound);
    if (q && s) sound.play(`${q.id}:${oi}`, filesBase + encodeURIComponent(s.audio));
  };
  const restOn = (oi: number) => {
    if (rest.current?.oi === oi || !q?.options[oi]?.show?.some(isSound)) return;
    clearTimeout(rest.current?.timer);
    rest.current = { oi, timer: window.setTimeout(() => hear(oi), REST_MS) };
  };
  const restOff = (oi: number) => {
    if (rest.current?.oi !== oi) return;
    clearTimeout(rest.current.timer);
    rest.current = null;
  };
  useEffect(() => () => { clearTimeout(rest.current?.timer); rest.current = null; }, [q?.id]);
  // A recording's sound, once turned on, stays on while you compare this question's options.
  const [videoSound, setVideoSound] = useState(false);
  useEffect(() => setVideoSound(false), [q?.id]);

  const set = (id: string, patch: Partial<Draft>) => setDrafts((ds) => ({ ...ds, [id]: { ...ds[id], ...patch, touched: true } }));

  // A question marked `opens` decides later ones: its answer goes to the agent as you move past it, so the
  // agent can draft the follow-ups while you answer the rest.
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  // Kept across a reload too, so an early answer already sent is not sent again.
  const { ref: reported, save: saveReported } = useKeptRef<Record<string, string>>(`${kk}:reported`, () => ({}));
  const reportEarly = (qi: number) => {
    const x = qs[qi];
    if (!x?.opens) return;
    const a = answerOf(x, draftsRef.current[x.id]);
    if (a.choice == null && !a.other) return;
    const key = JSON.stringify(a);
    if (reported.current[x.id] === key) return;
    reported.current[x.id] = key;
    saveReported();
    fetch(`/api/items/${item.id}/early`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ n: item.version.n, answer: a }),
    }).catch(() => {});
  };

  const go = (i: number) => {
    clearTimeout(advanceTimer.current);
    const n = Math.max(0, Math.min(qs.length - 1, i));
    if (n === at) return;
    if (n > at) {
      reportEarly(at);
      const id = qs[at]?.id;
      if (id) setPassed((p) => (p.includes(id) ? p : [...p, id]));
    }
    setDir(n > at ? 'fwd' : 'back');
    setAt(n);
    window.scrollTo({ top: 0 });
  };

  const choose = (oi: number, clicked = false) => {
    if (!q) return;
    // Picking the option you picked takes it back. The recommendation, set for you, is only confirmed.
    const d = drafts[q.id];
    if (d.touched && !d.writing && d.choice === oi) { clearTimeout(advanceTimer.current); set(q.id, { choice: null }); return; }
    set(q.id, { choice: oi, writing: false });
    if (!clicked) document.querySelector(`.interview .opt[data-oi="${oi}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (!last && (clicked || !compared)) {
      clearTimeout(advanceTimer.current);
      advanceTimer.current = window.setTimeout(() => go(at + 1), ADVANCE_MS);
    }
  };

  // `typed`: the key that started it, when you began writing without choosing Write your own first.
  const write = (typed = '') => {
    if (!q) return;
    clearTimeout(advanceTimer.current);
    const id = q.id;
    setDrafts((ds) => ({ ...ds, [id]: { ...ds[id], writing: true, choice: null, other: ds[id].other + typed, touched: true } }));
    window.setTimeout(() => {
      const f = otherRef.current;
      if (!f) return;
      f.focus();
      f.setSelectionRange(f.value.length, f.value.length);
    }, 0);
  };

  // A screenshot pasted or dropped: it makes your own answer the answer, and is saved at once, so the answer
  // only names it. Each lands on the question you were on when you pasted it.
  const attach = (files: File[]) => {
    if (!q) return;
    const id = q.id;
    const images = files.filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type));
    if (!images.length) { if (files.length) toast('Only a picture (png, jpg, gif, webp) can go in your answer.'); return; }
    write();
    for (const f of images) {
      setAdding((k) => k + 1);
      base64(f)
        .then((data) => fetch(`/api/items/${item.id}/pasted`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ n: item.version.n, type: f.type, data }),
        }))
        .then(async (res) => {
          const out = await res.json().catch(() => ({})) as { name?: string; error?: string };
          if (!res.ok || !out.name) throw new Error(out.error || 'The screenshot did not reach bateson.');
          const name = out.name;
          setDrafts((ds) => ({ ...ds, [id]: { ...ds[id], writing: true, choice: null, touched: true, images: [...pics(ds[id]), name] } }));
        })
        .catch((e: Error) => toast(e.message || 'The screenshot did not reach bateson.'))
        .finally(() => setAdding((k) => k - 1));
    }
  };
  const unattach = (name: string) => {
    if (!q) return;
    set(q.id, { images: pics(drafts[q.id]).filter((x) => x !== name) });
  };

  // ⌘V with a screenshot on the clipboard, anywhere on the question, puts it in your own answer. Text pasted into
  // a field is left to the field.
  const attachRef = useRef(attach);
  attachRef.current = attach;
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.some((f) => f.type.startsWith('image/'))) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || (t.tagName === 'TEXTAREA' && !t.classList.contains('own-field')))) return;
      e.preventDefault();
      attachRef.current(files);
    };
    // A picture dragged onto the window goes in too, instead of the window opening it and leaving bateson.
    const onOver = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } };
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      attachRef.current([...e.dataTransfer.files]);
    };
    window.addEventListener('paste', onPaste);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => { window.removeEventListener('paste', onPaste); window.removeEventListener('dragover', onOver); window.removeEventListener('drop', onDrop); };
  }, []);

  const send = () => {
    if (addingRef.current) return;
    if (!ready) { go(qs.findIndex((x) => !answered(x.id))); return; }
    const answers: Answer[] = qs.map((x) => answerOf(x, drafts[x.id]));
    onDecide(item, { decision: 'answer', answers });
  };

  // Send the answers given so far, not the round: the rest go back to the agent as unanswered, and the next round
  // takes what you said into account. It does not end the interview.
  const sendNow = () => {
    if (addingRef.current) return;
    clearTimeout(advanceTimer.current);
    const answers: Answer[] = qs.filter((x) => given(x.id)).map((x) => answerOf(x, drafts[x.id]));
    if (!answers.length) return;
    onDecide(item, { decision: 'answer', answers });
  };

  // Enter: accept what is chosen here and go on; on the last question, send.
  const next = () => {
    if (!q || !answered(q.id)) return;
    if (last) send(); else go(at + 1);
  };

  useEffect(() => () => clearTimeout(advanceTimer.current), []);

  // Two-finger swipe on a trackpad: left for the next question, right for the one before. The question follows
  // the fingers a little, and one swipe moves one question however long the gesture runs on.
  const step = useRef((by: number) => go(at + by));
  step.current = (by: number) => go(at + by);
  const qRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    let acc = 0;
    let fired = false;
    let idle: number | undefined;
    const settle = () => {
      acc = 0;
      fired = false;
      if (qRef.current) { qRef.current.style.transition = ''; qRef.current.style.transform = ''; }
    };
    // A sideways scroll over something that scrolls sideways itself (a long line of code, an answer being typed)
    // is that thing's, not a turn to the next question.
    const scrollsSideways = (t: EventTarget | null) => {
      for (let el = t instanceof Element ? t : null; el && el !== document.body; el = el.parentElement) {
        if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return true;
        const o = getComputedStyle(el).overflowX;
        if ((o === 'auto' || o === 'scroll') && el.scrollWidth > el.clientWidth) return true;
      }
      return false;
    };
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || scrollsSideways(e.target)) return;
      e.preventDefault();
      clearTimeout(idle);
      idle = window.setTimeout(settle, 180);
      if (fired) return;
      acc += e.deltaX;
      if (qRef.current) {
        qRef.current.style.transition = 'none';
        qRef.current.style.transform = `translateX(${Math.max(-40, Math.min(40, -acc * 0.25))}px)`;
      }
      if (Math.abs(acc) > 90) {
        fired = true;
        if (qRef.current) { qRef.current.style.transition = ''; qRef.current.style.transform = ''; }
        step.current(acc > 0 ? 1 : -1);
      }
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => { window.removeEventListener('wheel', onWheel); clearTimeout(idle); };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (zoom) { e.preventDefault(); setZoom(null); return; }
      // ⏎ held down goes on once: its repeats would walk every question, send the round and start on the next one.
      if (e.repeat && e.key === 'Enter') { if (!isTyping(e) || e.metaKey || e.ctrlKey) e.preventDefault(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); if (isTyping(e)) { (e.target as HTMLElement).blur(); next(); } else next(); return; }
      if (isTyping(e)) {
        if (e.key === 'Escape') (e.target as HTMLElement).blur();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); if (early) sendNow(); }
      else if (e.key === 'Enter') { e.preventDefault(); next(); }
      else if (e.key === 'ArrowRight' || e.key === 'j') { e.preventDefault(); go(at + 1); }
      else if (e.key === 'ArrowLeft' || e.key === 'k') { e.preventDefault(); go(at - 1); }
      else if (LETTERS.includes(e.key) && q?.options[LETTERS.indexOf(e.key)]) { e.preventDefault(); choose(LETTERS.indexOf(e.key)); hear(LETTERS.indexOf(e.key)); }
      else if (e.key === 'w') { e.preventDefault(); write(); }
      // Any other character starts your own answer with it, so ending the interview has no key: a capital D
      // would end it mid-sentence.
      else if (e.key.length === 1 && e.key !== ' ') { e.preventDefault(); write(e.key); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });


  if (!q || !d) return null;
  const open = qs.find((x) => x.id !== q.id && !answered(x.id));
  // What this question is about, when the agent sent it along: shown beside the question, which moves to the left.
  // An option with its own picture takes the panel while it is pointed at or chosen.
  // With the panel off in Settings (`preview`), nothing is looked at: every question is centred, and sounds still play.
  const look = (shows?: Show[]) => (panel ? seen(shows) : null);
  const optShows = q ? q.options.map((o) => look(o.show)) : [];
  const peeked = q && peek?.startsWith(`${q.id}:`) ? Number(peek.slice(q.id.length + 1)) : null;
  const active = [peeked, d && !d.writing ? d.choice : null, optShows.findIndex(Boolean)].find((i) => i != null && i >= 0 && optShows[i]) ?? null;
  // Pictures attached to the round as a whole (--attach) stand in where a question has nothing of its own.
  const attached: Show[] = !panel ? [] : item.version.files.filter((f) => /\.(png|jpe?g|gif|webp|svg|mp4|webm|mov|m4v)$/i.test(f) && !/^show\d+-/.test(f))
    .map((f) => (/\.(mp4|webm|mov|m4v)$/i.test(f) ? { video: f } : { image: f }));
  const preview = !q ? null : active != null ? optShows[active] : look(q.show) ?? (attached.length ? attached : null);
  const qSound = q.show?.find(isSound);
  const qSoundKey = `${q.id}:q`;
  // A live page starts again each time it is shown, so pointing at an option plays that option from the start.
  const live = !!preview?.some((p) => 'url' in p);
  // A question with something to look at has the panel beside it; one with nothing keeps the normal layout.

  return (
    <article className={`page interview asks arrive hue-${item.hue}${preview ? ' with-preview' : ''}`}>
      <div className="iv-main">
        {/* The dots sit just above the question, where you are reading: how far through the round you are, at a glance. */}
        {(qs.length > 1 || past.length > 0) && (
          <nav className="iv-steps" aria-label="Questions">
            {/* The earlier rounds, all in one dot a little apart from this round's: pointing at it lists what you
                answered, the latest round first. */}
            {past.length > 0 && (
              <span className="iv-round">
                <span className="iv-step past earlier" aria-label={`${past.reduce((n, r) => n + r.questions.length, 0)} answers from earlier rounds`}>
                  <Ring kind="dot" size={10} />
                  <span className="iv-step-tip" aria-hidden>
                    {[...past].reverse().flatMap((r) => r.questions.map((x) => (
                      <span key={`${r.n}:${x.id}`} className="iv-step-pair">
                        <span className="iv-step-q">{x.title}</span>
                        <span className="iv-step-a">{pastAnswer(x, r.answers.find((a) => a.id === x.id))}</span>
                      </span>
                    )))}
                  </span>
                </span>
              </span>
            )}
            <span className="iv-round">
            {qs.map((x, i) => {
              const answer = shownAnswer(x, drafts[x.id]);
              return (
                <button
                  key={x.id}
                  className={`iv-step${i === at ? ' here' : ''}`}
                  onClick={() => go(i)}
                  aria-current={i === at ? 'step' : undefined}
                  aria-label={`${x.title} ${answer || 'Not answered'}`}
                >
                  <Ring kind={i !== at && answered(x.id) && drafts[x.id].touched ? 'dot' : i !== at && answered(x.id) ? 'dashed' : 'open'} size={10} />
                  {/* Pointing at a dot shows that question and your answer, so you can check one without leaving this one. */}
                  <span className="iv-step-tip" aria-hidden>
                    <span className="iv-step-q">{x.title}</span>
                    <span className={`iv-step-a${answer ? '' : ' none'}`}>{answer || 'Not answered'}</span>
                  </span>
                </button>
              );
            })}
            </span>
          </nav>
        )}
      {(
      <section key={q.id} ref={qRef} className={`iv-q iv-${dir}`}>
        <div className="iv-text">
        <h1 className="iv-title">{q.title}</h1>
        {q.body && <Markdown className="prose q-body" text={q.body} />}
        {qSound && (
          <button
            className="btn-pill iv-sound"
            onClick={() => (sound.on === qSoundKey ? sound.stop() : sound.play(qSoundKey, filesBase + encodeURIComponent(qSound.audio)))}
          >
            {sound.on === qSoundKey ? <><Pause size={14} /> Stop</> : <><Play size={14} /> Play</>}
          </button>
        )}
        </div>
        <div className="options" role="radiogroup" aria-label={q.title}>
          {q.options.map((o, oi) => {
            const chosen = !d.writing && d.choice === oi;
            return (
              <button
                key={oi}
                role="radio"
                data-oi={oi}
                aria-checked={chosen}
                className={`opt${chosen ? ' chosen' : ''}${chosen && !d.touched ? ' assumed' : ''}`}
                onClick={() => choose(oi, true)}
                onMouseEnter={() => setPeek(`${q.id}:${oi}`)}
                onPointerMove={() => restOn(oi)}
                onMouseLeave={() => { setPeek(null); restOff(oi); }}
                onFocus={() => setPeek(`${q.id}:${oi}`)}
                onBlur={() => setPeek(null)}
              >
                <span className="opt-ring"><Ring kind={chosen ? (d.touched ? 'dot' : 'dashed') : 'open'} size={20} letter={LETTERS[oi]?.toUpperCase()} /></span>
                <span className="opt-text">
                  <span className="opt-label">
                    <span className="opt-name">
                      <span>{o.label}</span>
                      {q.recommended === oi && <span className="opt-rec">Recommended</span>}
                      {sound.on === `${q.id}:${oi}` && <Volume2 className="opt-sounding" size={15} aria-label="Playing" />}
                    </span>
                  </span>
                  {o.description && <span className="opt-desc">{o.description}</span>}
                  {q.recommended === oi && q.recommendation && (
                    <span className="opt-why">
                      <ArrowRight className="opt-why-arrow" size={16} aria-label="Why" />
                      <Markdown className="prose" text={q.recommendation} />
                    </span>
                  )}
                </span>
              </button>
            );
          })}
          {/* What you wrote stays on screen when you pick an option instead, and on every question you come back
              to: pointing into it makes it your answer again. */}
          <div
            className={`opt own${d.writing ? ' chosen' : said(d) ? ' kept' : ''}`}
            onClick={() => { if (!d.writing && said(d)) otherRef.current?.focus(); }}
          >
            {d.writing || said(d) ? (
              <>
                <span className="opt-ring"><Ring kind={d.writing && said(d) ? 'dot' : 'open'} size={20} letter={d.writing ? undefined : 'W'} /></span>
                <div className="own-body">
                <textarea
                  ref={otherRef}
                  className="own-field"
                  rows={2}
                  placeholder="Your answer, or paste a screenshot"
                  value={d.other}
                  onFocus={() => {
                    if (d.writing) return;
                    clearTimeout(advanceTimer.current);
                    set(q.id, { writing: true, choice: null });
                  }}
                  onChange={(e) => set(q.id, { other: e.target.value })}
                  onKeyDown={(e) => {
                    // ⏎ settles the answer and moves on; ⇧⏎ is a new line.
                    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                      e.preventDefault();
                      e.stopPropagation();
                      if (said(d) && !adding) { e.currentTarget.blur(); next(); }
                    }
                  }}
                />
                {(pics(d).length > 0 || adding > 0) && (
                  <div className="own-pics">
                    {pics(d).map((name) => (
                      <span key={name} className="own-pic">
                        <img src={pastedBase + name} alt="Your screenshot" title="Click to see it large" onClick={(e) => { e.stopPropagation(); setZoom(pastedBase + name); }} />
                        <button className="own-pic-x" onClick={(e) => { e.stopPropagation(); unattach(name); }} aria-label="Take the screenshot out" title="Take it out"><X size={12} /></button>
                      </span>
                    ))}
                    {adding > 0 && <span className="own-pic adding" aria-label="Adding a screenshot" />}
                  </div>
                )}
                </div>
              </>
            ) : (
              <button className="own-open" onClick={() => write()}>
                <span className="opt-ring"><Ring kind="open" size={20} letter="W" /></span>
                <span className="opt-label muted">Write your own</span>
              </button>
            )}
          </div>
        </div>
      </section>
      )}
      </div>

      {preview && q && (
        <aside className={`iv-preview${preview.every((p) => 'text' in p || 'markdown' in p || 'html' in p) ? ' fit' : ''}`} aria-label="What this is about">
          <Stage key={`${q.id}:${active}`} shows={preview} base={filesBase} replay={replay} onZoom={setZoom} sound={videoSound} onSound={setVideoSound} />
          {(active != null || live) && (
            <p className="iv-preview-cap">
              {active != null && q.options[active].label}
              {live && <button className="btn-quiet" onClick={() => setReplay((n) => n + 1)}>Replay</button>}
            </p>
          )}
        </aside>
      )}

      {zoom && (
        <div className="zoomed" role="dialog" aria-label="Picture, full size" onClick={() => setZoom(null)}>
          <img src={zoom} alt="" />
        </div>
      )}

      <footer className="decide">
        <div className="decide-in">
          <p className="decide-sentence">
            <Reach item={item} />
            {adding ? 'Adding your screenshot…' : !answered(q.id) ? 'Pick one, or write your own, to go on.' : ''}
          </p>
          <div className="decide-actions">
            <button className="btn-quiet" onClick={() => onDecide(item, { decision: 'drop' })} title="Stop this interview and send nothing">End interview</button>
            {early && (
              <button className="btn-pill lg" onClick={sendNow} title="Send the answers you gave so far. The interview goes on: the agent asks again what is still open, in light of them.">
                Send {givenCount} now <span className="key">⇧⏎</span>
              </button>
            )}
            {at > 0 && <button className="btn-pill lg" onClick={() => go(at - 1)}>Back <span className="key">←</span></button>}
            {last ? (
              // The last question sends the round. If an earlier one is still open, sending takes you to it instead:
              // the bar does not spell it out, the question itself is where you answer it.
              <button className="btn-primary" onClick={send} aria-disabled={!open && !answered(q.id)}>
                {qs.length === 1 ? 'Send answer' : `Send ${qs.length} answers`} <span className="key on-ink">⏎</span>
              </button>
            ) : (
              <button className="btn-primary" onClick={next} aria-disabled={!q || !answered(q.id)}>
                Next <span className="key on-ink">⏎</span>
              </button>
            )}
          </div>
        </div>
      </footer>
    </article>
  );
}

// Your answer as the dots show it: the letter and label you picked, or what you wrote.
function shownAnswer(x: Question, d: Draft): string {
  if (d.writing) return withPics(d.other.trim(), pics(d).length);
  if (d.choice == null) return '';
  const letter = LETTERS[d.choice]?.toUpperCase();
  return `${letter ? `${letter}  ` : ''}${x.options[d.choice]?.label ?? ''}`;
}

// An earlier round's answer, as the dots show it.
function pastAnswer(x: Question, a?: Answer): string {
  if (!a) return 'Not answered';
  if (a.other || a.images?.length) return withPics(a.other || '', a.images?.length ?? 0);
  return a.choice != null ? x.options[a.choice]?.label ?? '' : 'Not answered';
}

const withPics = (text: string, n: number) => (n ? `${text}${text ? ' + ' : ''}${n === 1 ? 'a screenshot' : `${n} screenshots`}` : text);

/** A picture as base64, without the data: prefix. */
function base64(f: File): Promise<string> {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => fail(new Error('That picture could not be read.'));
    r.readAsDataURL(f);
  });
}

// Options are picked by letter, a to i; j, k, l and w already have jobs here.
const LETTERS = 'abcdefghi';


function answerOf(x: Question, d: Draft): Answer {
  return d.writing
    ? { id: x.id, choice: null, other: d.other.trim(), ...(pics(d).length ? { images: pics(d) } : {}) }
    : { id: x.id, choice: d.choice, accepted: !d.touched && d.choice === x.recommended };
}

const isSound = (s: Show): s is Extract<Show, { audio: string }> => 'audio' in s;
// What a question or an option has to look at, leaving its sounds out; null when there is nothing.
const seen = (shows?: Show[]) => { const v = shows?.filter((s) => !isSound(s)); return v?.length ? v : null; };

/** One sound at a time: a new one cuts in, and `on` names what is playing until it ends. */
function useSound() {
  const el = useRef<HTMLAudioElement | null>(null);
  const [on, setOn] = useState<string | null>(null);
  const done = (a: HTMLAudioElement) => { if (el.current === a) { el.current = null; setOn(null); } };
  const play = (key: string, src: string) => {
    el.current?.pause();
    const a = new Audio(src);
    el.current = a;
    a.onended = () => done(a);
    setOn(key);
    a.play().catch(() => done(a));
  };
  const stop = () => { if (el.current) { el.current.pause(); done(el.current); } };
  useEffect(() => () => el.current?.pause(), []);
  return { on, play, stop };
}

const KIND = (s: Show) => ('video' in s ? 'Recording' : 'file' in s ? 'Code' : 'url' in s ? 'Live' : 'html' in s ? 'Example' : 'Copy');

/** The panel's contents. Several things are shown one at a time, large, with a strip under them to pick from. */
function Stage({ shows, base, replay, onZoom, sound, onSound }: { shows: Show[]; base: string; replay: number; onZoom: (src: string) => void; sound: boolean; onSound: (on: boolean) => void }) {
  const [at, setAt] = useState(0);
  const s = shows[Math.min(at, shows.length - 1)];
  return (
    <>
      <div className={`iv-preview-stage${'file' in s ? ' top' : ''}`}>
        <Shown key={`${at}:${replay}`} show={s} base={base} onZoom={onZoom} sound={sound} onSound={onSound} />
      </div>
      {shows.length > 1 && (
        <nav className="iv-strip" aria-label="What to look at">
          {shows.map((x, i) => (
            <button key={i} className={`iv-thumb${i === at ? ' here' : ''}`} onClick={() => setAt(i)} aria-current={i === at} aria-label={`${i + 1} of ${shows.length}`}>
              {'image' in x ? <img src={base + encodeURIComponent(x.image)} alt="" /> : <span>{KIND(x)}</span>}
            </button>
          ))}
        </nav>
      )}
    </>
  );
}

// The example reports its height, so the frame around it is as tall as it is (min 200px) rather than the panel.
const FRAME = '<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><style>body{margin:0;padding:32px;box-sizing:border-box;display:grid;place-items:center;font:14px/1.5 system-ui,sans-serif}</style>'
  + '<script>addEventListener("load",()=>{const say=()=>parent.postMessage({batesonHeight:document.documentElement.scrollHeight},"*");new ResizeObserver(say).observe(document.body);say()})</script>';

/** One thing a question or an option is about: the image, or the lines, the agent sent along with it. */
function Shown({ show: s, base, onZoom, sound, onSound }: { show: Show; base: string; onZoom: (src: string) => void; sound: boolean; onSound: (on: boolean) => void }) {
  if ('image' in s) {
    const src = base + encodeURIComponent(s.image);
    return <img src={src} alt="" title="Click to see it large" onClick={() => onZoom(src)} />;
  }
  if ('video' in s) return <Video src={base + encodeURIComponent(s.video)} sound={sound} onSound={onSound} />;
  if ('markdown' in s) return <Markdown className="prose shown-copy" text={s.markdown} />;
  if ('text' in s) return <div className="prose plain shown-copy">{s.text}</div>;
  if ('html' in s) return <Example html={s.html} />;
  if ('url' in s) {
    // Another page on this machine keeps its own origin in the frame. bateson's own origin never does: with scripts
    // and its origin together, a page there could reach out of the frame into bateson.
    let own = true;
    // (127.0.0.1 and [::1] on bateson's port are bateson too, by another name.)
    try { const u = new URL(s.url); own = !/^https?:$/.test(u.protocol) || u.origin === location.origin || (u.port || '80') === (location.port || '80'); } catch { /* not a URL: treated as ours */ }
    return <iframe className="shown-live" src={s.url} title="Live preview" sandbox={own ? 'allow-scripts allow-forms' : 'allow-scripts allow-same-origin allow-forms'} />;
  }
  if ('audio' in s) return null; // heard on its option or the question, never in the panel
  return <Lines show={s} />;
}

/** A component example: the agent's markup runs in a sandbox with no access to bateson, in the system's light or dark. */
function Example({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [h, setH] = useState(0);
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.source === ref.current?.contentWindow && typeof e.data?.batesonHeight === 'number') setH(e.data.batesonHeight);
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, []);
  return <iframe ref={ref} className="shown-live" srcDoc={FRAME + html} title="Example" sandbox="allow-scripts" style={{ '--fit-h': `${Math.max(200, h)}px` } as React.CSSProperties} />;
}

// highlight.js is a third of the app's library code, and only lines shown with a question use it: it is fetched
// the first time some are, and they show plain until it arrives (a moment, from this machine).
let highlighter: typeof import('./lib/highlight') | null = null;
let fetching: Promise<void> | null = null;

/** Lines of a file, in colour. Coloured once per excerpt, not on every keystroke in the answer below them. */
function Lines({ show: s }: { show: Extract<Show, { lines: string[] }> }) {
  const [, arrived] = useState(!!highlighter);
  useEffect(() => {
    if (!highlighter) (fetching ??= import('./lib/highlight').then((m) => { highlighter = m; })).then(() => arrived(true), () => {});
  }, []);
  const hl = highlighter;
  const html = useMemo(() => s.lines.map((l) => (l && hl ? hl.highlightLine(s.file, l) : null)), [s.file, s.lines, hl]);
  return (
    <figure className="shown-text">
      <figcaption className="rec">{s.file}</figcaption>
      <div className="fd-code" aria-label={`${s.file} from line ${s.start}`}>
        {s.lines.map((l, k) => (
          <div key={k} className="fd-line" data-n={s.start + k}>
            {html[k] != null ? <code dangerouslySetInnerHTML={{ __html: html[k]! }} /> : <code>{l || '\u200b'}</code>}
          </div>
        ))}
      </div>
    </figure>
  );
}

/** A recording, with a quiet timeline: play or pause, drag to any moment, and the seconds. It plays once as it appears,
 * muted until you turn its sound on. */
function Video({ src, sound, onSound }: { src: string; sound: boolean; onSound: (on: boolean) => void }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  // Set on the element: React's muted prop only takes effect when the video first mounts.
  useEffect(() => { if (ref.current) ref.current.muted = !sound; }, [sound]);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  const [playing, setPlaying] = useState(false);

  // The timeline moves with the frames while it plays, not four times a second.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => { if (ref.current) setT(ref.current.currentTime); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const toggle = () => {
    const v = ref.current;
    if (!v) return;
    if (v.paused) { if (v.ended || v.currentTime >= v.duration) v.currentTime = 0; void v.play().catch(() => {}); } else v.pause();
  };
  const seek = (to: number) => { if (ref.current) { ref.current.currentTime = to; setT(to); } };

  return (
    <figure className="shown-video">
      <video
        ref={ref} src={src} muted playsInline autoPlay preload="auto" onClick={toggle}
        onLoadedMetadata={(e) => setDur(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)}
        onDurationChange={(e) => setDur(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
        onEnded={(e) => { setPlaying(false); setT(e.currentTarget.duration); }}
        onSeeked={(e) => setT(e.currentTarget.currentTime)}
      />
      <figcaption className="vid-bar">
        <button className="btn-icon" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>{playing ? <Pause size={16} /> : <Play size={16} />}</button>
        <input
          className="vid-line" type="range" min={0} max={dur || 1} step={0.01} value={Math.min(t, dur || 1)} aria-label="Timeline"
          style={{ '--at': `${dur ? (t / dur) * 100 : 0}%` } as React.CSSProperties}
          onChange={(e) => seek(Number(e.target.value))} onPointerUp={(e) => e.currentTarget.blur()}
        />
        <span className="rec vid-time">{t.toFixed(1)} / {dur.toFixed(1)}s</span>
        <button className="btn-icon" onClick={() => onSound(!sound)} aria-label={sound ? 'Turn sound off' : 'Turn sound on'} aria-pressed={sound}>
          {sound ? <Volume2 size={16} /> : <VolumeX size={16} />}
        </button>
      </figcaption>
    </figure>
  );
}
