'use strict';

const assert = require('assert');
const { start } = require('../src/page/navigation.js');

const rig = ({ reduced = false, rtl = false, registry = true, beforeHtml = false, deferRestore = false, scheduled = false, preparation = false } = {}) => {
  const handlers = {};
  let update, selected, main = null, active = '', last = 'old', cancelled = 0;
  let layers = [], covered = false, back = false;
  let media = false, mediaSearch = false;
  let meList = null;
  let panelNodes = [], bodyReady = true;
  let messageKey = '';
  /* What WhatsApp's store says about the open chat's history, and how many
     rows the conversation draws. */
  let history = null, rowCount = 1;
  let animations = [], presses = 0, timers = [], frames = [], restores = 0;
  let clock = 1000;
  const restore = { cancelPendingLastActiveChatRestore: () => cancelled++,
    openLastActiveChatIfNotLocked: () => { restores++; return Promise.resolve(); } };
  const animatedElement = name => ({
    name, isConnected: true, attributes: {},
    setAttribute(key, value) { this.attributes[key] = value; },
    getAttribute(key) { return this.attributes[key] ?? null; },
    removeAttribute(key) { delete this.attributes[key]; },
    animate(frames, options) {
      const a = { target: this, frames, options, cancel() { this.cancelled = true; this.playState = 'idle'; } };
      if (preparation) {
        a.playState = 'running';
        a.pause = () => { a.playState = 'paused'; };
        a.play = () => { a.playState = 'running'; a.played = true; };
      }
      animations.push(a); return a;
    },
  });
  const list = animatedElement('list');
  list.firstElementChild = {};
  const sectionContainer = {};
  // Each button closes over its own selected state, just as aria-pressed does.
  const makeButton = icon => {
    const b = {
      getAttribute: () => selected === b ? 'true' : 'false',
      querySelectorAll: () => [{ textContent: icon }],
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 40, height: 40 }),
      contains: e => e === b,
      closest: () => b,
    };
    return b;
  };
  const chats = makeButton('wds-ic-chat-filled');
  const section = makeButton('wds-ic-communities');
  const other = makeButton('wds-ic-status');
  selected = chats;
  const root = { querySelectorAll: () => [chats, section, other], contains: e => e === chats || e === section || e === other };
  const mediaButton = makeButton('ic-close');
  const mediaPanel = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    getClientRects: () => [1],
    contains: el => el === mediaPanel,
    querySelectorAll: () => [mediaButton],
    querySelector: () => mediaSearch ? {} : null,
  };
  const document = {
    documentElement: beforeHtml ? null : { getAttribute: () => rtl ? 'rtl' : 'ltr' },
    querySelector: selector => selector === '#main' ? main
      : selector === '#pane-side' ? list
      : selector === '[data-testid="media-hub-modal"]' ? (media ? mediaPanel : null)
      : selector.includes('me-tab-drawer') ? meList
      : selector === '[data-testid="chatlist-header"]' ? root
      : selector.includes('drawer-left') && back ? { querySelectorAll: () => [{ textContent: 'ic-arrow-back' }] } : null,
    querySelectorAll: selector => selector.startsWith('[data-testid="drawer-left"]') ? panelNodes : layers,
    elementFromPoint: () => covered ? {} : media ? mediaPanel : chats,
  };
  const view = {
    document,
    performance: { now: () => clock },
    matchMedia: () => ({ matches: reduced }),
    addEventListener: (type, cb) => { handlers[type] = cb; },
    setTimeout: cb => timers.push(cb),
    ...(deferRestore || scheduled ? { requestAnimationFrame: cb => frames.push(cb) } : {}),
    MutationObserver: class {
      constructor(cb) { update = cb; }
      observe(target) { assert.equal(target, document, 'startup observes the document before html exists'); }
    },
    require: name => {
      if (!registry) throw new Error('private module renamed');
      if (name === 'WAWebChatCollection') return { ChatCollection: { getActive: () => active
        ? { id: active, ...(history ? { msgs: { length: history.length, msgLoadState: history } } : {}) } : null } };
      if (name === 'WAWebSideNavButtonsActivityModel') return { setLastActiveChat: value => { last = value; } };
      if (name === 'WAWebOpenLastActiveChatAction') return restore;
      return null;
    },
  };
  start({ window: view, log() {}, press: button => {
    presses++;
    if (button === mediaButton) media = false;
    else selected = chats;
    update();
  } });
  const key = extra => {
    const e = { key: 'Escape', preventDefault() { this.prevented = true; },
      stopImmediatePropagation() { this.stopped = true; }, ...extra };
    handlers.keydown(e);
    return e;
  };
  return {
    key, update,
    open: (id, replace = false, commit = true) => {
      document.documentElement ||= { getAttribute: () => rtl ? 'rtl' : 'ltr' };
      active = id;
      if (commit) messageKey = id;
      if (!main || replace) {
        const body = animatedElement('body'), messages = animatedElement('messages'), header = animatedElement('header'), footer = animatedElement('footer');
        messages.querySelector = () => ({ getAttribute: () => messageKey });
        messages.querySelectorAll = () => new Array(rowCount).fill({});
        main = animatedElement('frame');
        main.querySelector = selector => selector.includes('conversation-panel-body') ? (bodyReady ? body : null)
          : selector.includes('conversation-panel-messages') ? (bodyReady ? messages : null)
          : selector === 'header > div' ? header : selector === 'footer > div' ? footer : null;
      }
      update();
    },
    commitMessages: id => { messageKey = id; update(); },
    close: () => {
      const removed = main; main = null; active = '';
      update([{ type: 'childList', removedNodes: removed ? [removed] : [] }]);
    },
    leave: () => {
      handlers.click({ target: section });
      last = active; main = null; active = '';
      update(); // Native code closes the chat before switching aria-pressed.
      selected = section; update();
    },
    returnByClick: (restoreChat = false) => {
      handlers.click({ target: chats }); selected = chats;
      const pending = restoreChat ? restore.openLastActiveChatIfNotLocked() : null;
      update(); return pending;
    },
    nativeRestore: () => restore.openLastActiveChatIfNotLocked(),
    paint: () => { const pending = frames; frames = []; pending.forEach(cb => cb()); },
    hide: () => { document.visibilityState = 'hidden'; handlers.visibilitychange(); },
    mutate: target => update([{ type: 'childList', target }]),
    selectSection: () => { selected = section; update(); },
    addPanel: (placeholder = false, page = 'section-drawer', behind = false) => {
      const panel = animatedElement('panel');
      panel.closest = () => sectionContainer;
      panel.firstElementChild = animatedElement('panel-content');
      panel.page = page;
      panel.querySelector = () => panel.page === null ? null
        : { getAttribute: () => panel.page,
            matches: selector => selector.includes('loading-spinner') ? panel.page === 'loading-spinner' : placeholder };
      if (behind) panelNodes.push(panel); else panelNodes.unshift(panel);
      update(); return panel;
    },
    showPage: (panel, page) => { panel.page = page; update(); },
    pointer: () => handlers.pointerdown({}),
    later: ms => { clock += ms; },
    settle: () => animations.forEach(a => { if (a.playState !== 'idle') a.playState = 'finished'; }),
    removePanel: panel => { panel.isConnected = false; panelNodes = panelNodes.filter(p => p !== panel); update(); },
    setBodyReady: ready => { bodyReady = ready; update(); },
    setHistory: state => { history = state; },
    setRows: n => { rowCount = n; },
    clickSection: () => handlers.click({ target: section }),
    clickOther: () => handlers.click({ target: other }),
    selectOther: () => { selected = other; update(); },
    setListReady: ready => { list.firstElementChild = ready ? {} : null; update(); },
    setLayer: on => { layers = on ? [{ contains: () => false, getBoundingClientRect: () => ({ width: 20, height: 20 }), getClientRects: () => [1] }] : []; },
    setMedia: on => { media = on; },
    setMediaSearch: on => { mediaSearch = on; },
    setMeList: on => {
      meList = on ? { getBoundingClientRect: () => ({ width: 400, height: 600 }), getClientRects: () => [1] } : null;
      layers = meList ? [meList] : [];
    },
    setCovered: on => { covered = on; },
    setBack: on => { back = on; },
    drain: () => { const pending = timers; timers = []; pending.forEach(cb => cb()); },
    get state() { return { last, cancelled, animations, presses, restores }; },
  };
};

const r = rig();
r.open('a');
assert.deepEqual(r.state.animations.map(a => a.target.name), ['messages', 'header', 'footer'], 'the first opening keeps its lateral entrance without moving the frame or wallpaper');
r.update();
assert.equal(r.state.animations.length, 3, 'messages and timestamps do not replay entrance motion');
r.open('b');
assert.deepEqual(r.state.animations.slice(3).map(a => a.target.name), ['messages', 'header'], 'switching reuses the scroll layer and identity, keeping the body, frame and composer fixed');
assert.ok(r.state.animations.slice(0, 3).every(a => a.cancelled), 'rapid switches cancel the first entrance');
r.open('b');
assert.equal(r.state.animations.length, 5, 'clicking the current chat does not replay its animation');
r.open('c', true);
assert.equal(r.state.animations.length, 7, 'a replacement #main uses the same quiet swap as a reused #main');
assert.ok(r.state.animations.slice(3, 5).every(a => a.cancelled), 'a rapid swap cancels the previous content reveal');
r.leave();
assert.equal(r.state.last, 'c', 'leaving Chats preserves the still-open chat');
r.drain();
assert.equal(r.state.last, 'c', 'settling another tab preserves its return target');
let e = r.key({ defaultPrevented: true });
assert.ok(e.prevented && e.stopped && r.state.presses === 1, 'one Escape returns even when native code prevented it');
r.open('b');
r.close();
assert.equal(r.state.last, null, 'manual close clears the restore target');
assert.ok(r.state.cancelled >= 2, 'manual close cancels an asynchronous restore');
r.selectSection();
r.key();
assert.equal(r.state.last, null, 'Escape does not revive a closed chat');
r.selectSection();
r.returnByClick();
assert.equal(r.state.last, null, 'clicking Chats also respects manual close');
r.selectSection();
for (const guard of ['setLayer', 'setCovered', 'setBack']) {
  r[guard](true);
  const before = r.state.presses;
  assert.ok(!r.key().stopped && r.state.presses === before, guard + ' keeps Escape with the foreground layer');
  r[guard](false);
}
for (const modifiers of [{ repeat: true }, { isComposing: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }])
  assert.ok(!r.key(modifiers).stopped, 'modified/repeated Escape does not navigate');
const reduced = rig({ reduced: true });
reduced.open('a');
assert.equal(reduced.state.animations.length, 0, 'reduced motion disables chat entrance');
reduced.selectSection();
assert.ok(reduced.key().stopped, 'reduced motion still allows navigation');
const rtl = rig({ rtl: true });
rtl.open('a');
assert.equal(rtl.state.animations[0].frames[0].transform, 'translate3d(-14px, 0, 0)', 'Arabic entrance follows the interface direction');
const fallback = rig({ registry: false });
fallback.open('a'); fallback.close(); fallback.selectSection();
assert.ok(fallback.key().stopped, 'navigation still works if private WhatsApp modules disappear');
const modal = rig();
modal.setMedia(true);
assert.ok(modal.key({ defaultPrevented: true }).stopped, 'Media closes on its first Escape while Chats remains selected');
assert.equal(modal.state.presses, 1);
modal.setMedia(true); modal.setLayer(true);
assert.ok(!modal.key().stopped, 'a menu in Media receives Escape before the modal');
modal.setLayer(false); modal.setMediaSearch(true);
assert.ok(!modal.key().stopped, 'search in Media receives Escape before the modal');
const me = rig();
me.selectSection(); me.setMeList(true);
assert.ok(me.key().stopped, 'the permanent You list is a section, not a popup layer');
const early = rig({ beforeHtml: true });
early.open('a');
assert.equal(early.state.animations.length, 3, 'the first chat animates after document-start without an html root');
const delayed = rig();
delayed.setBodyReady(false); delayed.open('a');
assert.equal(delayed.state.animations.length, 0, 'an incomplete mount does not animate an empty frame');
delayed.setBodyReady(true);
assert.equal(delayed.state.animations.length, 3, 'motion starts when the conversation content commits');
delayed.close(); delayed.setBodyReady(false); delayed.open('b'); delayed.close(); delayed.setBodyReady(true);
assert.equal(delayed.state.animations.length, 3, 'closing a pending chat cannot replay a stale entrance');
const sections = rig();
sections.selectSection();
const firstPanel = sections.addPanel();
assert.equal(firstPanel.attributes['data-wa-navigation-panel'], 'active');
assert.equal(sections.state.animations.at(-1).target, firstPanel,
  'the panel itself moves: positioned and drawer-sized, it is a box the compositor takes whole');
sections.update();
assert.equal(sections.state.animations.length, 1, 'section content mutations do not replay its entrance');
sections.showPage(firstPanel, 'calls-tab-drawer');
assert.equal(sections.state.animations.length, 1,
  'a loading page turning into the section while its reveal runs joins that reveal instead of fading in twice');
sections.settle(); sections.later(2000);
sections.showPage(firstPanel, 'section-drawer');
assert.equal(sections.state.animations.length, 1, 'WhatsApp swapping a page by itself, long after any input, is not animated');
sections.pointer(); sections.later(65);
sections.showPage(firstPanel, 'account-settings-drawer');
assert.equal(sections.state.animations.length, 2, 'a settings page the owner opened inside the same panel gets its own reveal');
sections.update();
assert.equal(sections.state.animations.length, 2, 'a page filling in under the same test id keeps the reveal already running');
sections.settle(); sections.later(500); sections.key({ key: 'Tab' }); sections.later(70);
sections.showPage(firstPanel, 'section-drawer');
assert.equal(sections.state.animations.length, 3, 'Back from a key is a page change too');
const profilePanel = sections.addPanel();
assert.equal(firstPanel.attributes['data-wa-navigation-panel'], 'inactive', 'a nested page retires the prior wrapper even with the same rail selection');
assert.equal(profilePanel.attributes['data-wa-navigation-panel'], 'active', 'the nested page gets its own reveal');
sections.key();
assert.equal(firstPanel.attributes['data-wa-navigation-panel'], 'inactive', 'returning to Chats hides the retiring section before native unmount');
assert.ok(sections.state.animations.slice(0, 3).every(a => a.cancelled || a.playState === 'finished'), 'returning during a section reveal cancels it');
sections.selectSection();
const secondPanel = sections.addPanel();
assert.equal(secondPanel.attributes['data-wa-navigation-panel'], 'active', 'reopening a section gets a fresh reveal');
const secondAnimation = sections.state.animations.at(-1);
sections.removePanel(secondPanel);
assert.ok(secondAnimation.cancelled, 'removing an animated section cancels its motion');
assert.equal(profilePanel.attributes['data-wa-navigation-panel'], 'active', 'a retained page becomes visible again when returning from a nested page');
const holding = rig();
holding.selectSection();
const youPanel = holding.addPanel(false, 'me-tab-drawer');
const incoming = holding.addPanel(false, null);
assert.equal(youPanel.attributes['data-wa-navigation-panel'], 'active',
  'an empty incoming wrapper leaves the page it replaces on screen: no blank frames before Profile');
assert.ok(!incoming.attributes['data-wa-navigation-panel'], 'and takes nothing over until it has a page');
holding.showPage(incoming, 'profile-drawer');
assert.equal(youPanel.attributes['data-wa-navigation-panel'], 'inactive');
assert.equal(incoming.attributes['data-wa-navigation-panel'], 'active');
assert.equal(holding.state.animations.at(-1).target, incoming, 'Profile is revealed the moment its page exists');
const returning = rig({ deferRestore: true });
returning.open('a'); returning.paint(); returning.leave(); returning.paint();
returning.returnByClick(true);
assert.equal(returning.state.restores, 1,
  'the conversation is restored in the same task as the tab change, as WhatsApp does it: deferred, its rebuild landed in the middle of the list reveal');
returning.paint();
assert.equal(returning.state.animations.at(-1).options.duration, 220, 'Chats uses the same duration as the other sections');
assert.equal(returning.state.animations.at(-1).frames[0].opacity, 0, 'Chats gets the full section reveal');
const lateList = rig();
lateList.setListReady(false); lateList.selectSection(); lateList.returnByClick();
assert.equal(lateList.state.animations.length, 0, 'a loading list does not consume the return animation');
lateList.setListReady(true);
assert.equal(lateList.state.animations.length, 1, 'Chats reveals when its content is ready');
lateList.mutate({ closest: () => ({}) });
assert.equal(lateList.state.animations.length, 1, 'a preview update does not restart navigation');
const batched = rig({ scheduled: true });
batched.open('a'); batched.open('b'); batched.update();
assert.equal(batched.state.animations.length, 0, 'separate commits wait for a single paint');
batched.paint();
assert.equal(batched.state.animations.length, 3, 'only the final conversation gets an entrance');
batched.open('c'); batched.close(); batched.paint();
assert.equal(batched.state.animations.length, 3, 'closing before paint cancels a pending entrance');
batched.selectSection(); batched.addPanel(); batched.returnByClick(); batched.paint();
assert.equal(batched.state.animations.filter(a => a.target.name === 'panel').length, 0,
  'a section abandoned before paint never animates over Chats');
const prepared = rig({ scheduled: true, preparation: true });
prepared.open('a'); prepared.paint();
assert.ok(prepared.state.animations.every(a => a.playState === 'paused'), 'the first layout prepares the scroll layer before starting the reveal');
prepared.paint();
assert.ok(prepared.state.animations.every(a => a.played), 'the reveal starts after its prepared frame');
prepared.open('b'); prepared.paint(); prepared.hide(); prepared.paint();
assert.ok(prepared.state.animations.slice(3).every(a => a.cancelled && !a.played),
  'hiding during preparation settles content instead of replaying a stale reveal on return');
const staged = rig();
staged.open('a'); staged.open('b', false, false);
assert.equal(staged.state.animations.length, 3, 'an early active-model change cannot animate the old messages');
staged.commitMessages('b');
assert.equal(staged.state.animations.length, 5, 'the newly committed conversation gets exactly one reveal');
staged.open('b', true);
assert.equal(staged.state.animations.length, 5, 'a second DOM mount for the same chat does not replay the reveal');
staged.open('c', false, false); staged.close(); staged.commitMessages('c');
assert.equal(staged.state.animations.length, 5, 'closing between model selection and message commit cancels the reveal');
const background = rig();
background.selectSection(); background.addPanel(true);
assert.equal(background.state.animations.length, 0, 'a full-size welcome background is never promoted for a tab reveal');
const rapidClose = rig({ scheduled: true });
rapidClose.open('a'); rapidClose.paint(); rapidClose.close();
assert.equal(rapidClose.state.last, null, 'a closed chat is forgotten before visual reconciliation paints');
rapidClose.leave(); rapidClose.returnByClick(); rapidClose.paint();
assert.ok(!rapidClose.state.last, 'closing then changing tabs before paint cannot revive the conversation');
/* WhatsApp's own motion of a panel -- the 50ms fade, the 300ms slide on
   Channels -- goes through with no duration and no fill, so the reveal is the
   only animation of that panel and the compositor takes it whole. Anything
   else that animates is untouched. */
{
  const calls = [];
  class FakeElement {
    constructor(panel) { this.panel = panel; }
    matches() { return this.panel; }
  }
  FakeElement.prototype.animate = function (frames, options) {
    calls.push({ target: this, frames, options });
    return { cancel() {}, playState: 'running' };
  };
  start({ log() {}, press() {}, window: {
    Element: FakeElement,
    document: { documentElement: null, querySelector: () => null, querySelectorAll: () => [] },
    matchMedia: () => ({ matches: false }),
    addEventListener() {}, setTimeout() {},
    MutationObserver: class { observe() {} },
  } });
  const panel = new FakeElement(true), other = new FakeElement(false);
  panel.animate([{ opacity: '0.5' }, { opacity: '1' }],
                { duration: 50, delay: 0, easing: 'cubic-bezier(0.14, 0.62, 0.33, 0.9)', fill: 'forwards' });
  assert.deepEqual([calls[0].options.duration, calls[0].options.fill, calls[0].options.easing],
    [0, 'none', 'cubic-bezier(0.14, 0.62, 0.33, 0.9)'], 'the native panel fade finishes on the spot and leaves no value behind');
  other.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 50, fill: 'forwards' });
  assert.equal(calls[1].options.duration, 50, 'a fade on anything that is not a panel is left to WhatsApp');
  panel.animate([{ transform: 'translateX(-100%)' }, { transform: 'translateX(0%)' }],
                { duration: 300, delay: 0, easing: 'cubic-bezier(0.1, 0.82, 0.25, 1)', fill: 'forwards' });
  assert.deepEqual([calls[2].options.duration, calls[2].options.fill], [0, 'none'],
    'the native slide Channels gets is quieted the same way: two transforms on one panel put the reveal on the main thread');
  panel.animate([{ maxHeight: '0px' }, { maxHeight: '90px' }], { duration: 120 });
  assert.equal(calls[3].options.duration, 120, 'an animation of anything but motion is not the panel transition, and is left alone');
  panel.animate({ opacity: [0.5, 1] }, 50);
  assert.deepEqual(calls[4].options, { duration: 0, fill: 'none' }, 'the property-indexed form with a bare duration is the same fade');
}

/* A section's first visit. WhatsApp stands its loading drawer in for a
   section whose code is still coming -- 40-80ms with the code in the page --
   and on Channels and Communities an empty wrapper, with the old section
   already taken down. Measured: the spinner flashed, and between two sections
   the chat list showed through for 60-130ms. */
{
  const quick = rig();
  quick.clickSection(); quick.selectSection();
  const spinner = quick.addPanel(false, 'loading-spinner');
  assert.equal(spinner.attributes['data-wa-navigation-panel'], 'waiting', 'the loading drawer is kept out of sight');
  assert.equal(quick.state.animations.length, 0, 'and nothing moves for it');
  quick.later(60); quick.showPage(spinner, 'status-tab-drawer');
  assert.equal(spinner.attributes['data-wa-navigation-panel'], 'active');
  assert.equal(quick.state.animations.at(-1).target, spinner, 'the section is revealed the moment it replaces the stand-in');

  const slow = rig();
  slow.clickSection(); slow.selectSection();
  const loading = slow.addPanel(false, 'loading-spinner');
  slow.later(320); slow.drain();
  assert.equal(loading.attributes['data-wa-navigation-panel'], 'active', 'a loading drawer still up after its grace is shown');
  assert.equal(slow.state.animations.length, 0, 'standing still: a spinner fading in is two motions for one wait');
  slow.later(1500); slow.showPage(loading, 'status-tab-drawer');
  assert.equal(slow.state.animations.length, 1, 'the section it stood in for gets its reveal however long it took');

  const between = rig();
  between.clickSection(); between.selectSection();
  const status = between.addPanel(false, 'status-tab-drawer');
  between.clickOther(); between.removePanel(status); between.selectOther();
  const empty = between.addPanel(false, null);
  assert.equal(empty.attributes['data-wa-navigation-panel'], 'pending',
    'between two sections the surface is held: the chat list never shows through on the way');
  between.showPage(empty, 'newsletter-tab-drawer');
  assert.equal(empty.attributes['data-wa-navigation-panel'], 'active');
  assert.equal(between.state.animations.at(-1).target, empty);

  const fromChats = rig();
  fromChats.clickSection(); fromChats.selectSection();
  const blank = fromChats.addPanel(false, null);
  assert.ok(!blank.attributes['data-wa-navigation-panel'],
    'from Chats an empty wrapper takes nothing over: the list the eye is on stays until the section is there');

  const kept = rig();
  kept.clickSection(); kept.selectSection();
  const old = kept.addPanel(false, 'status-tab-drawer');
  kept.clickOther(); kept.selectOther();
  assert.equal(old.attributes['data-wa-navigation-panel'], 'active', 'the page on screen stays while the next is being built');
  const next = kept.addPanel(false, 'newsletter-tab-drawer');
  assert.equal(old.attributes['data-wa-navigation-panel'], 'inactive', 'and goes in the frame the next one is up');
  assert.equal(next.attributes['data-wa-navigation-panel'], 'active');

  const stuck = rig();
  stuck.clickSection(); stuck.selectSection();
  stuck.clickOther(); stuck.selectOther();
  const late = stuck.addPanel(false, null);
  assert.equal(late.attributes['data-wa-navigation-panel'], 'pending');
  stuck.later(800); stuck.drain();
  assert.equal(late.attributes['data-wa-navigation-panel'], 'active', 'nothing is held for long: whatever is there is shown');

  /* A wrapper seen first behind the page on screen, then left in front when
     that page goes: its wait is timed from then, and ends. */
  const sibling = rig();
  sibling.clickSection(); sibling.selectSection();
  const shown = sibling.addPanel(false, 'status-tab-drawer');
  const behind = sibling.addPanel(false, 'loading-spinner', true);
  assert.equal(behind.attributes['data-wa-navigation-panel'], 'inactive');
  sibling.removePanel(shown);
  assert.equal(behind.attributes['data-wa-navigation-panel'], 'pending',
    'the page it stood behind gone, the surface is held rather than the chat list shown');
  sibling.later(320); sibling.drain();
  assert.equal(behind.attributes['data-wa-navigation-panel'], 'active', 'and its grace runs out like any other');

  /* A section that never draws in these drawers does not leave the old one
     standing over it. */
  const elsewhere = rig();
  elsewhere.clickSection(); elsewhere.selectSection();
  const stays = elsewhere.addPanel(false, 'status-tab-drawer');
  elsewhere.clickOther(); elsewhere.selectOther();
  assert.equal(stays.attributes['data-wa-navigation-panel'], 'active');
  elsewhere.later(800); elsewhere.drain();
  assert.equal(stays.attributes['data-wa-navigation-panel'], 'inactive', 'past the longest hold the old section goes');
}

/* A conversation whose history is still on its way. WhatsApp keeps one
   message per chat in memory and fetches the rest as the chat opens: the
   entrance ran on that one row and a spinner, and the history then simply
   appeared. */
{
  const idle = { isLoadingEarlierMsgs: false, isLoadingRecentMsgs: false, isLoadingAroundMsgs: false, noEarlierMsgs: false };
  const coming = rig({ scheduled: true, preparation: true });
  coming.setHistory({ ...idle, length: 1 }); coming.setRows(1);
  coming.open('a'); coming.paint();
  const [held, ...rest] = coming.state.animations;
  assert.equal(held.target.name, 'messages');
  assert.deepEqual([held.frames[0].opacity, held.playState], [0, 'paused'], 'the messages wait out of sight');
  assert.deepEqual(rest.map(a => a.target.name), ['header', 'footer']);
  coming.setHistory({ ...idle, length: 1, isLoadingEarlierMsgs: true }); coming.paint();
  assert.ok(rest.every(a => a.played), 'the header and composer make their entrance meanwhile');
  assert.equal(held.playState, 'paused', 'while the history loads, the messages hold');
  coming.setHistory({ ...idle, length: 22 }); coming.paint();
  assert.equal(held.playState, 'paused', 'the store having it is not the screen having it');
  coming.setRows(22); coming.paint();
  assert.ok(held.played, 'the messages rise in when their rows land');

  const none = rig({ scheduled: true, preparation: true });
  none.setHistory({ ...idle, length: 3 }); none.open('a'); none.paint(); none.paint();
  none.later(200); none.paint();
  assert.ok(none.state.animations[0].played, 'a load that never begins holds nothing for long');

  const slowLoad = rig({ scheduled: true, preparation: true });
  slowLoad.setHistory({ ...idle, length: 1, isLoadingEarlierMsgs: true }); slowLoad.open('a'); slowLoad.paint(); slowLoad.paint();
  slowLoad.later(700); slowLoad.paint();
  assert.ok(slowLoad.state.animations[0].played, 'a slow fetch is shown as it is -- spinner and all -- past the hold');

  const loaded = rig({ scheduled: true, preparation: true });
  loaded.setHistory({ ...idle, length: 51 }); loaded.open('a'); loaded.paint();
  assert.equal(loaded.state.animations[0].frames[0].transform, 'translate3d(14px, 0, 0)',
    'a chat whose history is in memory makes its usual entrance');

  const switching = rig({ scheduled: true, preparation: true });
  switching.setHistory({ ...idle, length: 51 }); switching.open('a'); switching.paint(); switching.paint();
  switching.setHistory({ ...idle, length: 1 }); switching.open('b'); switching.paint();
  const swap = switching.state.animations.slice(3);
  assert.equal(swap[0].frames[0].opacity, 0, 'switching to a chat not yet loaded holds its messages too');
  assert.equal(swap[0].playState, 'paused');
  switching.open('c'); switching.paint();
  assert.ok(swap[0].cancelled, 'a rapid switch lets go of the held messages with the rest');

  const hidden = rig({ scheduled: true, preparation: true });
  hidden.setHistory({ ...idle, length: 1 }); hidden.open('a'); hidden.paint(); hidden.hide();
  assert.ok(hidden.state.animations[0].cancelled, 'a window going away shows the messages as they are');
}

console.log('navigation checks pass');
