// The console header, mounted once: logo + clock line, sync light, the
// quick-add terminal (the hero), the "just 5 min" clock widget, and the vitals strip.
// The quick-add input is never rebuilt, so typing survives every re-render.
import { h, s, mount, catStyle } from '../dom.js';
import { icon } from '../icons.js';
import { parseQuickAdd } from '../../engine/parse.js';
import { dayTag } from './taskrow.js';
import { fmtDay, fmtElapsed, fmtMinutes, fmtTime, fmtWeekday, isISODate } from '../../engine/dates.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const up = (x) => String(x ?? '').toUpperCase();
const pad2 = (n) => String(Math.max(0, n | 0)).padStart(2, '0');
const RING_SEGMENTS = 24;

const SYNC = {
  synced: { label: 'SYNCED', tone: 'acid' },
  saving: { label: 'SAVING…', tone: 'cyan', blink: true },
  pending: { label: 'PENDING', tone: 'hazard' },
  offline: { label: 'OFFLINE', tone: 'blood' },
  error: { label: 'ERROR', tone: 'blood' },
  readonly: { label: 'READ-ONLY', tone: 'ink' },
  conflict: { label: 'MERGING', tone: 'hazard', blink: true },
  loading: { label: 'LOADING', tone: 'cyan', blink: true },
};

const HINTS = ['- tmrw', 'by fri', '~30m', 'at 3pm', '#rsa', '!', 'daily'];

function isTyping(target) {
  if (!target || typeof target !== 'object') return false;
  const tag = String(target.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable === true;
}

function cadence(rec) {
  if (!rec || typeof rec !== 'object') return '';
  const every = isNum(rec.every) ? rec.every : 1;
  const per = isNum(rec.perDay) ? rec.perDay : 1;
  if (every === 1) return per > 1 ? `DAILY ×${per}` : 'DAILY';
  if (every === 7) return 'WEEKLY';
  return `EVERY ${every}D`;
}

function chip(text, tone, iconName, extra = {}) {
  return h('span.chip', { class: tone ? `chip-${tone}` : '', ...extra }, iconName ? icon(iconName) : null, text);
}

export function mountHeader(el, ctx) {
  let cur = ctx;
  let busy = false;
  const history = [];
  let histIdx = -1;
  let vitalsSig = '';
  let clockSig = '';
  let syncSig = '';
  let ring = null;
  let clockTimeEl = null;
  let clockEl = null;
  let clockLabelEl = null;
  const fmtCache = new Map();

  // ------------------------------------------------------------ top bar
  const logo = h('h1.hdr-logo',
    h('span.glitch', { 'data-text': 'EF//CONSOLE' }, 'EF', h('span.hdr-logo-slash', '//'), 'CONSOLE'),
  );
  const modeTag = h('span.hdr-mode');
  const sub = h('p.hdr-sub', { 'aria-live': 'off' });
  const syncLabel = h('span.hdr-sync-label');
  const syncBtn = h('button.hdr-sync', { type: 'button', title: 'Refresh now', onclick: () => cur.store?.refresh?.() },
    h('i.led', { 'aria-hidden': 'true' }), syncLabel);
  const connect = h('a.hdr-connect', { href: '#setup' }, icon('key'), 'Connect');

  // ------------------------------------------------------------ quick-add terminal
  const input = h('input#ef-quickadd.term-input', {
    type: 'text',
    autocomplete: 'off',
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    enterkeyhint: 'done',
    placeholder: 'email mike - tomorrow',
    'aria-label': 'Quick add a to-do',
    'aria-describedby': 'ef-qa-preview',
  });
  const preview = h('div#ef-qa-preview.term-preview', { 'aria-live': 'polite' });
  const goBtn = h('button.btn.btn-hot.term-go', { type: 'submit', 'aria-label': 'Add to-do' }, h('span', 'Add'), icon('enter'));
  const form = h('form.term', { autocomplete: 'off', 'aria-label': 'Quick add' },
    h('div.term-bar', { 'aria-hidden': 'true' },
      h('span.term-dots', h('i'), h('i'), h('i')),
      h('span.term-path', 'danny@ef-console:~/todo$'),
      h('span.term-keys', h('kbd', '/'), ' focus ', h('kbd', '↑'), ' last ', h('kbd', '↵'), ' add'),
    ),
    h('div.term-line',
      h('label.term-prompt', { for: 'ef-quickadd', 'aria-hidden': 'true' }, '>'),
      h('div.term-field', input, h('span.term-cursor', { 'aria-hidden': 'true' })),
      goBtn,
    ),
    preview,
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
  input.addEventListener('input', () => {
    histIdx = -1;
    renderPreview();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (input.value) {
        input.value = '';
        renderPreview();
      } else input.blur();
      e.stopPropagation();
    } else if (e.key === 'ArrowUp' && history.length && (!input.value || histIdx >= 0)) {
      e.preventDefault();
      histIdx = Math.min(history.length - 1, histIdx + 1);
      input.value = history[histIdx];
      renderPreview();
    } else if (e.key === 'ArrowDown' && histIdx >= 0) {
      e.preventDefault();
      histIdx -= 1;
      input.value = histIdx >= 0 ? history[histIdx] : '';
      renderPreview();
    }
  });

  function parse(text) {
    try {
      return parseQuickAdd(text, { today: cur.today, now: cur.now, cats: cur.state?.cats, settings: cur.state?.settings });
    } catch (err) {
      if (typeof console !== 'undefined') console.error(err);
      return null;
    }
  }

  function renderPreview() {
    const text = input.value;
    form.classList.toggle('has-text', !!text);
    if (!text.trim()) {
      mount(preview,
        h('span.qa-arrow', '└─'),
        h('span.qa-hint', 'try'),
        HINTS.map((x) => h('code.qa-tok', x)),
      );
      return;
    }
    const p = parse(text);
    if (!p) {
      mount(preview, h('span.qa-arrow', '└─'), chip('PARSE ERROR', 'crit'));
      return;
    }
    const parts = [h('span.qa-arrow', '└─')];
    parts.push(h('span.qa-title', p.title ? p.title : h('span.faint', 'needs a title')));
    if (!cur.loaded) {
      // Categories aren't known yet: "#rsa" would read as a brand-new category.
      parts.push(chip('LOADING BOARD…', '', null, { title: 'Your categories are still loading from GitHub.' }));
    } else if (p.newCatName) parts.push(chip(`NEW CATEGORY: ${p.newCatName}`, 'hot', 'plus'));
    else {
      const parsedInbox = !p.cat || p.cat === 'inbox';
      // A recurring line becomes a chore, and an unfiled chore goes under Home (ops.addChore).
      const catId = parsedInbox && p.recurring && cur.state?.cats?.home ? 'home' : p.cat;
      const cat = typeof cur.cat === 'function' ? cur.cat(catId) : cur.state?.cats?.[catId];
      const isInbox = !catId || catId === 'inbox';
      const unsure = !parsedInbox && isNum(p.catConfidence) && p.catConfidence < 0.75;
      parts.push(h('span.chip.qa-cat', {
        class: isInbox ? 'is-inbox' : '',
        style: catStyle(cat),
        title: isInbox
          ? 'No category matched. Add #tag to file it.'
          : parsedInbox ? 'Chores without a #tag go under Home.' : `Filed by ${p.catReason || 'match'}`,
      }, h('i.catdot', { style: catStyle(cat) }), up(cat?.name ?? catId ?? 'Inbox'), unsure ? '?' : ''));
    }
    if (p.recurring) parts.push(chip(`${cadence(p.recurring)} CHORE`, 'acid', 'repeat'));
    if (p.plan) parts.push(chip(`DO ${up(fmtDay(p.plan))}`, 'cyan', 'calendar'));
    if (p.due) parts.push(chip(`DUE ${up(fmtDay(p.due))}`, 'hot', 'diamond'));
    if (p.time) parts.push(chip(up(fmtTime(p.time)), 'cyan', 'clock'));
    if (isNum(p.est) && p.est > 0) parts.push(chip(`~${up(fmtMinutes(p.est))}`, '', 'hourglass'));
    if (p.prio === 3) parts.push(chip('CRIT', 'crit'));
    else if (p.prio === 2) parts.push(chip('HIGH', 'hot'));
    else if (p.prio === 0) parts.push(chip('LOW', ''));
    if (p.kind === 'meeting' || p.kind === 'appt') parts.push(chip(up(p.kind === 'appt' ? 'appt' : 'meeting'), ''));
    if (!p.plan && !p.due && !p.recurring) parts.push(chip('BACKLOG', '', 'inbox', { title: 'No date: it goes to the backlog' }));
    mount(preview, parts);
  }

  async function submit() {
    if (busy) return;
    const text = input.value.trim();
    if (!text) {
      input.focus();
      form.classList.remove('is-nudge');
      void form.offsetWidth;
      form.classList.add('is-nudge');
      return;
    }
    const p = parse(text);
    if (!p || !p.title) {
      cur.toast?.('Needs a title. Try: email mike - tomorrow', { kind: 'error' });
      return;
    }
    const fields = {
      title: p.title, due: p.due, plan: p.plan, time: p.time, est: p.est, prio: p.prio,
      cat: p.cat, kind: p.kind, newCatName: p.newCatName, recurring: p.recurring,
    };
    busy = true;
    form.classList.add('is-busy');
    let res = null;
    try {
      res = await cur.act('addTask', fields);
    } finally {
      busy = false;
      form.classList.remove('is-busy');
    }
    if (!res) return; // act already explained (read-only, still loading, error); the text stays
    const writes = arr(res.writes);
    if (!writes.length) {
      const dup = res.duplicateOf ? cur.state?.chores?.[res.duplicateOf] : null;
      if (dup) {
        cur.toast?.(`Already tracking that chore: ${dup.title}.`, { kind: 'info' });
        input.value = '';
        renderPreview();
      } else cur.toast?.("Didn't add anything (empty title?).", { kind: 'error' });
      return;
    }
    if (history[0] !== text) history.unshift(text);
    if (history.length > 25) history.length = 25;
    histIdx = -1;
    input.value = '';
    renderPreview();
    form.classList.remove('is-added');
    void form.offsetWidth;
    form.classList.add('is-added');
    setTimeout(() => form.classList.remove('is-added'), 700);

    const taskW = writes.find((w) => w.col === 'tasks' && w.op === 'set');
    const choreW = writes.find((w) => w.col === 'chores' && w.op === 'set');
    const catW = writes.find((w) => w.col === 'cats' && w.op === 'set');
    const newCat = catW ? ` · new category ${catW.data?.name ?? ''}` : '';
    if (choreW) {
      cur.toast?.(`New chore: ${choreW.data?.title ?? p.title} (${cadence(p.recurring).toLowerCase()})${newCat}`, {
        kind: 'good',
        action: { label: 'Undo', fn: () => cur.act('deleteChore', { id: choreW.id }, { toast: 'Removed.', kind: 'info' }) },
      });
    } else if (taskW) {
      const t = taskW.data ?? {};
      const when = t.plan ? fmtDay(t.plan) : t.due ? `due ${fmtDay(t.due)}` : 'backlog';
      const at = t.time ? ` ${fmtTime(t.time)}` : '';
      cur.toast?.(`Added: ${t.title ?? p.title} → ${when}${at}${newCat}`, {
        kind: 'good',
        action: { label: 'Undo', fn: () => cur.act('deleteTask', { id: taskW.id }, { toast: 'Removed.', kind: 'info' }) },
      });
    }
  }

  // global keys: "/" or Ctrl/Cmd+K focuses the terminal
  document.addEventListener('keydown', (e) => {
    const k = String(e.key || '').toLowerCase();
    if ((e.metaKey || e.ctrlKey) && k === 'k') {
      e.preventDefault();
      input.focus();
      input.select();
    } else if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target) && !document.querySelector('.overlay-root')) {
      e.preventDefault();
      input.focus();
    }
  });

  // ------------------------------------------------------------ clock widget + vitals
  const clockSlot = h('div.hdr-clock');
  const vitalsSlot = h('div.hdr-vitals', { role: 'group', 'aria-label': 'Vitals' });

  // ------------------------------------------------------------ assemble
  mount(el,
    h('div.hdr-top',
      h('div.hdr-logo-row', logo, modeTag),
      h('div.hdr-status', syncBtn, connect),
      sub,
    ),
    h('div.hdr-main', form, clockSlot),
    vitalsSlot,
  );
  renderPreview();

  // ------------------------------------------------------------ pieces that update
  function tzFormat(tz) {
    let f = fmtCache.get(tz);
    if (!f) {
      try {
        f = {
          time: new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }),
          zone: new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }),
        };
      } catch {
        f = {
          time: new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }),
          zone: null,
        };
      }
      fmtCache.set(tz, f);
    }
    return f;
  }

  function timeLine(c) {
    const owner = up(c.state?.settings?.owner || 'Danny');
    const today = isISODate(c.today) ? c.today : null;
    const day = today ? `${up(fmtWeekday(today))} ${today.slice(5, 7)}.${today.slice(8, 10)}` : '--';
    const f = tzFormat(c.tz || 'America/New_York');
    const now = new Date();
    let clock = '--:--:--';
    let zone = '';
    try {
      clock = f.time.format(now).replace(/^24/, '00');
      const z = f.zone ? f.zone.formatToParts(now).find((x) => x.type === 'timeZoneName')?.value ?? '' : '';
      zone = /^([A-Z])[SD]T$/.test(z) ? `${z[0]}T` : z;
    } catch { /* keep defaults */ }
    return [owner, day, `${clock}${zone ? ' ' + zone : ''}`];
  }

  function renderSub(c) {
    const [owner, day, clock] = timeLine(c);
    mount(sub, h('span', owner), h('span.sep', '//'), h('span', day), h('span.sep', '//'), h('span.hdr-time', clock));
  }

  function renderSync(c) {
    const kind = c.store?.status?.kind || (c.loaded ? 'synced' : 'loading');
    const mode = c.store?.mode || 'readonly';
    const sig = `${kind}|${mode}|${c.store?.status?.message ?? ''}|${c.store?.status?.at ?? ''}|${!!c.loaded}|${c.store?.canWrite}`;
    if (sig === syncSig) return;
    syncSig = sig;
    const def = SYNC[kind] ?? { label: up(kind), tone: 'ink' };
    const label = kind === 'synced' && mode === 'local' ? 'SAVED LOCAL' : def.label;
    syncBtn.className = `hdr-sync tone-${def.tone}${def.blink ? ' is-blink' : ''}`;
    syncLabel.textContent = label;
    const msg = c.store?.status?.message;
    const at = c.store?.status?.at;
    let when = '';
    if (at) {
      try {
        when = new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      } catch { /* ignore */ }
    }
    syncBtn.title = [msg, when && `at ${when}`, 'click to refresh'].filter(Boolean).join(' · ');
    connect.hidden = !(kind === 'readonly' || mode === 'readonly');
    const modeText = mode === 'github' ? 'LIVE' : mode === 'local' ? 'PREVIEW' : 'READ-ONLY';
    modeTag.textContent = modeText;
    modeTag.className = `hdr-mode is-${mode}`;
    input.setAttribute('placeholder', c.store?.canWrite === false
      ? 'read-only: connect GitHub in Setup to add'
      : c.loaded ? 'email mike - tomorrow' : 'loading your board…');
  }

  function vitalCell(key, label, valueEl, extra, { tone = '', title = '' } = {}) {
    return h('div.vital', { class: `v-${key}${tone ? ' is-' + tone : ''}`, title: title || null },
      key === 'overdue' && tone === 'crit' ? h('div.hazard.vital-hazard', { 'aria-hidden': 'true' }) : null,
      h('span.label.is-bracket', label),
      h('div.vital-val', valueEl),
      extra ?? null,
    );
  }

  function renderVitals(c) {
    const vt = c.vm?.today ?? {};
    const doneN = arr(vt.doneToday).length;
    const open = isNum(vt.counts?.open) ? vt.counts.open : 0;
    const total = Math.max(doneN + open, isNum(vt.counts?.total) ? vt.counts.total : 0);
    const overdue = arr(vt.overdue).length;
    const triage = arr(vt.triage).length;
    const dl = arr(c.vm?.deadlines);
    const due7 = dl.filter((x) => isNum(x?.daysLeft) && x.daysLeft >= 0 && x.daysLeft <= 7);
    const next = due7[0]?.task;
    const load = arr(c.vm?.cal)[0]?.load ?? null;
    const loadTotal = isNum(load?.total) ? load.total : 0;
    const cap = isNum(load?.cap) ? load.cap : 0;
    const streak = isNum(c.vm?.streak?.current) ? c.vm.streak.current : 0;
    const best = isNum(c.vm?.streak?.best) ? c.vm.streak.best : streak;
    const loaded = !!c.loaded;
    const sig = JSON.stringify([loaded, doneN, total, overdue, triage, due7.length, next?.id, next?.due, loadTotal, cap, streak, best, c.today]);
    if (sig === vitalsSig) return;
    vitalsSig = sig;
    if (!loaded) {
      mount(vitalsSlot, ['Today', 'Overdue', 'Due 7d', 'Load', 'Streak'].map((l, i) =>
        vitalCell(['today', 'overdue', 'due7', 'load', 'streak'][i], l, h('span.shout.vital-num.is-dim', '--'))));
      return;
    }
    const ratio = cap > 0 ? loadTotal / cap : loadTotal > 0 ? 2 : 0;
    const loadTone = ratio > 1.3 ? 'crit' : ratio > 1 ? 'hot' : '';
    const pct = total ? Math.round((100 * doneN) / total) : 0;
    mount(vitalsSlot,
      vitalCell('today', 'Today',
        [h('span.shout.vital-num', h('b', String(doneN)), h('span.vital-of', '/'), String(total)), h('span.vital-unit', 'done')],
        h('div.meter', { class: doneN >= total && total ? '' : 'is-cyan', role: 'meter', 'aria-label': 'Done today', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(doneN) },
          h('i', { style: { width: `${pct}%` } })),
        { title: `${doneN} of ${total} done today` }),
      vitalCell('overdue', 'Overdue',
        [h('span.shout.vital-num', pad2(overdue)), h('span.vital-unit', overdue ? 'late' : 'clear')],
        triage ? h('span.vital-sub', `+${triage} to triage`) : h('span.vital-sub', overdue ? 'push or drop. no guilt.' : 'nothing late'),
        { tone: overdue ? 'crit' : '' }),
      vitalCell('due7', 'Due 7d',
        [h('span.shout.vital-num', pad2(due7.length)), h('span.vital-unit', 'due')],
        h('span.vital-sub', next ? `next: ${dayTag(next.due, c.today).toLowerCase()} · ${next.title ?? ''}` : 'clear week'),
        { tone: due7.some((x) => x.daysLeft <= 1) ? 'hot' : '' }),
      vitalCell('load', 'Load',
        [h('span.shout.vital-num', fmtMinutes(loadTotal)), h('span.vital-unit', `/ ${fmtMinutes(cap)}`)],
        h('div.meter', { class: loadTone ? `is-${loadTone === 'crit' ? 'crit' : 'hot'}` : 'is-cyan', role: 'meter', 'aria-label': 'Planned load today', 'aria-valuemin': '0', 'aria-valuemax': String(cap), 'aria-valuenow': String(loadTotal) },
          h('i', { style: { width: `${Math.min(100, Math.round(ratio * 100))}%` } })),
        { tone: loadTone, title: `${fmtMinutes(loadTotal)} planned of ${fmtMinutes(cap)} focus time today` }),
      vitalCell('streak', 'Streak',
        [h('span.shout.vital-num', String(streak)), h('span.vital-unit', streak === 1 ? 'day' : 'days')],
        h('span.vital-sub', `best ${best}`),
        { tone: streak > 0 ? 'acid' : '' }),
    );
  }

  function buildRing() {
    const segs = [];
    for (let i = 0; i < RING_SEGMENTS; i++) {
      segs.push(s('rect', { x: 30.5, y: 3, width: 3, height: 8, transform: `rotate(${(360 / RING_SEGMENTS) * i} 32 32)`, class: 'seg' }));
    }
    return s('svg', { class: 'clk-ring', viewBox: '0 0 64 64', width: 64, height: 64, 'aria-hidden': 'true' }, ...segs);
  }

  function clockProgress(c) {
    const clock = c.state?.clock;
    const startMs = Date.parse(clock?.start ?? '');
    const goal = isNum(clock?.goal) && clock.goal > 0 ? clock.goal : 5;
    const ms = Number.isFinite(startMs) ? Math.max(0, Date.now() - startMs) : 0;
    return { ms, goal, over: ms >= goal * 60000, frac: Math.min(1, ms / (goal * 60000)) };
  }

  function paintClock(c) {
    if (!clockEl || !c.state?.clock?.active) return;
    const { ms, goal, over, frac } = clockProgress(c);
    if (clockTimeEl) clockTimeEl.textContent = fmtElapsed(ms);
    clockEl.classList.toggle('is-over', over);
    if (clockLabelEl) clockLabelEl.textContent = over ? `${goal} min done. keep going?` : `clocked in · goal ${goal} min`;
    if (ring) {
      const lit = Math.round(frac * RING_SEGMENTS);
      ring.querySelectorAll('.seg').forEach((seg, i) => seg.classList.toggle('on', i < lit));
    }
  }

  function renderClock(c) {
    const clock = c.state?.clock;
    const sig = JSON.stringify(clock && clock.active ? clock : { active: false });
    if (sig === clockSig) return;
    clockSig = sig;
    ring = null;
    clockTimeEl = null;
    clockLabelEl = null;
    if (!clock || !clock.active) {
      clockEl = null;
      mount(clockSlot, h('button.clk-start', { type: 'button', onclick: () => cur.openClock?.() },
        h('span.clk-start-icon', icon('play')),
        h('span.clk-start-text', h('span.clk-start-big', 'Just 5 min'), h('span.clk-start-sub', 'pick anything. start the clock.')),
      ));
      return;
    }
    const cat = typeof c.cat === 'function' ? c.cat(clock.cat) : null;
    ring = buildRing();
    clockTimeEl = h('span.clk-time.shout', '00:00');
    clockLabelEl = h('span.clk-label');
    const isTask = String(clock.ref || '').startsWith('task:');
    const stop = () => cur.act('clockOut', { markDone: false }, { toast: 'Clock stopped. Time logged.' });
    const done = () => {
      cur.fx?.burst?.(clockEl, 'var(--acid)');
      cur.fx?.stamp?.(clockEl, 'DONE');
      cur.act('clockOut', { markDone: true }, { toast: isTask ? 'Logged and checked off. Nice.' : 'Logged. Nice.' });
    };
    clockEl = h('div.clk', { role: 'timer', 'aria-label': `Clocked in on ${clock.title}` },
      h('div.clk-dial', ring, h('span.clk-dial-icon', icon('clock'))),
      h('div.clk-info',
        clockLabelEl,
        h('p.clk-title', h('i.catdot', { style: catStyle(cat) }), h('span', clock.title || 'Focus')),
        clockTimeEl,
      ),
      h('div.clk-btns',
        h('button.btn.btn-sm.clk-stop', { type: 'button', onclick: stop }, icon('stop'), 'Stop'),
        h('button.btn.btn-sm.btn-acid.clk-done', { type: 'button', onclick: done }, icon('check'), 'Done'),
      ),
    );
    mount(clockSlot, clockEl);
    paintClock(c);
  }

  function update(c) {
    cur = c;
    el.classList.toggle('is-loading', !c.loaded);
    renderSub(c);
    renderSync(c);
    renderVitals(c);
    renderClock(c);
    if (input.value) renderPreview();
  }

  function tick(c) {
    cur = c;
    renderSub(c);
    paintClock(c);
  }

  update(ctx);
  return { update, tick };
}
