/*
 * The first visit to anything, made before the owner makes it.
 *
 * Every section behind the rail, every page in You and the conversation's own
 * composer is a lazy component of WhatsApp's: its code is not in the page until
 * something asks for it, and asking costs a round trip. Traced on the live
 * client, the first click on Status went
 *
 *   click -> GET /ajax/bootloader-endpoint/?modules=WAWebStatusDrawerFlow.react
 *         -> ~220ms on this line -> the chunks, from the disk cache -> render
 *
 * and the drawer showed a spinner page for those frames, or on Channels and
 * Communities no page at all, with the chat list showing through where the old
 * section had been. The second visit asks nobody and is there in one render.
 * Every first visit measured paid the same toll: Calls, Status, Channels,
 * Communities, You, Profile, Account, Privacy, and the first chat opened in a
 * session (its composer and theme are lazy too) -- one request each, 210 to
 * 290ms, and slower on a slower line.
 *
 * So the same requests are made here, once the client is up and has nothing
 * else to do, through WhatsApp's own loader -- `JSResource(name).load()` is
 * what its own code calls on that first click. Nothing is drawn and nothing is
 * opened; the components are only made ready, as the first click would have
 * made them, earlier.
 *
 * That alone left a stand-in on screen for 40-80ms, measured with no request
 * in flight: each section is wrapped for React in a react-loadable, and a
 * Loadable that has never loaded renders its `loading` -- WhatsApp's spinner
 * drawer -- once, even when the code is already in the page. The wrapper is a
 * module of its own, the name WhatsApp's code gives in `__setRef`, and where
 * it is react-loadable's own class its static `preload()` loads through it,
 * so its first render is the section. Where WhatsApp has wrapped that class
 * again (`WAWebLoadable`: Channels, Communities) the class is out of reach and
 * the code is loaded on its own; navigation.js covers what is left.
 *
 * The list is two lists. The SEED is what the owner named and what was
 * measured above. The rest is learned: whatever WhatsApp loaded by itself in
 * earlier sessions -- a contact's info, the media viewer, message info -- is
 * remembered for a while and warmed with the rest, so a section this file
 * never heard of stops being slow the second session it is used in. Only UI
 * components are learned (`.react`, `.stylex`): a component is a definition,
 * and running one early runs nothing, where an action or an init module might.
 *
 * A component a WhatsApp deploy has taken away is refused by its loader, and
 * a learned one is then forgotten; a wrapper is only ever asked for if it
 * exists. If the loader itself is not where it was, nothing here runs and
 * every section loads on first use, as WhatsApp does it.
 */
'use strict';

/* Each as [component, the module that wraps it for React]. */
const SEED = [
  /* The rail. */
  ['WAWebVoipCallsTabDrawerFlow.react', 'WAWebVoipCallsTabDrawerFlowLoadable'],
  ['WAWebVoipCallsTabEmptyState.react', 'WAWebVoipCallsTabEmptyStateLoadable.react'],
  ['WAWebCallButtons.react', 'WAWebVoipCallButtonsLoadable'],
  ['WAWebStatusDrawerFlow.react', 'WAWebStatusDrawerFlowLoadable'],
  ['WAWebNewsletterTabFlow.react', 'WAWebNewsletterTabFlowLoadable'],
  ['WAWebNewsletterContextMenu', 'WAWebNewsletterContextMenuLoadable'],
  ['WAWebCommunityFlow.react', 'WAWebCommunityFlowLoadable'],
  /* You, Profile, and the settings pages behind Account, Privacy and the rest. */
  ['WAWebMeTabFlow.react', 'WAWebMeTabFlowLoadable'],
  ['WAWebProfileDrawer.react', 'WAWebProfileDrawerLoadableRequireBundle'],
  ['WAWebPhotoPicker.react', 'WAWebPhotoPickerLoadable.react'],
  ['WAWebSettingsFlow.react', 'WAWebSettingsFlowLoadable'],
  ['WAWebContextualBannerWrapper.react', ''],
  /* The conversation: its composer and theme, then the two things opened from
     it most -- the contact's info and a photo. */
  ['WAWebComposeBoxWWAIWrapper.react', 'WAWebComposeBoxWWAIWrapperLoadable'],
  ['WAWebChatThemeDefinitions.stylex', ''],
  ['WAWebInfoFlow.react', 'WAWebInfoFlowLoadable'],
  ['WAWebMediaViewerFlow.react', 'WAWebMediaViewerFlowLoadable'],
];
const SEEDED = new Set(SEED.map(([component]) => component));

const KEY = 'whatsapp-desktop:warm-up';
/* How long a component used once stays warmed without being used again. */
const KEEP_DAYS = 45;
const MAX_LEARNED = 40;
const LEARNABLE = /^[\w$-]{1,100}\.(?:react|stylex)$/;
const NAME = /^[\w.$-]{1,120}$/;
/* After the chat list is up, before any of this starts: WhatsApp's own startup
   (its sync, the list, the first pictures) goes first. */
const SETTLE_MS = 5000;
/* An answer slower than this is a line that is down, not a component that is
   slow, and the rest of the queue would only wait on it too. */
const ANSWER_MS = 15000;
/* Input this recent means the owner is doing something; the queue waits. */
const QUIET_MS = 1500;

const start = ({ log = () => {}, window: view = window } = {}) => {
  const doc = view.document;
  const ours = new Set();
  let before = null;   /* what WhatsApp had loaded by itself before this began */
  let lastInput = -Infinity;
  const now = () => (view.performance && typeof view.performance.now === 'function'
    ? view.performance.now() : Date.now());
  const today = () => Math.floor(Date.now() / 86400000);
  const grab = name => {
    try { return typeof view.require === 'function' ? view.require(name) : null; }
    catch (err) { return null; }
  };

  const read = () => {
    try {
      const saved = JSON.parse(view.localStorage.getItem(KEY) || 'null');
      return saved && saved.v === 1 && saved.seen && typeof saved.seen === 'object' ? saved.seen : {};
    } catch (err) { return {}; }
  };
  const write = seen => {
    try { view.localStorage.setItem(KEY, JSON.stringify({ v: 1, seen })); } catch (err) { /* full or off */ }
  };

  /* What WhatsApp loaded on its own since this began, kept for the next
     session. Ours are not evidence of anything, and neither is what it loads
     at every startup anyway. */
  const learn = () => {
    /* Not before the warm-up has taken its own reading of what startup loads. */
    if (!before) return;
    const loader = grab('Bootloader');
    let loaded = null;
    try { loaded = loader && loader.getBootloadedComponents(); } catch (err) { return; }
    if (!loaded || typeof loaded.keys !== 'function') return;
    const seen = read();
    const day = today();
    let changed = false;
    for (const name of loaded.keys()) {
      if (!LEARNABLE.test(name) || ours.has(name) || SEEDED.has(name) || before.has(name)) continue;
      if (seen[name] !== day) { seen[name] = day; changed = true; }
    }
    const kept = Object.entries(seen).filter(([name, at]) =>
      LEARNABLE.test(name) && Number.isFinite(at) && day - at <= KEEP_DAYS)
      .sort((a, b) => b[1] - a[1]).slice(0, MAX_LEARNED);
    if (changed || kept.length !== Object.keys(seen).length) write(Object.fromEntries(kept));
  };

  const idle = () => new Promise(resolve => {
    const wait = () => {
      if (now() - lastInput < QUIET_MS) { view.setTimeout(wait, QUIET_MS); return; }
      if (typeof view.requestIdleCallback === 'function') view.requestIdleCallback(() => resolve(), { timeout: 2000 });
      else view.setTimeout(resolve, 50);
    };
    wait();
  });

  const warm = async () => {
    const loader = grab('Bootloader');
    const resource = grab('JSResource');
    /* A module asked for by name that does not exist is an error WhatsApp
       reports; this asks whether it exists first, and is WhatsApp's own way to. */
    const ifRequireable = grab('ifRequireable');
    let loaded;
    try { loaded = loader.getBootloadedComponents(); } catch (err) { loaded = null; }
    if (!loader || typeof resource !== 'function' || !loaded || typeof loaded.has !== 'function') {
      log('warm-up: WhatsApp\'s loader is not where it was; sections load on their first visit');
      return;
    }
    before = new Set(loaded.keys());
    /* react-loadable's own classes among a wrapper's exports. A learned
       component's wrapper is looked for under the two names WhatsApp gives
       them; a module that is not there is simply not used. */
    const preloads = wrappers => {
      if (typeof ifRequireable !== 'function') return [];
      const found = [];
      for (const wrapper of wrappers) {
        let module = null;
        try { module = ifRequireable(wrapper, value => value, () => null); } catch (err) { module = null; }
        if (!module || typeof module !== 'object') continue;
        for (const value of Object.values(module))
          if (typeof value === 'function' && typeof value.preload === 'function') found.push(value);
      }
      return found;
    };
    const learned = Object.entries(read()).sort((a, b) => b[1] - a[1]).map(([name]) => name)
      .filter(name => !SEEDED.has(name))
      .map(name => [name, [name.replace(/\.react$/, '') + 'Loadable', name.replace(/\.react$/, '') + 'Loadable.react']]);
    const queue = [...SEED.map(([name, wrapper]) => [name, wrapper ? [wrapper] : []]), ...learned]
      .filter(([name]) => NAME.test(name));
    const began = now();
    let made = 0;
    const gone = [];
    for (const [name, wrappers] of queue) {
      let classes, done;
      try {
        classes = preloads(wrappers);
        done = loader.getBootloadedComponents().has(name);
      } catch (err) { return; }
      /* Loaded already and nothing to prime: WhatsApp did this one itself. */
      if (done && !classes.length) continue;
      await idle();
      ours.add(name);
      let timer = 0;
      try {
        const jobs = classes.length ? classes.map(loadable => loadable.preload()) : [resource(name).load()];
        await Promise.race([Promise.all(jobs), new Promise((resolve, reject) => {
          timer = view.setTimeout(() => reject(new Error('no answer')), ANSWER_MS);
        })]);
        made++;
      } catch (err) {
        /* No answer at all is a line that is down: the rest would fare no
           better, and the first visits load as they always did. A refusal is
           about this one name -- a component a WhatsApp deploy took away --
           and it is not asked for again. */
        if (err && err.message === 'no answer') {
          log(`warm-up: no answer for ${name}; the rest load on their first visit`);
          break;
        }
        if (!SEEDED.has(name)) gone.push(name);
      } finally {
        view.clearTimeout(timer);
      }
    }
    if (gone.length) {
      const seen = read();
      for (const name of gone) delete seen[name];
      write(seen);
      log(`warm-up: ${gone.length} remembered sections are gone from WhatsApp and are forgotten`);
    }
    if (made) log(`warm-up: ${made} sections ready before their first visit, in ${Math.round(now() - began)}ms`);
  };

  /*
   * A chat's history, fetched while the pointer rests on its row.
   *
   * WhatsApp keeps one message per chat in memory and fetches the rest when
   * the chat opens; measured, a chat not opened since the start sat empty for
   * 200-400ms while it did. WhatsApp's own design has an answer: its chat row
   * calls `preloadChatMessagesAction(chat)` on mouseenter, which fetches the
   * history through the same loader an open uses -- and then declines,
   * because an AB flag (`web_preload_chat_messages`) is off on this account.
   * Measured with the job run by hand: the history in 53ms, and the chat then
   * opening whole in its first frame.
   *
   * So the action is wrapped and keeps doing what it did; where it declined,
   * WhatsApp's own job runs instead, under WhatsApp's own conditions -- the
   * offline sync over, fewer messages than its MSG_PRELOAD_THRESHOLD -- and
   * two of this client's: never a locked chat or a channel, and only once the
   * pointer has stayed on the row a moment, so a sweep down the list fetches
   * nothing.
   */
  const HOVER_MS = 60;
  const preloadOnHover = () => {
    const action = grab('WAWebPreloadChatMessagesAction');
    const job = grab('WAWebPreloadChatMessagesJob');
    const native = action && action.preloadChatMessagesAction;
    if (typeof native !== 'function' || native.__waDesktop || !job || typeof job.preloadChatMessages !== 'function')
      return false;
    const commands = grab('WAWebCmd');
    const constants = grab('WAWebCollectionConstants');
    const enough = Number(constants && constants.MSG_PRELOAD_THRESHOLD) || 20;
    let timer = 0;
    const preload = chat => {
      try {
        if (!chat || chat.hasPreloaded || chat.pendingInitialLoading || chat.isLocked) return;
        if (commands && commands.Cmd && commands.Cmd.isOfflineDeliveryEnd === false) return;
        if (chat.isNewsletter || String(chat.id && chat.id.server) === 'newsletter') return;
        const msgs = chat.msgs;
        const state = msgs && msgs.msgLoadState;
        if (!msgs || !state || msgs.length >= enough || state.noEarlierMsgs ||
            state.isLoadingEarlierMsgs || state.isLoadingRecentMsgs || state.isLoadingAroundMsgs) return;
        Promise.resolve(job.preloadChatMessages(chat)).catch(() => {});
      } catch (err) { /* the open fetches it, as before */ }
    };
    const wrapped = function (chat, ...rest) {
      const answer = native.call(this, chat, ...rest);
      view.clearTimeout(timer);
      timer = view.setTimeout(() => preload(chat), HOVER_MS);
      return answer;
    };
    wrapped.__waDesktop = true;
    try { action.preloadChatMessagesAction = wrapped; } catch (err) { return false; }
    return action.preloadChatMessagesAction === wrapped;
  };

  for (const type of ['pointerdown', 'keydown', 'wheel'])
    view.addEventListener(type, () => { lastInput = now(); }, { capture: true, passive: true });
  view.addEventListener('pagehide', learn);
  doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'hidden') learn(); });
  view.setInterval(learn, 5 * 60 * 1000);

  /* Logged in and drawn: the list is the sign. Polled rather than observed --
     it is one query every second until it answers, and then never again. */
  const ready = () => {
    if (!doc.querySelector('#pane-side')) { view.setTimeout(ready, 1000); return; }
    if (preloadOnHover()) log('warm-up: a chat\'s history loads while the pointer rests on it');
    view.setTimeout(() => { warm().catch(err => log('warm-up: ' + err.message)); }, SETTLE_MS);
  };
  ready();
};

module.exports = { start, SEED };
