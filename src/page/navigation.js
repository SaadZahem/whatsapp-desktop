'use strict';

/* The rail and the conversation have separate lifetimes. Closing a chat must
 * also clear the rail's restore target; hiding it behind another tab must not.
 * Read the selected rail button rather than inferring a tab from #main. */
const start = ({ press, log, prepareChat = () => {}, window: view = window }) => {
  const doc = view.document;
  const RAIL = '[data-testid="chatlist-header"]';
  const LEFT = '[data-testid="drawer-left"] > div > span > div';
  const PANELS = LEFT + ', [data-testid="drawer-middle"] > div > span > div';
  /* Placeholders beside a tab stay steady: a full-size welcome surface is
     raster work and no information. */
  const PLACEHOLDER = '[data-testid="empty-state-drawer"], [data-testid="intro-panel"]';
  /* WhatsApp's stand-in for a section whose code is still on its way: a
     header and a spinner, drawn the first time a section is opened. */
  const LOADING = '[data-testid="loading-spinner"]';
  /* How long that stand-in is kept out of sight. A first visit whose code is
     already in the page swaps it for the section 40-80ms later, measured, and
     a spinner on screen for that long is a flash, not news; one still there
     after this is a section genuinely loading, and is shown. */
  const LOADING_GRACE_MS = 300;
  /* And how long an empty wrapper may hold the surface: WhatsApp's own
     Loadable turns one into its loading drawer after 200ms. */
  const HOLD_MS = 700;
  /* Every state this file hides a panel in. */
  const OUT_OF_SIGHT = ['inactive', 'waiting', 'pending']
    .map(state => `[data-wa-navigation-panel="${state}"]`).join(', ');
  const BODY = '[data-testid="conversation-panel-body"]';
  const MESSAGES = '[data-testid="conversation-panel-messages"], [data-tab="conversation-panel-messages"]';
  const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
  const CHAT_ICON = /^(?:wds-ic-chat|chat)(?:-filled)?$/;
  let previous = null;
  let leavingChats = false;
  let departure = 0;
  let chatCollection = null;
  let chatMotions = [];
  let pendingChat = null;
  let requestedSection = null;
  /* The rail button that was selected when the owner asked for another one:
     which page the eye is on while the next one is being built. */
  let leftSection = null;
  let headingTo = null;
  let sectionAskedAt = -Infinity;
  let listMotion = null;
  let pendingList = false;
  let updateQueued = false;
  let owning = false;
  /* When the owner last pressed something: a page that changes within this
     of a click or a key is one they asked for. Account opens about 65ms after
     its click; WhatsApp's own loading-to-list swaps come later than this or
     during the reveal that is already running. */
  const ASKED_MS = 600;
  let lastInput = -Infinity;
  const now = () => (view.performance && typeof view.performance.now === 'function'
    ? view.performance.now() : Date.now());
  const stillness = typeof view.matchMedia === 'function'
    ? view.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const panels = new Map();
  const preparing = new Set();
  const grab = name => {
    try { return typeof view.require === 'function' ? view.require(name) : null; }
    catch (err) { return null; }
  };
  const rail = () => {
    const root = doc.querySelector(RAIL);
    if (!root) return null;
    const buttons = [...root.querySelectorAll('button[aria-pressed]')];
    const chats = buttons.find(button => [...button.querySelectorAll('svg title')]
      .some(title => CHAT_ICON.test(title.textContent.trim())));
    const selected = buttons.find(button => button.getAttribute('aria-pressed') === 'true');
    return chats && selected ? { chats, selected, root } : null;
  };
  const visible = element => {
    if (element.closest?.(OUT_OF_SIGHT)) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && element.getClientRects().length > 0;
  };
  const layerIsUp = state => {
    const meList = doc.querySelector('[data-testid="me-tab-drawer"] [role="listbox"]');
    for (const el of doc.querySelectorAll(
      '[role="menu"], [role="listbox"], [role="application"], [role="dialog"], [data-testid="drawer-right"]'))
      if (el !== meList && visible(el)) return true;
    /* A nested settings page or community detail keeps its own Back button.
       One Escape goes to that page, leaving the selected rail tab in place. */
    const panel = doc.querySelector(LEFT);
    if (panel && !panel.closest?.(OUT_OF_SIGHT)) {
      for (const title of panel.querySelectorAll('header svg title'))
        if (/^(?:ic-arrow-back|wds-ic-arrow-back|back)$/.test(title.textContent.trim())) return true;
    }
    /* Photo/status viewers need Escape themselves. They cover the rail even
       when they carry none of the usual dialog roles. */
    const rect = state.chats.getBoundingClientRect();
    const top = doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return !!top && !state.chats.contains(top);
  };
  const forgetClosedChat = () => {
    const activity = grab('WAWebSideNavButtonsActivityModel');
    const restore = grab('WAWebOpenLastActiveChatAction');
    try {
      if (typeof activity?.setLastActiveChat === 'function') activity.setLastActiveChat(null);
      if (typeof restore?.cancelPendingLastActiveChatRestore === 'function')
        restore.cancelPendingLastActiveChatRestore();
    } catch (err) { log('could not clear the closed chat restore target: ' + err.message); }
  };
  const activeId = () => {
    if (!chatCollection) chatCollection = grab('WAWebChatCollection')?.ChatCollection || null;
    try { return chatCollection?.getActive?.()?.id?.toString() || ''; }
    catch (err) { return ''; }
  };
  /*
   * A conversation's history, still on its way when the conversation opens.
   *
   * WhatsApp keeps one message per chat in memory -- the one the chat list
   * shows -- and fetches the rest from its local store when the chat opens.
   * Measured on the live client, a chat not opened since the start: #main at
   * +101ms holding that one row, `isLoadingEarlierMsgs` from +158ms, the
   * store holding 22 messages at +211ms and the DOM showing them at +292ms.
   * The entrance ran on the one row and a spinner and was over by the time the
   * history landed, which then simply appeared -- on a first open, also
   * after a black frame where the wallpaper had not been drawn yet.
   *
   * So when the store says the history is coming, the messages are held at
   * their first keyframe, out of sight, while the header and composer make
   * their entrance; they rise into place when the rows land. Not for long
   * whatever happens: a load that has not begun by CHAT_LOAD_START_MS is not
   * coming, one finished without new rows has nothing more to show, and past
   * CHAT_HOLD_MS whatever is there -- the spinner of a slow fetch -- is shown.
   */
  const HISTORY_FEW = 10;
  const CHAT_LOAD_START_MS = 180;
  const CHAT_LOAD_RENDER_MS = 160;
  const CHAT_HOLD_MS = 650;
  let chatHold = null;
  const holding = new Set();
  const historyState = () => {
    if (!chatCollection) chatCollection = grab('WAWebChatCollection')?.ChatCollection || null;
    try {
      const msgs = chatCollection?.getActive?.()?.msgs;
      const state = msgs?.msgLoadState;
      if (!state || typeof msgs.length !== 'number') return null;
      return {
        loading: !!(state.isLoadingRecentMsgs || state.isLoadingEarlierMsgs || state.isLoadingAroundMsgs),
        few: msgs.length < HISTORY_FEW && !state.noEarlierMsgs,
      };
    } catch (err) { return null; }
  };
  const rowsIn = main => main.querySelector(MESSAGES)?.querySelectorAll?.('[role="row"]').length || 0;
  const letHistoryGo = () => {
    const hold = chatHold;
    chatHold = null;
    if (!hold) return;
    holding.delete(hold.animation);
    if (hold.animation.playState === 'paused') hold.animation.play();
  };
  const watchHistory = hold => {
    if (chatHold !== hold) return;
    if (!hold.main.isConnected) { letHistoryGo(); return; }
    const state = historyState();
    const waited = now() - hold.since;
    if (state?.loading) { hold.began = true; hold.loaded = 0; }
    else if (hold.began && !hold.loaded) hold.loaded = now();
    if (rowsIn(hold.main) > hold.rows || waited >= CHAT_HOLD_MS ||
        (!hold.began && waited >= CHAT_LOAD_START_MS) ||
        (hold.loaded && now() - hold.loaded >= CHAT_LOAD_RENDER_MS)) {
      letHistoryGo();
      return;
    }
    /* Asked every frame while it lasts: a few reads, for well under a second. */
    if (typeof view.requestAnimationFrame === 'function') view.requestAnimationFrame(() => watchHistory(hold));
    else view.setTimeout(() => watchHistory(hold), 16);
  };
  const reducedMotion = () => !!stillness?.matches;
  const motion = (element, frames, duration, easing = EASE, held = false) => {
    if (!element || reducedMotion() || typeof element.animate !== 'function') return null;
    try {
      owning = true;
      const animation = element.animate(frames, { duration, easing });
      owning = false;
      /* Raster the newly mounted content at its first keyframe before starting
         the clock. Otherwise the first native layout/paint can consume most
         of a short reveal, which makes it appear to jump to the end. */
      if (typeof animation.pause === 'function' && typeof view.requestAnimationFrame === 'function') {
        animation.pause();
        /* Held: it stays at its first keyframe until let go. */
        if (held) { holding.add(animation); return animation; }
        preparing.add(animation);
        view.requestAnimationFrame(() => {
          preparing.delete(animation);
          if (animation.playState !== 'paused') return;
          if (!element.isConnected || reducedMotion() || doc.visibilityState === 'hidden')
            animation.cancel();
          else animation.play();
        });
      }
      return animation;
    } catch (err) { owning = false; return null; /* A build without Web Animations still opens. */ }
  };
  const reveal = (element, offset, opacity, duration) => motion(element,
    [{ transform: `translate3d(0, ${offset}px, 0)`, opacity },
     { transform: 'none', opacity: 1 }], duration);
  /* WhatsApp animates some panels itself -- a fade from 0.5 over 50ms on most,
     a slide in from the left over 300ms on Channels -- and the reveal below
     owns that same panel's opacity and transform. Two animations of one
     property on one element are the case the compositor will not take
     ("TargetHasIncompatibleAnimations" in a trace), so the reveal fell back to
     the main thread exactly when WhatsApp was busiest; and holding the native
     ones down with an !important style instead pinned THEM to the main thread,
     drawing nothing, 50-300ms per tab. The native motion of a panel goes
     through with no duration and no fill: it finishes on the spot, its promise
     still resolves, and it leaves no value behind. */
  const quietNativeMotion = () => {
    const proto = view.Element && view.Element.prototype;
    const native = proto && proto.animate;
    if (typeof native !== 'function' || native.__waQuiet) return;
    const MOVING = ['opacity', 'transform', 'translate', 'scale', 'rotate'];
    const panelMotion = frames => {
      const keys = Array.isArray(frames) ? frames.flatMap(frame => Object.keys(frame || {}))
        : Object.keys(frames || {});
      const moving = keys.filter(key => !['offset', 'easing', 'composite'].includes(key));
      return moving.length > 0 && moving.every(key => MOVING.includes(key));
    };
    const animate = function (frames, options) {
      try {
        if (!owning && panelMotion(frames) && this.matches?.(PANELS))
          options = typeof options === 'object' && options
            ? { ...options, duration: 0, delay: 0, endDelay: 0, fill: 'none' }
            : { duration: 0, fill: 'none' };
      } catch (err) { /* not a panel: native arguments as given */ }
      return native.call(this, frames, options);
    };
    animate.__waQuiet = true;
    proto.animate = animate;
  };
  const cancelChatMotion = () => {
    for (const animation of chatMotions) animation.cancel();
    chatMotions = [];
    if (chatHold) { holding.delete(chatHold.animation); chatHold = null; }
  };
  const animateChat = (main, switching) => {
    cancelChatMotion();
    const messages = main.querySelector(MESSAGES);
    /* The messages, held out of sight while their history is on its way and
       rising into place when it lands -- see historyState. */
    const state = messages && doc.visibilityState !== 'hidden' ? historyState() : null;
    const late = state && (state.loading || state.few)
      ? motion(messages, [{ transform: 'translate3d(0, 6px, 0)', opacity: 0 }, { transform: 'none', opacity: 1 }],
        200, EASE, true)
      : null;
    if (late) {
      chatHold = { animation: late, main, rows: rowsIn(main), since: now(), began: false, loaded: 0 };
      watchHistory(chatHold);
    }
    if (!switching) {
      /* Preserve the first entrance's lateral motion without making a new GPU
         surface out of the whole frame and wallpaper. The messages already
         have a compositor layer for scrolling; reuse it and move the small
         header/composer contents with it. */
      const offset = doc.documentElement?.getAttribute('dir') === 'rtl' ? -14 : 14;
      chatMotions = [late ? null : messages || main.querySelector(BODY),
        main.querySelector('header > div'), main.querySelector('footer > div')]
        .map(element => motion(element,
          [{ transform: `translate3d(${offset}px, 0, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
          220, 'cubic-bezier(0.2, 0.8, 0.2, 1)')).filter(Boolean);
      if (late) chatMotions.unshift(late);
      return;
    }
    /* A chat swap replaces #main in some builds and reuses it in others. Only
       the newly committed messages and identity move in either case. No
       delayed callbacks or copies of an old chat survive a rapid switch. */
    chatMotions = [
      late || reveal(messages || main.querySelector(BODY), 4, 0.85, 160),
      reveal(main.querySelector('header > div'), 2, 0.75, 140),
    ].filter(Boolean);
  };
  const retire = (panel, record) => {
    panel.setAttribute('data-wa-navigation-panel', 'inactive');
    record.active = false;
    record.page = '';
    if (record.animation) { record.animation.cancel(); record.animation = null; }
    if (record.timer) { view.clearTimeout?.(record.timer); record.timer = null; }
  };
  const changeSection = (button, state) => {
    if (button === state.selected) return;
    requestedSection = button;
    leftSection = state.selected;
    pendingList = button === state.chats;
    if (listMotion) { listMotion.cancel(); listMotion = null; }
    /* Back to Chats, the list is the destination and is already underneath:
       a section left standing would only cover it. Anywhere else, the page on
       screen stays until the next one has something to show -- see wait() --
       and only its motion stops. */
    for (const [panel, record] of panels) {
      if (button === state.chats) retire(panel, record);
      else if (record.animation) { record.animation.cancel(); record.animation = null; }
    }
  };
  /*
   * The front panel of a drawer with nothing to show yet: WhatsApp's empty
   * wrapper, or its loading drawer.
   *
   * Measured on first visits, frame by frame: Status, Calls and You mount the
   * loading drawer -- a header and a spinner -- for 40-80ms when their code is
   * in the page and for a whole round trip when it is not; Channels and
   * Communities mount a wrapper that draws NOTHING for up to 200ms (WhatsApp's
   * Loadable holds its spinner back that long). Either way WhatsApp has already
   * taken the old section down in the same commit, and the empty wrapper let
   * the chat list underneath show through: Status, then the chat list for
   * 60-130ms, then Channels -- the "it shows the chats for a moment" the owner
   * reported.
   *
   * So, until a page arrives: a page still standing in the same drawer stays
   * up and the newcomer is kept out of sight. With nothing standing, a move
   * between two sections gets the drawer's own surface -- the same blank the
   * reveal starts from -- and a move from Chats keeps the chat list, which is
   * what the eye was on. The loading drawer itself is shown only once it has
   * been up for LOADING_GRACE_MS: by then it is telling the owner something.
   */
  const wait = (panel, group, record, loading, destination, state) => {
    if (!record) {
      record = { owner: destination, group, active: false, page: '', animation: null, timer: null };
      panels.set(panel, record);
    }
    /* The wait is timed from when this panel began waiting, whatever it was
       before -- a sibling retired a moment ago, or a page that has since
       emptied. */
    if (!record.waiting) { record.waiting = true; record.since = now(); }
    /* Never for long: whatever is there by then is shown as it is. */
    const limit = loading ? LOADING_GRACE_MS : HOLD_MS;
    const waited = now() - record.since;
    if (waited >= limit) return true;
    let standing = false;
    for (const [old, other] of panels)
      if (old !== panel && other.active && other.group === group && old.isConnected) standing = true;
    const cover = !standing && !!leftSection && leftSection !== state.chats;
    /* An empty wrapper draws nothing, so it is only ever marked to put the
       surface over the chat list; a loading drawer is kept out of sight. */
    const mark = cover ? 'pending' : loading ? 'waiting' : '';
    const was = panel.getAttribute?.('data-wa-navigation-panel');
    if (mark && was !== mark) panel.setAttribute('data-wa-navigation-panel', mark);
    else if (!mark && was) panel.removeAttribute?.('data-wa-navigation-panel');
    if (!record.timer)
      record.timer = view.setTimeout(() => { record.timer = null; scheduleUpdate(); }, limit - waited);
    return false;
  };
  const animateSections = state => {
    if (requestedSection === state.selected) requestedSection = null;
    const destination = requestedSection || state.selected;
    if (destination !== headingTo) {
      headingTo = destination;
      sectionAskedAt = now();
      /* And one look once the longest hold is over, so a section that never
         draws in these drawers cannot leave the old one standing. */
      view.setTimeout(scheduleUpdate, HOLD_MS + 50);
    }
    for (const [panel, record] of panels) {
      if (!panel.isConnected) {
        if (record.animation) record.animation.cancel();
        if (record.timer) view.clearTimeout?.(record.timer);
        panels.delete(panel);
      }
    }
    if (destination === state.chats) {
      for (const [panel, record] of panels)
        if (panel.getAttribute?.('data-wa-navigation-panel') !== 'inactive' || record.active) retire(panel, record);
      if (!requestedSection) leftSection = state.chats;
      return;
    }
    const fronts = new Set();
    let arrived = false;
    for (const panel of doc.querySelectorAll(PANELS)) {
      const group = panel.closest?.('[data-testid="drawer-left"], [data-testid="drawer-middle"]') || panel.parentElement;
      let record = panels.get(panel);
      if (record && record.owner !== destination) continue;
      /* The newest wrapper comes first, including nested You > Profile pages.
         Those keep the same selected rail button. Retire siblings by drawer,
         rather than only when the rail selection changes, before either can
         paint over the other. */
      if (fronts.has(group)) {
        if (!record) {
          panel.setAttribute('data-wa-navigation-panel', 'inactive');
          panels.set(panel, { owner: destination, group, active: false, page: '', animation: null, timer: null });
        }
        continue;
      }
      fronts.add(group);
      const page = panel.querySelector?.('[data-testid]');
      const loading = !!page && !!page.matches?.(LOADING);
      /* A wrapper with nothing in it yet takes nothing over. Profile's arrives
         about 50ms before its page, and retiring You on the wrapper put a blank
         surface on screen for those frames; the page it replaces stays up until
         this one has something to show. */
      if ((!record || !record.active) && (!page || loading)) {
        if (!wait(panel, group, record, loading, destination, state)) continue;
        record = panels.get(panel);
      }
      if (!record || !record.active) {
        if (record && record.timer) view.clearTimeout?.(record.timer);
        for (const [old, retiring] of panels)
          if (old !== panel && retiring.group === group && retiring.active) retire(old, retiring);
        panel.setAttribute('data-wa-navigation-panel', 'active');
        record = { owner: destination, group, active: true, page: '', animation: null, timer: null };
        panels.set(panel, record);
      }
      arrived = true;
      /* The panel is what moves, never something inside it. It is positioned
         and as big as the drawer, so a transform on it changes no layout and
         the compositor takes it whole. Its first child was the target before
         and that is not always a box: Profile mounts a wrapper 0px tall whose
         page hangs off it absolutely, so its reveal had no effect on the
         compositor and ran on the main thread for its whole 220ms -- measured
         -- which is the stutter Profile had and its siblings did not.

         One reveal per page the owner asked for. Profile is a panel of its
         own, but Account, Privacy and the rest replace the page inside the You
         panel, and so does Back -- the page root's test id says which page is
         up. WhatsApp swaps pages by itself too: Calls shows a loading page and
         then the list, under a different id. Restarting on that was a second
         fade over the first -- seen frame by frame. So a page that changes
         while a reveal is still running joins it, and one that changes long
         after the last click or key is WhatsApp's own business. */
      const key = page?.getAttribute?.('data-testid') || '';
      if (!key || key === record.page) continue;
      const first = !record.page;
      /* The section the loading drawer stood in for is what the owner asked
         for, however long it took to come: it gets the reveal. The drawer
         itself, still up after its grace, stands still -- a spinner fading in
         is two motions for one wait. */
      const afterLoading = record.loading;
      record.page = key;
      record.loading = loading;
      if (loading) {
        if (record.animation) { record.animation.cancel(); record.animation = null; }
        continue;
      }
      if (!first && !afterLoading) {
        const running = record.animation &&
          !['finished', 'idle'].includes(record.animation.playState);
        if (running || now() - lastInput > ASKED_MS) continue;
      }
      record.animation?.cancel();
      record.animation = page.matches?.(PLACEHOLDER) ? null : reveal(panel, 8, 0, 220);
    }
    /* The page that was up before the rail changed goes once the new one is
       on screen, wherever it stood -- and not a frame before. */
    if (arrived || now() - sectionAskedAt >= HOLD_MS) {
      for (const [panel, record] of panels)
        if (record.active && record.owner !== destination) retire(panel, record);
    }
    if (arrived) leftSection = destination;
  };
  const mediaCloseButton = () => {
    const media = doc.querySelector('[data-testid="media-hub-modal"]');
    if (!media || !visible(media)) return null;
    for (const el of doc.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"]'))
      if (!el.contains(media) && visible(el)) return null;
    if (media.querySelector('input[type="checkbox"], [role="checkbox"], input[type="search"], input[type="text"]')) return null;
    const rect = media.getBoundingClientRect();
    const top = doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (top && !media.contains(top)) return null;
    const buttons = [...media.querySelectorAll('button, [role="button"]')]
      .filter(button => [...button.querySelectorAll('svg title')]
        .some(title => /^(?:ic-close|wds-ic-close|x)$/.test(title.textContent.trim())));
    return buttons.length === 1 ? buttons[0] : null;
  };
  const update = () => {
    const state = rail();
    if (!state) return;
    const main = doc.querySelector('#main');
    const chats = state.selected === state.chats;
    const id = main ? activeId() : '';
    const messages = main?.querySelector(MESSAGES);
    const contentKey = messages?.querySelector?.('[data-id]')?.getAttribute('data-id') || '';
    animateSections(state);
    if (chats && !main && !leavingChats &&
        (!previous || (previous.chats && previous.main))) forgetClosedChat();
    if (chats && previous && !previous.chats && !requestedSection) pendingList = true;
    const list = chats && !requestedSection && pendingList &&
      (doc.querySelector('#side') || doc.querySelector('#pane-side'));
    if (list && list.firstElementChild) {
      if (listMotion) listMotion.cancel();
      listMotion = reveal(list, 8, 0, 220);
      pendingList = false;
    }
    if (main && (!previous?.main || (id && id !== previous?.id) ||
        (!id && main !== previous?.main))) {
      cancelChatMotion();
      pendingChat = { main, switching: !!(previous?.chats && previous.main),
        fromKey: previous?.contentKey || '' };
    } else if (pendingChat && main) pendingChat.main = main;
    else if (main && main !== previous?.main) prepareChat(main);
    /* The active model changes before React replaces the old conversation.
       Wait for its message identity to change, and don't replay when the same
       chat later replaces #main while filling its virtualised history. */
    if (pendingChat?.main === main && main?.querySelector(BODY) &&
        (!pendingChat.switching || !pendingChat.fromKey || contentKey !== pendingChat.fromKey)) {
      prepareChat(main);
      animateChat(main, pendingChat.switching);
      pendingChat = null;
    }
    if (!main) { cancelChatMotion(); pendingChat = null; }
    if (!chats) leavingChats = false;
    previous = { chats, main, id, contentKey };
  };
  view.addEventListener('click', event => {
    const state = rail();
    const button = event.target?.closest?.('button[aria-pressed]');
    if (!state || !button || !state.root.contains(button)) return;
    changeSection(button, state);
    if (state.selected === state.chats && button !== state.chats) {
      /* The native click closes the chat before updating aria-pressed. Keep
         that intermediate DOM commit from looking like a manual Close chat. */
      leavingChats = true;
      const mine = ++departure;
      view.setTimeout(() => {
        if (mine === departure) { leavingChats = false; update(); }
      }, 1000);
    }
  }, true);
  view.addEventListener('pointerdown', () => { lastInput = now(); }, true);
  view.addEventListener('keydown', event => {
    lastInput = now();
    if (event.key !== 'Escape' || event.repeat || event.isComposing ||
        event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    const mediaButton = mediaCloseButton();
    const state = rail();
    if (!mediaButton && (!state || state.selected === state.chats || layerIsUp(state))) return;
    /* The section's own capture handler can prevent Escape and do nothing on
       its first press. Handle this at document-start, ahead of that handler. */
    event.preventDefault();
    event.stopImmediatePropagation();
    const button = mediaButton || state.chats;
    if (!mediaButton) changeSection(button, state);
    let target = button;
    while (target.firstElementChild) target = target.firstElementChild;
    press(button, target);
  }, true);
  view.addEventListener('visibilitychange', () => {
    if (doc.visibilityState !== 'hidden') return;
    for (const animation of preparing) animation.cancel();
    preparing.clear();
    for (const animation of holding) animation.cancel();
    holding.clear();
    chatHold = null;
  });
  const scheduleUpdate = () => {
    if (updateQueued) return;
    if (typeof view.requestAnimationFrame !== 'function') { update(); return; }
    updateQueued = true;
    view.requestAnimationFrame(() => {
      updateQueued = false;
      update();
    });
  };
  const observer = new view.MutationObserver(records => {
    /* Closing is a navigation decision, not animation work. Clear its restore
       target in the removal microtask, before a fast tab change can restore
       the closed chat while the visual reconciliation waits for paint. */
    if (previous?.chats && previous.main && !leavingChats && records?.some(record =>
      [...(record.removedNodes || [])].some(node => node === previous.main || node.contains?.(previous.main))) &&
        !doc.querySelector('#main')) {
      const state = rail();
      if (state && state.selected === state.chats) {
        forgetClosedChat();
        cancelChatMotion();
        pendingChat = null;
        previous = { ...previous, main: null, id: '', contentKey: '' };
      }
    }
    /* Message text, ticks, and list previews cannot change the selected tab or
       mount a conversation. Avoid scanning every drawer for those updates.
       A pending conversation still needs its first content commit. */
    if (!pendingChat && !pendingList && records?.length && records.every(record =>
      record.target?.closest?.(MESSAGES + ', #pane-side')))
      return;
    /* React can commit the rail, drawers and conversation in separate batches.
       Reconcile once before paint, after those commits, rather than starting
       an animation in each microtask while the new page is still being built. */
    scheduleUpdate();
  });
  /* The parser can replace the document-start html element. Watching the
     document also covers that replacement and the first conversation mount. */
  observer.observe(doc, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['aria-pressed'],
  });
  quietNativeMotion();
  update();
};

module.exports = { start };
