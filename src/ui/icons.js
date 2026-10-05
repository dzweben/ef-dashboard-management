// Inline SVG icon set: 24px grid, stroke 2, square caps, miter joins.
// icon(name) returns a fresh <svg> every call (safe to append anywhere).
// Unknown names render a plain square so a typo never breaks a view.
import { s } from './dom.js';

// Each icon is a list of [tag, attrs]. Shapes are stroked with currentColor
// unless an entry sets its own fill.
const P = (d, extra) => ['path', { d, ...extra }];
const L = (x1, y1, x2, y2) => ['line', { x1, y1, x2, y2 }];
const R = (x, y, width, height, extra) => ['rect', { x, y, width, height, ...extra }];
const C = (cx, cy, r, extra) => ['circle', { cx, cy, r, ...extra }];
const PL = (points) => ['polyline', { points }];
const PG = (points, extra) => ['polygon', { points, ...extra }];
const FILL = { fill: 'currentColor', stroke: 'none' };

const ICONS = {
  // tabs
  bolt: [PG('13 2 4 14 11 14 10 22 20 9 13 9 13 2')],
  calendar: [R(3, 5, 18, 16), L(3, 10, 21, 10), L(8, 2, 8, 7), L(16, 2, 16, 7), R(7, 14, 3, 3, FILL)],
  folder: [P('M3 5h7l2 3h9v12H3z'), L(3, 11, 21, 11)],
  trophy: [P('M7 3h10v6a5 5 0 0 1-10 0z'), P('M7 5H3v2a4 4 0 0 0 4 4'), P('M17 5h4v2a4 4 0 0 1-4 4'), L(12, 14, 12, 18), P('M7 21h10v-3H7z')],
  list: [L(9, 6, 21, 6), L(9, 12, 21, 12), L(9, 18, 21, 18), R(3, 5, 2, 2, FILL), R(3, 11, 2, 2, FILL), R(3, 17, 2, 2, FILL)],
  settings: [L(3, 6, 12, 6), L(18, 6, 21, 6), L(3, 12, 6, 12), L(12, 12, 21, 12), L(3, 18, 14, 18), L(20, 18, 21, 18), R(12, 4, 6, 4), R(6, 10, 6, 4), R(14, 16, 6, 4)],

  // actions
  check: [PL('4 12 9 17 20 6')],
  x: [L(6, 6, 18, 18), L(18, 6, 6, 18)],
  plus: [L(12, 5, 12, 19), L(5, 12, 19, 12)],
  minus: [L(5, 12, 19, 12)],
  'arrow-right': [L(4, 12, 19, 12), PL('13 6 19 12 13 18')],
  'arrow-left': [L(20, 12, 5, 12), PL('11 6 5 12 11 18')],
  'arrow-up': [L(12, 20, 12, 5), PL('6 11 12 5 18 11')],
  'arrow-down': [L(12, 4, 12, 19), PL('6 13 12 19 18 13')],
  'arrow-up-right': [L(6, 18, 18, 6), PL('8 6 18 6 18 16')],
  push: [L(3, 12, 15, 12), PL('10 7 15 12 10 17'), L(20, 4, 20, 20)],
  'chevron-down': [PL('6 9 12 15 18 9')],
  'chevron-up': [PL('6 15 12 9 18 15')],
  'chevron-right': [PL('9 6 15 12 9 18')],
  'chevron-left': [PL('15 6 9 12 15 18')],
  play: [PG('7 4 20 12 7 20 7 4')],
  pause: [R(6, 5, 4, 14), R(14, 5, 4, 14)],
  stop: [R(6, 6, 12, 12)],
  edit: [P('M4 20h4L19 9l-4-4L4 16z'), L(13, 7, 17, 11)],
  trash: [L(4, 7, 20, 7), P('M9 7V3h6v4'), P('M6 7l1 14h10l1-14'), L(10, 11, 10, 17), L(14, 11, 14, 17)],
  undo: [PL('9 5 4 10 9 15'), P('M4 10h11a5 5 0 0 1 0 10h-4')],
  redo: [PL('15 5 20 10 15 15'), P('M20 10H9a5 5 0 0 0 0 10h4')],
  refresh: [P('M20 12a8 8 0 1 1-2.34-5.66'), PL('20 3 20 9 14 9')],
  repeat: [P('M4 11V8h14'), PL('15 5 18 8 15 11'), P('M20 13v3H6'), PL('9 19 6 16 9 13')],
  enter: [P('M20 4v8H5'), PL('10 7 5 12 10 17')],
  search: [C(10, 10, 6), L(15, 15, 21, 21)],
  drag: [R(8, 5, 2, 2, FILL), R(14, 5, 2, 2, FILL), R(8, 11, 2, 2, FILL), R(14, 11, 2, 2, FILL), R(8, 17, 2, 2, FILL), R(14, 17, 2, 2, FILL)],
  more: [R(4, 11, 2, 2, FILL), R(11, 11, 2, 2, FILL), R(18, 11, 2, 2, FILL)],
  external: [P('M14 4h6v6'), L(20, 4, 11, 13), P('M18 14v6H4V6h6')],
  link: [P('M10 14l4-4'), P('M8 11l-3 3a3 3 0 0 0 4 4l3-3'), P('M16 13l3-3a3 3 0 0 0-4-4l-3 3')],
  send: [PG('3 11 21 3 13 21 11 13 3 11'), L(11, 13, 21, 3)],
  menu: [L(3, 6, 21, 6), L(3, 12, 21, 12), L(3, 18, 21, 18)],
  eye: [P('M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z'), C(12, 12, 3)],
  lock: [R(5, 11, 14, 10), P('M8 11V7a4 4 0 0 1 8 0v4')],
  unlock: [R(5, 11, 14, 10), P('M8 11V7a4 4 0 0 1 7.5-2')],

  // things
  clock: [C(12, 12, 9), PL('12 7 12 12 16 14')],
  timer: [C(12, 13, 8), L(12, 13, 12, 9), L(9, 2, 15, 2), L(19, 6, 21, 4)],
  alert: [P('M12 3l10 18H2z'), L(12, 10, 12, 14), R(11, 16.5, 2, 2, FILL)],
  info: [R(3, 3, 18, 18), L(12, 11, 12, 17), R(11, 6.5, 2, 2, FILL)],
  flag: [P('M5 21V4h13l-3 4 3 4H5')],
  diamond: [PG('12 3 21 12 12 21 3 12 12 3')],
  target: [C(12, 12, 9), C(12, 12, 5), R(11, 11, 2, 2, FILL)],
  radar: [C(12, 12, 9), C(12, 12, 4.5), L(12, 12, 18.5, 5.5), R(15, 13, 2, 2, FILL)],
  flame: [P('M12 2c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-4.5 2-7 1.5 1 2.5 2.5 2.5 4C11.5 8 12 5 12 2z')],
  star: [PG('12 3 14.7 9 21 9.6 16.2 13.8 17.6 20 12 16.8 6.4 20 7.8 13.8 3 9.6 9.3 9 12 3')],
  sparkle: [L(12, 2, 12, 8), L(12, 16, 12, 22), L(2, 12, 8, 12), L(16, 12, 22, 12), L(5, 5, 8, 8), L(16, 16, 19, 19), L(19, 5, 16, 8), L(8, 16, 5, 19)],
  skull: [P('M5 11a7 7 0 0 1 14 0v4h-3v5H8v-5H5z'), R(8, 10, 3, 3, FILL), R(13, 10, 3, 3, FILL), L(12, 17, 12, 20)],
  terminal: [R(2, 4, 20, 16), PL('6 9 10 12 6 15'), L(12, 15, 18, 15)],
  inbox: [P('M3 13h5l1 3h6l1-3h5'), P('M6 4h12l3 9v7H3v-7z')],
  home: [P('M3 11l9-7 9 7'), P('M5 9v11h14V9'), P('M10 20v-6h4v6')],
  note: [P('M5 3h10l4 4v14H5z'), P('M15 3v4h4'), L(8, 12, 16, 12), L(8, 16, 13, 16)],
  chat: [P('M3 4h18v13H10l-5 4v-4H3z'), L(7, 9, 17, 9), L(7, 13, 13, 13)],
  tag: [P('M3 3h8l10 10-8 8L3 11z'), R(6.5, 6.5, 2, 2, FILL)],
  hourglass: [L(5, 3, 19, 3), L(5, 21, 19, 21), P('M7 3v3l5 6 5-6V3'), P('M7 21v-3l5-6 5 6v3')],
  layers: [PG('12 3 22 8 12 13 2 8 12 3'), PL('2 13 12 18 22 13')],
  chart: [L(4, 20, 20, 20), R(5, 12, 3, 8), R(10.5, 6, 3, 14), R(16, 9, 3, 11)],
  cloud: [P('M7 18h11a4 4 0 0 0 0-8 6 6 0 0 0-11.5 1.5A3.5 3.5 0 0 0 7 18z')],
  offline: [P('M7 18h11a4 4 0 0 0 1.5-.3M20.5 13A4 4 0 0 0 18 10a6 6 0 0 0-8.4-4.2M6.2 8.3A6 6 0 0 0 6.5 11.5 3.5 3.5 0 0 0 7 18'), L(3, 3, 21, 21)],
  github: [P('M9 19c-4 1.5-4-2-6-2.5M15 21v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1-.3-3.4 1.3a11.6 11.6 0 0 0-6 0C6.8 2.8 5.8 3.1 5.8 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4.4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21')],
  key: [C(7.5, 15.5, 4.5), L(10.7, 12.3, 21, 2), L(17, 6, 20, 9), L(15, 8, 17, 10)],
  dot: [R(8, 8, 8, 8, FILL)],
  square: [R(5, 5, 14, 14)],
  coffee: [P('M4 9h13v5a6 6 0 0 1-6 6h-1a6 6 0 0 1-6-6z'), P('M17 11h2a2 2 0 0 1 0 4h-2'), L(8, 2, 8, 5), L(12, 2, 12, 5)],
  paw: [C(6, 10, 2), C(10, 6, 2), C(14, 6, 2), C(18, 10, 2), P('M8 17c0-3 2-5 4-5s4 2 4 5a2.5 2.5 0 0 1-4 1 2.5 2.5 0 0 1-4-1z')],
  broom: [L(20, 3, 11, 12), P('M11 12l-6 2-2 7 7-2 2-6z'), L(6, 19, 9, 16)],
};

const ALIASES = {
  zap: 'bolt', today: 'bolt', cal: 'calendar', days: 'calendar', projects: 'folder', project: 'folder',
  wins: 'trophy', win: 'trophy', all: 'list', tasks: 'list', setup: 'settings', gear: 'settings', cog: 'settings', sliders: 'settings',
  done: 'check', ok: 'check', yes: 'check', close: 'x', cancel: 'x', drop: 'x', add: 'plus', new: 'plus',
  arrow: 'arrow-right', next: 'arrow-right', move: 'push', later: 'push', tomorrow: 'push',
  start: 'play', clockin: 'play', 'clock-in': 'play', pencil: 'edit', delete: 'trash', remove: 'trash',
  sync: 'refresh', reload: 'refresh', recurring: 'repeat', chore: 'repeat', chores: 'repeat', loop: 'repeat',
  warning: 'alert', warn: 'alert', overdue: 'skull', danger: 'alert', deadline: 'diamond', due: 'diamond', pin: 'diamond',
  focus: 'target', deadlines: 'radar', incoming: 'radar', streak: 'flame', fire: 'flame', fav: 'star', milestone: 'flag',
  brief: 'chat', claude: 'chat', message: 'chat', notes: 'note', time: 'clock', watch: 'clock', grip: 'drag', handle: 'drag',
  dots: 'more', ellipsis: 'more', backlog: 'inbox', house: 'home', category: 'tag', cat: 'tag', meeting: 'chat',
  stats: 'chart', bars: 'chart', heatmap: 'chart', return: 'enter', submit: 'enter', token: 'key', dog: 'paw', ziggy: 'paw',
  clean: 'broom', break: 'coffee',
};

/** Canonical icon names (aliases not included). */
export const ICON_NAMES = Object.freeze(Object.keys(ICONS));

export function hasIcon(name) {
  const n = String(name ?? '').toLowerCase();
  return n in ICONS || n in ALIASES;
}

/**
 * icon('check') → <svg class="icon icon-check" …>.
 * opts: { size (px, default 1em via CSS), title (makes it role=img with a label), class }
 */
export function icon(name, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const raw = String(name ?? '').toLowerCase().trim();
  const key = raw in ICONS ? raw : ALIASES[raw] ?? null;
  const shapes = key ? ICONS[key] : [R(5, 5, 14, 14)];
  const size = Number.isFinite(o.size) && o.size > 0 ? o.size : null;
  const attrs = {
    class: ['icon', `icon-${key ?? 'unknown'}`, o.class].filter(Boolean).join(' '),
    viewBox: '0 0 24 24',
    width: size ?? 24,
    height: size ?? 24,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 2,
    'stroke-linecap': 'square',
    'stroke-linejoin': 'miter',
    focusable: 'false',
  };
  if (o.title) {
    attrs.role = 'img';
    attrs['aria-label'] = String(o.title);
  } else {
    attrs['aria-hidden'] = 'true';
  }
  const children = shapes.map(([tag, a]) => s(tag, a));
  if (o.title) children.unshift(s('title', null, String(o.title)));
  return s('svg', attrs, ...children);
}
