'use strict';

/* The first visits made before the owner makes them -- see src/page/warmup.js.
   Replayed against a fake page and a fake of WhatsApp's loader: no network,
   no React. Every timer is held and run by hand. */

const assert = require('assert');
const { start, SEED } = require('../src/page/warmup.js');

const KEY = 'whatsapp-desktop:warm-up';

/* WhatsApp reports an unhandled rejection as an error of its own, and the
   warm-up races every load against a timeout: none may be left behind. */
const stray = [];
process.on('unhandledRejection', err => stray.push(err));

const rig = ({ stored = null, booted = ['WAWebVoipInit'], loader = true, refuse = [], hang = [] } = {}) => {
  let clock = 0;
  let timers = [];
  const idles = [];
  const logs = [];
  const handlers = {};
  const docHandlers = {};
  const storage = new Map(stored ? [[KEY, JSON.stringify(stored)]] : []);
  const bootloaded = new Map(booted.map(name => [name, 1]));
  const loads = [];
  const preloads = [];
  const jobs = [];
  /* Wrappers WhatsApp defines: react-loadable classes carry preload(), its
     own Loadable wraps them out of reach. */
  const wrappers = {
    WAWebStatusDrawerFlowLoadable: { StatusDrawerFlowLoadable: Object.assign(() => null,
      { preload: () => { preloads.push('WAWebStatusDrawerFlow.react'); bootloaded.set('WAWebStatusDrawerFlow.react', 1); return Promise.resolve(); } }) },
    WAWebNewsletterTabFlowLoadable: { NewsletterTabFlowLoadable: () => null },
    WAWebLearnedFlowLoadable: { LearnedFlowLoadable: Object.assign(() => null,
      { preload: () => { preloads.push('WAWebLearnedFlow.react'); return Promise.resolve(); } }) },
  };
  const action = { preloadChatMessagesAction: chat => { action.nativeCalls = (action.nativeCalls || 0) + 1; return Promise.resolve(chat); } };
  const registry = {
    Bootloader: { getBootloadedComponents: () => bootloaded },
    JSResource: name => ({
      load: () => {
        loads.push(name);
        if (hang.includes(name)) return new Promise(() => {});
        if (refuse.includes(name)) return Promise.reject(new Error('[INTERNAL ONLY] Bootloading module failed'));
        bootloaded.set(name, 1);
        return Promise.resolve({});
      },
    }),
    ifRequireable: (name, yes, no) => wrappers[name] ? yes(wrappers[name]) : no(),
    WAWebPreloadChatMessagesAction: action,
    WAWebPreloadChatMessagesJob: { preloadChatMessages: chat => { jobs.push(chat.name); chat.hasPreloaded = true; return Promise.resolve(); } },
    WAWebCmd: { Cmd: { isOfflineDeliveryEnd: true } },
    WAWebCollectionConstants: { MSG_PRELOAD_THRESHOLD: 20 },
  };
  let list = false;
  const document = {
    visibilityState: 'visible',
    querySelector: selector => selector === '#pane-side' && list ? {} : null,
    addEventListener: (type, cb) => { docHandlers[type] = cb; },
  };
  const view = {
    document,
    performance: { now: () => clock },
    localStorage: {
      getItem: key => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
    require: name => {
      if (!loader && (name === 'Bootloader' || name === 'JSResource')) throw new Error('unknown module');
      return registry[name];
    },
    addEventListener: (type, cb) => { handlers[type] = cb; },
    setTimeout: (cb, ms = 0) => { const t = { cb, at: clock + ms }; timers.push(t); return t; },
    clearTimeout: t => { timers = timers.filter(x => x !== t); },
    setInterval: () => 0,
    requestIdleCallback: cb => idles.push(cb),
  };
  start({ window: view, log: line => logs.push(line) });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  /* Advance the clock and run whatever is due, then any idle callbacks, until
     nothing more becomes due. */
  const advance = async ms => {
    const until = clock + ms;
    for (let round = 0; round < 500; round++) {
      await settle();
      const due = timers.filter(t => t.at <= until).sort((a, b) => a.at - b.at);
      if (!due.length && !idles.length) break;
      if (due.length) {
        const t = due[0];
        timers = timers.filter(x => x !== t);
        clock = Math.max(clock, t.at);
        t.cb();
      } else idles.shift()();
    }
    clock = until;
    await settle();
  };
  return {
    advance, logs, loads, preloads, jobs, bootloaded, action, registry,
    showList: () => { list = true; },
    hide: () => { document.visibilityState = 'hidden'; docHandlers.visibilitychange(); },
    stored: () => JSON.parse(storage.get(KEY) || 'null'),
    input: () => handlers.pointerdown(),
  };
};

(async () => {
  /* Nothing before the chat list, and nothing in the settle after it. */
  const r = rig();
  await r.advance(3000);
  assert.equal(r.loads.length + r.preloads.length, 0, 'logged out or still loading: nothing is asked for');
  r.showList();
  await r.advance(1000);
  await r.advance(4000);
  assert.equal(r.loads.length + r.preloads.length, 0, 'WhatsApp\'s own startup goes first');
  await r.advance(2000);
  /* A wrapper with react-loadable's own class is primed through it, so the
     first render is the section and not its spinner; the others load the
     component itself. */
  assert.deepEqual(r.preloads, ['WAWebStatusDrawerFlow.react'], 'Status is primed through its Loadable');
  assert.ok(!r.loads.includes('WAWebStatusDrawerFlow.react'), 'and not loaded a second time beside it');
  assert.ok(r.loads.includes('WAWebNewsletterTabFlow.react'), 'Channels, whose Loadable is out of reach, has its code loaded');
  assert.equal(r.loads.length + r.preloads.length, SEED.length, 'every seeded section once');
  assert.ok(r.logs.some(line => new RegExp(`^warm-up: ${SEED.length} sections ready before their first visit`).test(line)));
  await r.advance(30000);
  assert.deepEqual(stray.map(err => err.message), [], 'no rejection is left without a listener');

  /* What WhatsApp then loads by itself is remembered for the next session;
     what this did, what it seeded, what startup loads and anything that is
     not a UI component are not. */
  r.bootloaded.set('WAWebStarredDrawerV2.react', 1);
  r.bootloaded.set('WAWebSomethingAction', 1);
  r.hide();
  const seen = r.stored().seen;
  assert.deepEqual(Object.keys(seen), ['WAWebStarredDrawerV2.react'], 'only a component WhatsApp loaded on its own is learned');

  /* The next session warms it too, through its Loadable when it has one. */
  const next = rig({ stored: { v: 1, seen: { 'WAWebLearnedFlow.react': Math.floor(Date.now() / 86400000) } } });
  next.showList();
  await next.advance(10000);
  assert.ok(next.preloads.includes('WAWebLearnedFlow.react'), 'a learned section is warmed through its wrapper');

  /* Forgetting: a learned name WhatsApp no longer has is refused once and
     dropped; an old one expires. */
  const today = Math.floor(Date.now() / 86400000);
  const gone = rig({ stored: { v: 1, seen: { 'WAWebRemovedFlow.react': today, 'WAWebAncientFlow.react': today - 400 } },
    refuse: ['WAWebRemovedFlow.react'] });
  gone.showList();
  await gone.advance(10000);
  assert.ok(gone.loads.includes('WAWebRemovedFlow.react'));
  assert.ok(!('WAWebRemovedFlow.react' in gone.stored().seen), 'a refused component is not asked for again');
  assert.ok(gone.loads.length >= SEED.length - 1, 'one refusal does not stop the rest');
  gone.registry.Bootloader.getBootloadedComponents().set('WAWebStarredDrawerV2.react', 1);
  gone.hide();
  assert.ok(!('WAWebAncientFlow.react' in gone.stored().seen), 'a section unused for months is let go');

  /* A line that is down: the first request never answers, and the queue
     stops rather than piling up behind it. */
  const offline = rig({ hang: [SEED[0][0]] });
  offline.showList();
  await offline.advance(60000);
  assert.equal(offline.loads.length, 1, 'no answer stops the warm-up');
  assert.ok(offline.logs.some(line => /no answer/.test(line)));

  /* The owner at work: the queue waits for quiet. */
  const busy = rig();
  busy.showList();
  await busy.advance(5000);
  busy.input();
  await busy.advance(1000);
  assert.equal(busy.loads.length + busy.preloads.length, 0, 'nothing is loaded under the owner\'s hand');
  await busy.advance(3000);
  assert.ok(busy.loads.length + busy.preloads.length > 0, 'and it goes on once things are quiet');

  /* WhatsApp's loader renamed away: the client says so and every section
     loads on its first visit, as before. */
  const renamed = rig({ loader: false });
  renamed.showList();
  await renamed.advance(10000);
  assert.ok(renamed.logs.some(line => /loader is not where it was/.test(line)));

  /* A chat's history, loaded while the pointer rests on its row: WhatsApp's
     own row calls this action on mouseenter, and its own job does the work. */
  const hover = rig();
  hover.showList();
  await hover.advance(1000);
  assert.ok(hover.logs.some(line => /loads while the pointer rests on it/.test(line)));
  const chat = (name, extra = {}) => ({ name, hasPreloaded: false, pendingInitialLoading: false, isLocked: false,
    id: { server: 'c.us' }, msgs: { length: 1, msgLoadState: { noEarlierMsgs: false } }, ...extra });
  const action = hover.registry.WAWebPreloadChatMessagesAction;
  action.preloadChatMessagesAction(chat('a'));
  action.preloadChatMessagesAction(chat('b'));
  await hover.advance(100);
  assert.equal(action.nativeCalls, 2, 'WhatsApp\'s own action still runs, untouched');
  assert.deepEqual(hover.jobs, ['b'], 'a sweep over rows fetches only the one the pointer stayed on');
  for (const [name, extra] of [['locked', { isLocked: true }], ['channel', { id: { server: 'newsletter' } }],
    ['loaded', { msgs: { length: 30, msgLoadState: {} } }], ['done', { hasPreloaded: true }],
    ['empty', { msgs: { length: 1, msgLoadState: { noEarlierMsgs: true } } }]]) {
    action.preloadChatMessagesAction(chat(name, extra));
    await hover.advance(100);
    assert.ok(!hover.jobs.includes(name), name + ': not fetched');
  }
  hover.registry.WAWebCmd.Cmd.isOfflineDeliveryEnd = false;
  action.preloadChatMessagesAction(chat('syncing'));
  await hover.advance(100);
  assert.ok(!hover.jobs.includes('syncing'), 'nothing while WhatsApp is still catching up after a start');

  console.log('warm-up checks pass');
})().catch(err => { console.error(err); process.exit(1); });
