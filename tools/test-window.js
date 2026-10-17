/*
 * A notification click must bring the window back, without taking an already
 * arriving window down again. Replay the real controller from main.js against
 * window events and a virtual clock: no Electron process, account or desktop.
 * The compositor can refuse focus requests here, which is the case a test
 * window that always focuses itself would never exercise.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const start = main.indexOf('const clampToScreen =');
const end = main.indexOf('const toggleWindow =', start);
if (start < 0 || end < 0) throw new Error('Could not find the window controller in main.js');
const controller = main.slice(start, end);

let failures = 0;
const check = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log('  ok   ' + label);
    return;
  }
  failures++;
  console.log('  FAIL ' + label + '\n         got  ' + JSON.stringify(got) +
              '\n         want ' + JSON.stringify(want));
};

const build = ({ wayland = true, strategy = 'auto' } = {}) => {
  let now = 10000;
  let nextTimer = 0;
  const timers = new Map();
  const calls = [];
  const state = { visible: false, minimized: false, focused: false, destroyed: false };
  const win = new EventEmitter();
  Object.assign(win, {
    isVisible: () => state.visible,
    isMinimized: () => state.minimized,
    isFocused: () => state.focused,
    isDestroyed: () => state.destroyed,
    hide() {
      calls.push('hide');
      state.visible = false;
      state.focused = false;
      win.emit('hide');
    },
    show() {
      calls.push('show');
      state.visible = true;
      win.emit('show');
    },
    restore() {
      calls.push('restore');
      state.minimized = false;
      win.emit('restore');
    },
    /* A request is not a grant. Only the test's focus event grants it. */
    focus() { calls.push('focus'); },
    webContents: { send() {} },
  });
  const context = vm.createContext({
    win,
    onWayland: wayland,
    config: { get: key => key === 'behaviour.raise' ? strategy : undefined },
    tray: null,
    lock: { recordActivity() {} },
    shield: { setWindowFocus() {} },
    applyShield() {},
    withdrawOpen() {},
    withdrawRinging() {},
    debug: { trace() {} },
    console: { log() {} },
    electronScreen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
    Date: { now: () => now },
    setTimeout(fn, delay) {
      const id = ++nextTimer;
      timers.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(controller + '\ntraceWindowState();\n' +
    'globalThis.controls = { show: showWindow, click: showWindowForClick, hide: hideWindow };',
  context, { filename: 'main.js (window controller)' });

  const tick = duration => {
    const until = now + duration;
    let turns = 0;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      if (++turns > 10000) throw new Error('Window controller kept scheduling immediate work');
      now = due[1].at;
      timers.delete(due[0]);
      due[1].fn();
    }
    now = until;
  };
  const show = () => { state.visible = true; win.emit('show'); };
  const focus = () => { state.focused = true; win.emit('focus'); };
  const blur = () => { state.focused = false; win.emit('blur'); };
  const minimize = () => { state.minimized = true; state.focused = false; win.emit('minimize'); };
  return { ...context.controls, state, calls, tick, showEvent: show, focus, blur, minimize };
};

{
  const t = build();
  t.showEvent();
  t.focus();
  t.click('notification while reading');
  t.tick(5000);
  check('a notification in the focused window never remaps it',
        t.calls.filter(call => call === 'hide' || call === 'show'), []);
}

{
  const t = build();
  t.showEvent();
  t.focus();
  t.blur();
  t.tick(50);
  t.click('notification just after shell took focus');
  check('the tray blur grace does not trigger a native focus request', t.calls, []);
  t.tick(2200);
  check('recently blurred does not count as a successful notification activation',
        t.calls.includes('hide'), true);
}

{
  const t = build();
  t.showEvent();
  t.click('notification while the shell is handing over');
  t.tick(1200);
  t.focus();
  t.tick(4000);
  check('a delayed shell activation keeps the existing window mapped', t.calls, []);
}

{
  const t = build();
  t.showEvent();
  t.click('notification followed by a quick switch to another application');
  t.tick(1250);
  t.focus();
  t.tick(10);
  t.blur();
  t.tick(5000);
  check('a real focus event completes the click even if the user immediately leaves',
        t.calls, []);
}

{
  const t = build();
  t.showEvent();
  t.click('notification');
  t.tick(1500);
  t.click('the page asked for the focus');
  t.tick(700);
  check('the page focus request cannot restart the notification fallback deadline',
        t.calls.includes('hide'), true);
}

{
  const t = build();
  t.click('notification while hidden and shell still owns the keyboard');
  check('a hidden Wayland window is mapped immediately',
        t.calls.slice(0, 2), ['hide', 'show']);
  t.tick(500);
  check('the shell grab does not trigger a second raise after 250ms',
        t.calls.filter(call => call === 'show').length, 1);
  t.focus();
  t.tick(2500);
  check('focus arriving after the grab does not cause another remap',
        t.calls.filter(call => call === 'hide').length, 1);
}

{
  const t = build();
  t.showEvent();
  t.minimize();
  t.click('notification while minimized');
  check('a minimized Wayland window is restored while hidden before it is shown',
        t.calls.slice(0, 3), ['hide', 'restore', 'show']);
}

{
  const t = build();
  /* A non-notification raise can learn activate while a menu holds the focus.
     That observation must not strand the next notification on Wayland. */
  t.show('an earlier tray click');
  t.tick(1000);
  t.calls.length = 0;
  t.click('a later notification while behind another window');
  t.tick(5000);
  check('a failed learned activation does not leave a notification without a remap',
        t.calls.includes('hide'), true);
}

{
  const t = build();
  t.showEvent();
  t.click('notification');
  t.tick(500);
  t.hide();
  /* A later show need not mean the user wants focus: the pending notification
     must have been cancelled, not merely waiting to see a visible window. */
  t.showEvent();
  t.calls.length = 0;
  t.tick(5000);
  check('an explicit hide cancels a notification even if the window is shown later',
        t.calls, []);
}

{
  const t = build();
  t.showEvent();
  t.click('notification');
  t.tick(500);
  t.minimize();
  t.showEvent();
  t.state.minimized = false;
  t.calls.length = 0;
  t.tick(5000);
  check('a user minimize cancels the pending notification activation', t.calls, []);
}

{
  const t = build({ wayland: false });
  t.showEvent();
  t.click('notification under X11');
  check('X11 requests focus immediately on a notification click',
        t.calls.slice(0, 2), ['show', 'focus']);
  t.tick(900);
  check('X11 first asks for activation without hiding the window',
        t.calls.includes('hide'), false);
  t.focus();
  t.tick(4000);
  check('a granted X11 activation needs no remap', t.calls.includes('hide'), false);
}

{
  const t = build({ wayland: false });
  t.showEvent();
  t.click('notification whose ordinary activation is refused');
  t.tick(7000);
  /* Every 500ms over the primary and recovery windows: 0, 0.5 ... 3.5s. */
  check('a refused X11 activation is asked for again until the click runs out',
        t.calls.filter(call => call === 'focus').length, 8);
  /* The window the shell is still holding the keyboard from is on the screen
     already: taking it down and putting it back up is the window closing and
     reopening itself, and it cannot take the focus through the grab either. */
  check('a refused X11 activation never takes the window down',
        t.calls.includes('hide'), false);
  const finished = t.calls.slice();
  t.tick(20000);
  check('rejected activation attempts stop instead of asking forever', t.calls, finished);
}

{
  const t = build({ wayland: false });
  t.click('notification centre click while the client is in the tray');
  t.tick(2500);
  /* show() on a window already up is part of an ask and maps nothing; only a
     hide would take it down. */
  check('a window mapped behind a shell grab stays up on X11', t.state.visible, true);
  check('and is never taken down while it waits', t.calls.includes('hide'), false);
  const asked = t.calls.filter(call => call === 'focus').length;
  t.focus();
  t.tick(5000);
  check('focus arriving when the grab is released finishes the click',
        t.calls.filter(call => call === 'focus').length, asked);
}

{
  const t = build({ wayland: false });
  t.showEvent();
  t.click('notification centre click, window behind another app, menu held open');
  t.tick(3100);
  /* The menu closes and the focus goes back where it was: the next ask is the
     one that is granted. */
  const before = t.calls.filter(call => call === 'focus').length;
  t.tick(500);
  check('an X11 window left unfocused after the grab is asked again within 500ms',
        t.calls.filter(call => call === 'focus').length, before + 1);
  t.focus();
  t.tick(5000);
  check('and is left alone once it has the focus',
        t.calls.filter(call => call === 'focus').length, before + 1);
  check('and was never taken down', t.calls.includes('hide'), false);
}

{
  const t = build();
  t.click('notification on Wayland while hidden, refused throughout');
  t.tick(10000);
  /* A refused ask on Wayland is "WhatsApp is ready" in the shell; asking on a
     timer would post it again and again. One re-map, one ask, done. */
  check('Wayland never repeats an unanswered ask',
        t.calls.filter(call => call === 'focus').length, 2);
}

{
  const t = build();
  t.showEvent();
  t.click('notification on Wayland, shell never activates');
  t.tick(2100);
  check('Wayland still re-maps a window the shell left behind',
        t.calls.filter(call => call === 'hide').length, 1);
  t.tick(5000);
  check('and recovers from a failed re-map by asking, once',
        t.calls.filter(call => call === 'hide').length, 1);
}

{
  const t = build({ strategy: 'activate' });
  t.showEvent();
  t.click('notification with an explicit activation strategy');
  t.tick(10000);
  check('an explicit activate preference is not overridden with a remap',
        t.calls.includes('hide'), false);
}

{
  const calls = [];
  const window = { focus: () => calls.push('native-focus') };
  const preload = fs.readFileSync(path.join(__dirname, '../src/preload.js'), 'utf8');
  vm.runInNewContext(preload, {
    window,
    location: { href: 'https://web.whatsapp.com/' },
    __dirname: path.join(__dirname, '../src'),
    process: { argv: [] },
    require(name) {
      if (name === 'url' || name === 'path') return require(name);
      if (name === 'electron') return {
        ipcRenderer: { send: channel => calls.push(channel), sendSync: () => null, on() {} },
      };
      if (name === './page/inject.js') return { start() {} };
      if (name === './page/font-faces.js') return require('../src/page/font-faces.js');
      throw new Error('Unexpected preload dependency: ' + name);
    },
  }, { filename: 'preload.js' });
  window.focus();
  check('page focus goes through the activation controller exactly once',
        calls, ['wa:focus-request']);
}

/* What a close writes back. A tiling window manager picks the size, and a
   config kept in git sees that write as a change on every close -- so with
   remember-size off the size must not be touched, and the zoom still must. */
{
  const close = remember => {
    const values = { 'window.remember-size': remember, 'window.width': 1200, 'window.height': 800 };
    let saves = 0;
    const context = vm.createContext({
      config: { get: key => values[key], set: (key, value) => { values[key] = value; }, save: () => saves++ },
      win: {
        isDestroyed: () => false,
        getBounds: () => ({ x: 0, y: 0, width: 958, height: 1047 }),
        webContents: { getZoomFactor: () => 1.1 },
      },
      electronScreen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
    });
    vm.runInContext(controller + '\nglobalThis.keep = keepWindowState;', context,
                    { filename: 'main.js (window controller)' });
    context.keep();
    return { size: [values['window.width'], values['window.height']], zoom: values['view.zoom'], saves };
  };
  check('a close writes the size the window manager gave it, by default',
        close(true), { size: [958, 1047], zoom: 1.1, saves: 1 });
  check('with remember-size off, the size in the file is left as it was',
        close(false), { size: [1200, 800], zoom: 1.1, saves: 1 });
}

console.log(failures ? `\n${failures} window check(s) failed` : '\nwindow checks pass');
process.exitCode = failures ? 1 : 0;
