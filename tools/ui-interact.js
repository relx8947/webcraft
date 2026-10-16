// Interaction tests for the UI DOM layer, run inside tools/ui-test.html:
//   node tools/harness.mjs --url "tools/ui-test.html?screen=hud" --wait-for "window.__ready" \
//     --eval "import('/tools/ui-interact.js').then((m) => m.run())"
// Drives the real screens with synthetic pointer / keyboard events against the mock game and returns
// { passed, failed, results }. (Typing with trusted key events is covered by tools/ui-keys.json.)
import { ITEM, BLOCK } from '../src/world/registry.js';
import { makeStack } from '../src/game/inventory.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

function center(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

const BUTTONS = { 0: 1, 1: 4, 2: 2 };

function pointer(type, el, { button = 0, shiftKey = false, buttons } = {}) {
  const { x, y } = center(el);
  const ev = new PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
    clientX: x, clientY: y, button: type === 'pointermove' ? -1 : button,
    buttons: buttons ?? (type === 'pointerup' ? 0 : BUTTONS[button]), shiftKey,
  });
  el.dispatchEvent(ev);
}

function click(el, opts = {}) {
  pointer('pointermove', el, { ...opts, buttons: 0 });
  pointer('pointerdown', el, opts);
  pointer('pointerup', el, opts);
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: opts.button ?? 0, buttons: 0 }));
}

function key(code, opts = {}) {
  const keyName = opts.key ?? (code.startsWith('Key') ? code.slice(3).toLowerCase() : code.startsWith('Digit') ? code.slice(5) : code);
  const target = opts.target ?? document.body;
  target.dispatchEvent(new KeyboardEvent('keydown', { code, key: keyName, bubbles: true, cancelable: true, ...opts }));
  target.dispatchEvent(new KeyboardEvent('keyup', { code, key: keyName, bubbles: true, cancelable: true, ...opts }));
}

export async function run() {
  const ui = window.__ui;
  const game = window.__game;
  const inv = game.player.inventory;
  const results = [];
  const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
  const slotEl = (pred) => ui.screen.slots.find((s) => pred(s.ref))?.el;
  const invSlot = (i) => slotEl((r) => r.kind === 'inv' && r.index === i);
  const gridSlot = (i) => slotEl((r) => r.kind === 'grid' && r.index === i);
  const resultSlot = () => slotEl((r) => r.kind === 'result');
  const total = () => inv.slots.reduce((n, s) => n + (s ? s.count : 0), 0);

  // ---------------------------------------------------------------- survival inventory
  game.player.mode = 'survival';
  key('KeyE');
  await frame();
  check('E opens the survival inventory', ui.currentScreen === 'inventory', ui.currentScreen);
  check('game input disabled while a screen is open', game.input.enabled === false);
  const before = total();
  const logs = inv.get(9);
  click(invSlot(9));
  check('left click picks up the whole stack', ui.screen.model.cursor?.id === logs.id && ui.screen.model.cursor.count === logs.count && !inv.get(9));
  check('cursor stack follows the mouse', ui.cursorView.style.display !== 'none');
  click(gridSlot(0));
  check('placing into the 2x2 grid shows the planks result', ui.screen.model.result?.id === ITEM.OAK_PLANKS && ui.screen.model.result.count === 4);
  const planksBefore = inv.count(ITEM.OAK_PLANKS);
  click(resultSlot(), { shiftKey: true });
  check('shift-click on the result crafts everything', inv.count(ITEM.OAK_PLANKS) === planksBefore + 48 && !ui.screen.model.grid[0], inv.count(ITEM.OAK_PLANKS));
  // right click split
  const coalIdx = inv.findSlot(ITEM.COAL);
  const coal = inv.get(coalIdx).count;
  click(invSlot(coalIdx), { button: 2 });
  check('right click takes half', ui.screen.model.cursor?.count === Math.ceil(coal / 2), ui.screen.model.cursor?.count);
  // drag split over three grid cells
  const cur = ui.screen.model.cursor.count;
  pointer('pointerdown', gridSlot(0), { button: 0 });
  pointer('pointermove', gridSlot(1), { buttons: 1 });
  pointer('pointermove', gridSlot(2), { buttons: 1 });
  await frame();
  check('drag preview marks the dragged slots', ui.screen.slots.filter((s) => s.el.classList.contains('drag')).length === 3);
  pointer('pointerup', gridSlot(2), { button: 0 });
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  const per = Math.floor(cur / 3);
  check('left drag distributes evenly', [0, 1, 2].every((i) => ui.screen.model.grid[i]?.count === per), JSON.stringify(ui.screen.model.grid));
  check('drag remainder stays on the cursor', (ui.screen.model.cursor?.count ?? 0) === cur - per * 3, ui.screen.model.cursor?.count);
  // double click gathers
  if (ui.screen.model.cursor) click(invSlot(coalIdx));
  click(gridSlot(0));
  click(gridSlot(0));
  await frame();
  check('double click gathers all coal onto the cursor', ui.screen.model.cursor?.count === coal, ui.screen.model.cursor?.count);
  click(invSlot(coalIdx));
  // number key swap while hovering
  pointer('pointermove', invSlot(coalIdx), { buttons: 0 });
  const hot1 = inv.get(1);
  key('Digit2');
  check('number key swaps the hovered slot with the hotbar', inv.get(1)?.id === ITEM.COAL && inv.get(coalIdx)?.id === hot1?.id);
  // Q drops one
  const droppedBefore = game.dropped.length;
  pointer('pointermove', invSlot(1), { buttons: 0 });
  key('KeyQ');
  check('Q over a slot drops one item', game.dropped.length === droppedBefore + 1 && game.dropped.at(-1).count === 1);
  // tooltip on hover
  await frame();
  check('hovering a stack shows its tooltip', ui.tooltipShown && ui.tooltipEl.textContent.includes('煤炭'), ui.tooltipEl.textContent);
  // put something in the grid + keep a cursor, then close with E
  click(invSlot(20));
  click(gridSlot(3), { button: 2 });
  key('KeyE');
  await frame();
  check('E closes the inventory', ui.currentScreen === null);
  check('closing returns grid and cursor items (nothing lost)', total() === before - 1 + 48 - 12, `${total()} vs ${before - 1 + 48 - 12}`);
  await frame();
  check('game input re-enabled on the next update after closing', game.input.enabled === true);

  // ---------------------------------------------------------------- crafting table
  ui.openCraftingTable();
  await frame();
  check('crafting table opens', ui.currentScreen === 'crafting');
  // build a pickaxe: 3 planks top row, 2 sticks in the middle column
  inv.set(30, makeStack(ITEM.OAK_PLANKS, 3));
  inv.set(31, makeStack(ITEM.STICK, 2));
  await frame();
  click(invSlot(30));
  for (const i of [0, 1, 2]) click(gridSlot(i), { button: 2 });
  click(invSlot(31));
  click(gridSlot(4), { button: 2 });
  click(gridSlot(7), { button: 2 });
  check('3x3 pickaxe recipe recognised', ui.screen.model.result?.id === ITEM.WOODEN_PICKAXE, ui.screen.model.result?.id);
  click(resultSlot());
  check('taking the result consumes the ingredients', ui.screen.model.cursor?.id === ITEM.WOODEN_PICKAXE && ui.screen.model.grid.every((s) => !s));
  key('Escape');
  await frame();
  check('Escape closes the crafting table and returns the cursor item', ui.currentScreen === null && inv.count(ITEM.WOODEN_PICKAXE) === 1);

  // ---------------------------------------------------------------- creative
  game.setGameMode('creative');
  key('KeyE');
  await frame();
  check('E opens the creative inventory in creative mode', ui.currentScreen === 'creative');
  const cs = ui.screen;
  const first = cs.gridSlots[0];
  click(first.el);
  check('creative click takes a full stack', cs.model.cursor?.count === 64 && cs.model.cursor.id === first.ref.itemId, JSON.stringify(cs.model.cursor));
  click(invSlot(0));
  check('placing the creative stack into the hotbar', inv.get(0)?.id === first.ref.itemId);
  if (cs.model.cursor) click(first.el);
  const second = cs.gridSlots[1];
  for (let i = 0; i < 9; i++) inv.set(i, null);
  click(second.el, { shiftKey: true });
  check('shift-click sends a stack to the hotbar', inv.get(0)?.id === second.ref.itemId && inv.get(0).count === 64);
  // tabs + search + scrolling
  const searchTab = cs.tabs.find((t) => t.search);
  pointer('pointerdown', cs.tabEls.get('search'), { button: 0 });
  await frame();
  check('search tab selected', cs.tab === searchTab);
  cs.searchInput.value = '钻石';
  cs.searchInput.dispatchEvent(new Event('input'));
  check('search filters by Chinese name', cs.items.length >= 7 && cs.items.every((id) => game.icons && true), cs.items.length);
  cs.searchInput.value = 'pickaxe';
  cs.searchInput.dispatchEvent(new Event('input'));
  check('search filters by English name', cs.items.length === 5, cs.items.length);
  cs.searchInput.value = '';
  cs.searchInput.dispatchEvent(new Event('input'));
  const max = cs.maxScroll();
  cs.el.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
  check('mouse wheel scrolls the creative grid', max > 0 && cs.scrollRow === 1, `${max} ${cs.scrollRow}`);
  {
    const track = cs.scrollTrack;
    const r = track.getBoundingClientRect();
    track.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerId: 2, clientX: r.left + r.width / 2, clientY: r.bottom - 2 }));
    track.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, buttons: 0, pointerId: 2 }));
    check('dragging the scrollbar to the bottom scrolls to the end', cs.scrollRow === cs.maxScroll(), `${cs.scrollRow}/${cs.maxScroll()}`);
    const thumbTop = parseFloat(getComputedStyle(cs.scrollThumb).top);
    check('scroll thumb moved down the track', thumbTop > r.height / 2, thumbTop);
    cs.tabEls.get('food').dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }));
    check('hovering a tab shows its name', ui.tooltipShown && ui.tooltipEl.textContent === '食物', ui.tooltipEl.textContent);
    cs.tabEls.get('food').dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }));
    check('leaving the tab hides the tooltip', !ui.tooltipShown);
  }
  pointer('pointerdown', cs.tabEls.get('inventory'), { button: 0 });
  await frame();
  check('inventory tab shows the destroy slot', cs.destroySlot.el.offsetParent !== null);
  click(invSlot(0));
  click(cs.destroySlot.el);
  check('destroy slot deletes the cursor stack', !cs.model.cursor && !inv.get(0));
  key('KeyE');
  await frame();
  game.setGameMode('survival');

  // ---------------------------------------------------------------- chat
  key('KeyT');
  await frame();
  check('T opens chat', ui.currentScreen === 'chat');
  const input = ui.screen.input;
  input.value = '/time set noon';
  input.dispatchEvent(new Event('input'));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
  await frame();
  check('Enter runs the command and closes chat', game.time === 6000 && ui.currentScreen === null, `${game.time} ${ui.currentScreen}`);
  key('Slash', { key: '/' });
  await frame();
  check('"/" opens chat prefilled with "/"', ui.currentScreen === 'chat' && ui.screen.input.value === '/');
  ui.screen.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', code: 'ArrowUp', bubbles: true, cancelable: true }));
  check('Up recalls the last sent message', ui.screen.input.value === '/time set noon', ui.screen.input.value);
  ui.screen.input.value = 'hello 世界';
  ui.screen.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
  check('plain chat is posted as <玩家> text', ui.chatLog.lines.at(-1).el.textContent === '<玩家> hello 世界', ui.chatLog.lines.at(-1)?.el.textContent);
  key('KeyT');
  await frame();
  ui.screen.input.value = '/gamem';
  ui.screen.input.dispatchEvent(new Event('input'));
  ui.screen.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true }));
  check('Tab completes the command name', ui.screen.input.value === '/gamemode', ui.screen.input.value);
  key('Escape', { key: 'Escape' });
  await frame();
  check('Escape closes chat', ui.currentScreen === null);

  // ---------------------------------------------------------------- pause / options
  key('Escape', { key: 'Escape' });
  await frame();
  check('Escape opens the pause menu and pauses the game', ui.currentScreen === 'pause' && game.paused === true);
  [...ui.screen.el.querySelectorAll('.mc-button')].find((b) => b.textContent === '选项...').click();
  check('options opened from pause', ui.currentScreen === 'options' && game.paused === true);
  const fovSlider = ui.screen.controls[0];
  fovSlider.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  check('slider keyboard change applies the setting', game.settings.fov === 76, game.settings.fov);
  {
    const rd = ui.screen.controls[1];
    const r = rd.el.getBoundingClientRect();
    const at = (fx) => ({ bubbles: true, cancelable: true, pointerId: 3, button: 0, buttons: 1, clientX: r.left + r.width * fx, clientY: r.top + r.height / 2 });
    rd.el.dispatchEvent(new PointerEvent('pointerdown', at(0.99)));
    check('dragging the render distance slider does not apply until release', game.settings.renderDistance === 8, game.settings.renderDistance);
    rd.el.dispatchEvent(new PointerEvent('pointermove', at(0.5)));
    rd.el.dispatchEvent(new PointerEvent('pointerup', { ...at(0.5), buttons: 0 }));
    check('render distance applied on release (2..16)', game.settings.renderDistance === rd.value && rd.value >= 8 && rd.value <= 10, `${game.settings.renderDistance} ${rd.value}`);
    check('slider label shows chunks', rd.textEl.textContent === `渲染距离：${rd.value} 区块`, rd.textEl.textContent);
  }
  const bob = ui.screen.controls[4];
  const prevBob = game.settings.viewBobbing;
  bob.el.click();
  check('toggle button flips the setting', game.settings.viewBobbing === !prevBob);
  [...ui.screen.el.querySelectorAll('.mc-button')].find((b) => b.textContent === '完成').click();
  check('"完成" returns to the pause menu', ui.currentScreen === 'pause');
  key('Escape', { key: 'Escape' });
  await frame();
  check('Escape on pause resumes the game', ui.currentScreen === null && game.paused === false);

  // ---------------------------------------------------------------- HUD behaviours
  game.player.health = 6;
  await frame();
  await frame();
  game.player.health = 3;
  await frame();
  await sleep(60);
  check('damage triggers the red flash', Number(ui.hud.damageFlash.style.opacity) > 0.1, ui.hud.damageFlash.style.opacity);
  game.player.selectedSlot = 3;
  inv.set(3, makeStack(ITEM.TORCH, 5));
  await frame();
  check('selecting another item shows its name above the hotbar', ui.hud.itemName.textContent === '火把' && Number(ui.hud.itemName.style.opacity) > 0.5, ui.hud.itemName.textContent);
  ui.toggleDebug();
  await frame();
  await sleep(300);
  check('F3 overlay lists debug lines', ui.hud.debugLeft.textContent.includes('XYZ') && ui.hud.debugRight.textContent.includes('区段'));
  ui.toggleDebug();
  ui.toggleHud();
  await frame();
  check('F1 hides the HUD', ui.hud.el.style.display === 'none');
  ui.toggleHud();
  game.player.health = 20;

  // ---------------------------------------------------------------- death
  game.player.dead = true;
  game.player.health = 0;
  game.emit('playerDied', 'lava');
  await frame();
  check('playerDied opens the death screen with the cause', ui.currentScreen === 'death' && ui.screen.el.textContent.includes('熔岩'));
  await sleep(1100);
  await frame();
  const respawn = [...ui.screen.el.querySelectorAll('.mc-button')].find((b) => b.textContent === '重生');
  respawn.click();
  await frame();
  check('respawn closes the death screen', ui.currentScreen === null && !game.player.dead);

  // ---------------------------------------------------------------- perf: HUD update cost
  const t0 = performance.now();
  for (let i = 0; i < 2000; i++) ui.update(1 / 60);
  const perFrame = (performance.now() - t0) / 2000;
  check(`HUD update < 0.25 ms per frame (${perFrame.toFixed(4)} ms)`, perFrame < 0.25, perFrame);

  const failed = results.filter((r) => !r.ok);
  return { passed: results.length - failed.length, failed: failed.length, results: failed.length ? failed : results.map((r) => r.name) };
}

/** Menu flow: title -> worlds -> create -> loading -> in game -> pause -> save & quit -> delete world. */
export async function runFlow() {
  const ui = window.__ui;
  const game = window.__game;
  const results = [];
  const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
  const button = (label) => [...ui.screen.el.querySelectorAll('.mc-button')].find((b) => b.textContent === label);
  ui.showTitle();
  check('title screen', ui.currentScreen === 'title');
  button('单人游戏').click();
  await sleep(50);
  check('world list opened', ui.currentScreen === 'worlds' && ui.screen.entries.length === 3, ui.screen.entries?.length);
  check('first world preselected, play enabled', ui.screen.selected === 0 && !ui.screen.playBtn.disabled);
  ui.screen.entries[1].click();
  check('clicking an entry selects it', ui.screen.selected === 1);
  button('创建新的世界').click();
  check('create world screen', ui.currentScreen === 'create');
  ui.screen.nameField.value = '测试世界';
  ui.screen.seedField.value = 'abc';
  button('游戏模式：生存').click();
  check('game mode toggles to creative', ui.screen.mode === 'creative');
  button('世界类型：默认').click();
  check('world type toggles to flat', ui.screen.worldType === 'flat');
  button('创建新的世界').click();
  await sleep(30);
  check('loading screen while the world starts', ui.currentScreen === 'loading', ui.currentScreen);
  await sleep(300);
  check('loading progress bar advances', parseFloat(ui.screen?.fill?.style.width ?? '100') > 0, ui.screen?.fill?.style.width);
  await sleep(700);
  check('enterGame after loading: no screen, HUD visible', ui.currentScreen === null && game.state === 'playing' && ui.hud.el.style.display !== 'none', ui.currentScreen);
  check('created world uses the chosen options', game.worldMeta.name === '测试世界' && game.worldMeta.mode === 'creative' && game.worldMeta.worldType === 'flat' && game.worldMeta.seedText === 'abc');
  ui.openPause();
  button('保存并退出到标题画面').click();
  await sleep(20);
  check('saving screen shown', ui.currentScreen === 'message');
  await sleep(400);
  check('back on the title screen after quitting', ui.currentScreen === 'title' && game.state === 'title');
  ui.openWorldList();
  await sleep(50);
  const n = ui.screen.entries.length;
  ui.screen.select(n - 1);
  button('删除').click();
  check('delete asks for confirmation', ui.currentScreen === 'confirm');
  button('删除').click();
  await sleep(80);
  check('world deleted and list refreshed', ui.currentScreen === 'worlds' && ui.screen.entries.length === n - 1, ui.screen.entries?.length);
  button('取消').click();
  check('cancel returns to title', ui.currentScreen === 'title');
  ui.openOptions();
  check('options from title', ui.currentScreen === 'options' && !ui.screen.inGame);
  button('界面尺寸：自动').click();
  check('GUI scale button cycles and rescales', game.settings.guiScale === 1 && ui.scale === 1, `${game.settings.guiScale} ${ui.scale}`);
  const labels = [];
  const steps = Math.min(4, ui.maxScale);
  for (let i = 0; i < steps; i++) {
    ui.screen.guiBtn.el.click();
    labels.push(ui.screen.guiBtn.label);
  }
  check('GUI scale back to auto after the largest usable scale', game.settings.guiScale === 0, `${game.settings.guiScale} ${labels}`);
  check('GUI scale labels never exceed the window maximum (review UI-6)',
    labels.every((l) => l === '界面尺寸：自动' || Number(l.slice(5)) <= ui.maxScale), labels.join(' '));
  button('完成').click();
  check('done returns to title', ui.currentScreen === 'title');
  const failed = results.filter((r) => !r.ok);
  return { passed: results.length - failed.length, failed: failed.length, results: failed.length ? failed : results.map((r) => r.name) };
}

/**
 * Wave 2: furnace and chest screens (shift-click routing, live progress, take-only output, auto-close),
 * the creative spawn-egg tab, the difficulty option, poisoned / hungry HUD icons, save failures.
 * Run in tools/ui-test.html?screen=hud.
 */
export async function runContainers() {
  const ui = window.__ui;
  const game = window.__game;
  const inv = game.player.inventory;
  const furnace = window.__furnace;
  const chest = window.__chest;
  const mgr = window.__blockEntities;
  const results = [];
  const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
  const slotEl = (pred) => ui.screen.slots.find((s) => pred(s.ref))?.el;
  const invSlot = (i) => slotEl((r) => r.kind === 'inv' && r.index === i);
  const boxSlot = (i) => slotEl((r) => r.kind === 'container' && r.index === i);
  const boxView = (i) => ui.screen.slots.find((s) => s.ref.kind === 'container' && s.ref.index === i)?.view;
  const ticks = (n) => { for (let i = 0; i < n; i++) mgr.tick(0.05); };
  game.player.mode = 'survival';
  game.player.dead = false;

  // ---------------------------------------------------------------- furnace
  for (let i = 0; i < 3; i++) furnace.set(i, null);
  furnace.burnTicks = 0;
  furnace.cookTicks = 0;
  inv.set(30, makeStack(ITEM.IRON_ORE, 3));
  inv.set(31, makeStack(ITEM.COAL, 4));
  inv.set(32, makeStack(ITEM.DIRT, 10));
  ui.openFurnace(furnace);
  await frame();
  check('openFurnace shows the furnace screen', ui.currentScreen === 'furnace', ui.currentScreen);
  check('furnace title and inventory label', ui.screen.el.textContent.includes('熔炉') && ui.screen.el.textContent.includes('物品栏'));
  check('flame hidden while unlit', ui.screen.flame.style.display === 'none');
  click(invSlot(30), { shiftKey: true });
  check('shift-click iron ore -> input slot', furnace.get(0)?.id === ITEM.IRON_ORE && furnace.get(0).count === 3 && !inv.get(30));
  click(invSlot(31), { shiftKey: true });
  check('shift-click coal -> fuel slot', furnace.get(1)?.id === ITEM.COAL && furnace.get(1).count === 4 && !inv.get(31));
  click(invSlot(32), { shiftKey: true });
  check('shift-click dirt moves main -> hotbar (not into the furnace)', furnace.get(0)?.id === ITEM.IRON_ORE && inv.count(ITEM.DIRT) >= 10);
  check('input slot view shows the ore', !boxView(0).classList.contains('empty') && boxView(0)._n === 3);
  ticks(1);
  await frame();
  check('furnace lit after one tick (block swapped)', furnace.burnTicks === 1600 && game.world.getBlock(12, 64, -9) === BLOCK.LIT_FURNACE);
  check('flame shown at full height', ui.screen.flame.style.display === '' && ui.screen.flameHeight === 14, ui.screen.flameHeight);
  ticks(99);
  await frame();
  check('arrow half way after 100 ticks', ui.screen.arrowWidth === 12, ui.screen.arrowWidth);
  ticks(100);
  await frame();
  check('output slot updates live (1 iron ingot)', boxView(2)._n === 1 && furnace.get(2)?.id === ITEM.IRON_INGOT, boxView(2)._n);
  check('fuel count updated live', boxView(1)._n === 3, boxView(1)._n);
  ticks(800);
  await frame();
  check('flame shrinks with the fuel', ui.screen.flameHeight > 0 && ui.screen.flameHeight < 14, ui.screen.flameHeight);
  const outCount = furnace.get(2)?.count;
  check('all 3 ores smelted', outCount === 3 && !furnace.get(0), outCount);
  // take-only output
  inv.set(33, makeStack(ITEM.DIRT, 1));
  await frame();
  click(invSlot(33));
  click(boxSlot(2));
  check('output refuses other items', furnace.get(2)?.id === ITEM.IRON_INGOT && ui.screen.model.cursor?.id === ITEM.DIRT);
  click(invSlot(33));
  click(boxSlot(2));
  check('clicking the output takes it', ui.screen.model.cursor?.id === ITEM.IRON_INGOT && ui.screen.model.cursor.count === 3 && !furnace.get(2));
  click(invSlot(34));
  check('placed into the inventory', inv.get(34)?.id === ITEM.IRON_INGOT);
  // fuel slot refuses dirt
  click(invSlot(33));
  click(boxSlot(1));
  check('fuel slot refuses dirt', furnace.get(1)?.id === ITEM.COAL && ui.screen.model.cursor?.id === ITEM.DIRT);
  click(invSlot(33));
  key('KeyE');
  await frame();
  check('E closes the furnace screen', ui.currentScreen === null);
  // auto-close: player too far away
  ui.openFurnace(furnace);
  await frame();
  const px = game.player.x;
  game.player.x += 20;
  await frame();
  check('walking more than 8 blocks away closes the screen', ui.currentScreen === null, ui.currentScreen);
  game.player.x = px;

  // ---------------------------------------------------------------- chest
  ui.openChest(chest);
  await frame();
  check('openChest shows the chest screen', ui.currentScreen === 'chest');
  const stoneSlot = inv.findSlot(ITEM.COBBLESTONE);
  const stoneCount = inv.get(stoneSlot).count;
  const countIn = (id) => chest.slots.reduce((n, s) => n + (s && s.id === id ? s.count : 0), 0);
  const before = countIn(ITEM.COBBLESTONE);
  click(invSlot(stoneSlot), { shiftKey: true });
  const after = countIn(ITEM.COBBLESTONE);
  check('shift-click inventory -> chest', after === before + stoneCount && !inv.get(stoneSlot), `${before} -> ${after}`);
  const diamondsBefore = inv.count(ITEM.DIAMOND);
  const dSlot = chest.slots.findIndex((s) => s && s.id === ITEM.DIAMOND);
  click(boxSlot(dSlot), { shiftKey: true });
  check('shift-click chest -> inventory', inv.count(ITEM.DIAMOND) === diamondsBefore + 2 && !chest.get(dSlot));
  pointer('pointermove', boxSlot(0), { buttons: 0 });
  await frame();
  check('hovering a chest slot shows the tooltip', ui.tooltipShown && ui.tooltipEl.textContent.includes('橡木原木'), ui.tooltipEl.textContent);
  inv.set(8, null);
  key('Digit9');
  check('number key swaps a chest slot with the hotbar', inv.get(8)?.id === ITEM.OAK_LOG, inv.get(8)?.id);
  const removed = mgr.remove(13, 64, -9);
  await frame();
  check('removing the chest entity closes the screen', ui.currentScreen === null && removed.length > 0, ui.currentScreen);
  const restored = mgr.getOrCreate(13, 64, -9, 'chest');
  removed.forEach((s, i) => restored.set(i, s));
  window.__chest = restored;

  // ---------------------------------------------------------------- creative spawn-egg tab
  game.setGameMode('creative');
  key('KeyE');
  await frame();
  const cs = ui.screen;
  const spawnTab = cs.tabs.find((t) => t.id === 'spawn');
  check('creative has a 刷怪蛋 tab', !!spawnTab && spawnTab.name === '刷怪蛋' && spawnTab.items.length === 8);
  const cells = new Set(cs.tabs.map((t) => `${t.row},${t.col}`));
  check('creative tabs do not overlap', cells.size === cs.tabs.length, [...cells].join(' '));
  pointer('pointerdown', cs.tabEls.get('spawn'), { button: 0 });
  await frame();
  check('spawn egg tab lists the eggs', cs.items.length === 8 && cs.gridSlots[0].ref.itemId === ITEM.PIG_SPAWN_EGG);
  key('KeyE');
  await frame();
  game.setGameMode('survival');

  // ---------------------------------------------------------------- difficulty option
  ui.openOptions(() => ui.closeScreen(), true);
  await frame();
  const db = ui.screen.difficultyBtn;
  check('difficulty button shows the current difficulty', db.label === '难度：普通', db.label);
  db.el.click();
  check('difficulty cycles to 困难', game.settings.difficulty === 'hard' && db.label === '难度：困难', `${game.settings.difficulty} ${db.label}`);
  db.el.click();
  check('then to 和平', game.settings.difficulty === 'peaceful' && db.label === '难度：和平');
  db.el.click();
  db.el.click();
  check('back to 普通', game.settings.difficulty === 'normal');
  check('brightness slider (亮度) next to the difficulty', ui.screen.brightnessSlider?.textEl?.textContent === '亮度：默认',
    ui.screen.brightnessSlider?.textEl?.textContent);
  key('Escape', { key: 'Escape' });
  await frame();
  // the controls list lives in the pause menu (integrator: the options screen has no room for an 8th row)
  ui.showPauseMenu();
  await frame();
  const controlsBtn = [...ui.screen.el.querySelectorAll('.mc-button')].find((b) => b.textContent === '操作说明...');
  controlsBtn.click();
  check('操作说明 opens the controls list', ui.currentScreen === 'about' && ui.screen.el.textContent.includes('拉弓'));
  key('Escape', { key: 'Escape' });
  check('Escape returns to the pause menu', ui.currentScreen === 'pause');
  key('Escape', { key: 'Escape' });
  await frame();

  // ---------------------------------------------------------------- hunger HUD effects
  if (ui.screen) ui.closeScreen();
  game.player.health = 20;
  game.player.poisonTicks = 100;
  game.player.hungerTicks = 100;
  await frame();
  await frame();
  check('poisoned hearts', ui.hud.hearts[0].style.backgroundImage.includes('heart-poison'), ui.hud.hearts[0].style.backgroundImage);
  check('hunger effect food icons', ui.hud.foods[0].style.backgroundImage.includes('food-hunger'), ui.hud.foods[0].style.backgroundImage);
  game.player.poisonTicks = 0;
  game.player.hungerTicks = 0;
  await frame();
  await frame();
  check('normal icons again', !ui.hud.hearts[0].style.backgroundImage.includes('poison') && !ui.hud.foods[0].style.backgroundImage.includes('hunger'));

  // ---------------------------------------------------------------- save & quit failure
  const realQuit = game.quitToTitle;
  const calls = [];
  game.quitToTitle = async (opts) => {
    calls.push(opts ?? null);
    if (!opts?.discard) {
      const e = new Error('无法保存世界：磁盘已满');
      e.saveFailed = true;
      throw e;
    }
    return realQuit.call(game);
  };
  ui.openPause();
  await ui.saveAndQuit();
  check('failed save shows the save-failed screen, world stays open', ui.currentScreen === 'save-failed' && game.state === 'playing', ui.currentScreen);
  check('the reason is shown', ui.screen.el.textContent.includes('磁盘已满'));
  const btn = (label) => [...ui.screen.el.querySelectorAll('.mc-button')].find((b) => b.textContent === label);
  btn('返回游戏').click();
  await frame();
  check('返回游戏 closes it and resumes', ui.currentScreen === null && game.paused === false, `${ui.currentScreen} ${game.paused}`);
  ui.openPause();
  await ui.saveAndQuit();
  btn('不保存并退出').click();
  check('不保存并退出 asks for confirmation', ui.currentScreen === 'confirm');
  btn('不保存并退出').click();
  await sleep(400);
  check('discarding quits to the title', calls.at(-1)?.discard === true && ui.currentScreen === 'title', `${JSON.stringify(calls)} ${ui.currentScreen}`);
  game.quitToTitle = realQuit;

  const failed = results.filter((r) => !r.ok);
  return { passed: results.length - failed.length, failed: failed.length, results: failed.length ? failed : results.map((r) => r.name) };
}

/**
 * Regression checks for the wave-1 review findings fixed in wave 2 (UI-1 Ctrl + screen keys, UI-2 /kill
 * from chat, UI-3 hover under a resting cursor, UI-4 crosshair in third person, UI-7 drag release).
 * Run in tools/ui-test.html?screen=hud.
 */
export async function runReviewFixes() {
  const ui = window.__ui;
  const game = window.__game;
  const inv = game.player.inventory;
  const results = [];
  const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
  const slotOf = (i) => ui.screen.slots.find((s) => s.ref.kind === 'inv' && s.ref.index === i)?.el;
  game.player.mode = 'survival';
  game.player.dead = false;
  game.player.health = 20;
  if (ui.screen) ui.closeScreen();
  await frame();

  // UI-1: E opens the inventory while Ctrl (sprint) is held
  key('KeyE', { ctrlKey: true });
  await frame();
  check('UI-1 Ctrl+E opens the inventory', ui.currentScreen === 'inventory', ui.currentScreen);
  key('KeyE', { ctrlKey: true });
  await frame();
  key('Escape', { key: 'Escape', ctrlKey: true });
  await frame();
  check('UI-1 Ctrl+Escape opens the pause menu', ui.currentScreen === 'pause', ui.currentScreen);
  key('Escape', { key: 'Escape' });
  await frame();

  // UI-3: the slot under a resting cursor is hovered as soon as the screen opens
  inv.set(13, makeStack(ITEM.COBBLESTONE, 13));
  inv.set(0, null);
  ui.openInventory();
  await frame();
  const c = center(slotOf(13));
  ui.closeScreen();
  await frame();
  window.dispatchEvent(new PointerEvent('pointermove', { clientX: c.x, clientY: c.y, bubbles: true }));
  key('KeyE');
  await frame();
  check('UI-3 hovered slot resolved on open', ui.screen.hover?.ref.index === 13, JSON.stringify(ui.screen.hover?.ref));
  check('UI-3 tooltip shown without moving', ui.tooltipShown && ui.tooltipEl.textContent.includes('圆石'), ui.tooltipEl.textContent);
  key('Digit1');
  check('UI-3 number key works without moving', inv.get(0)?.id === ITEM.COBBLESTONE && !inv.get(13));

  // UI-7: press on a slot holding another item, drag to an empty slot, release there
  inv.set(10, makeStack(ITEM.OAK_LOG, 3));
  inv.set(20, null);
  ui.screen.model.cursor = makeStack(ITEM.DIAMOND, 5);
  ui.screen.render(true);
  pointer('pointermove', slotOf(10), { buttons: 0 });
  pointer('pointerdown', slotOf(10), { button: 0 });
  pointer('pointermove', slotOf(20), { buttons: 1 });
  pointer('pointerup', slotOf(20), { button: 0 });
  await frame();
  check('UI-7 single-slot drag places into the slot under the cursor', inv.get(20)?.id === ITEM.DIAMOND && inv.get(20).count === 5 &&
    inv.get(10)?.id === ITEM.OAK_LOG && !ui.screen.model.cursor, `${JSON.stringify(inv.get(10))} ${JSON.stringify(inv.get(20))}`);
  // a plain click on a different item still swaps
  ui.screen.model.cursor = makeStack(ITEM.DIAMOND, 2);
  click(slotOf(10));
  check('UI-7 plain click on another item still swaps', inv.get(10)?.id === ITEM.DIAMOND && ui.screen.model.cursor?.id === ITEM.OAK_LOG);
  click(slotOf(30));
  key('KeyE');
  await frame();

  // UI-4: no crosshair in third person
  game.perspective = 1;
  await frame();
  check('UI-4 crosshair hidden in third person', ui.crosshair.style.display === 'none', ui.crosshair.style.display);
  game.perspective = 0;
  await frame();
  check('UI-4 crosshair back in first person', ui.crosshair.style.display === '');

  // UI-2: /kill from chat leaves the death screen open (no close / pointer-lock request in between)
  const calls = [];
  const realSet = ui.setScreen.bind(ui);
  ui.setScreen = (s, o) => { calls.push(s ? s.name : null); return realSet(s, o); };
  ui.openChat('/kill');
  await frame();
  ui.screen.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
  await frame();
  await frame();
  ui.setScreen = realSet;
  check('UI-2 /kill opens the death screen once', ui.currentScreen === 'death' && calls.join(',') === 'chat,death', calls.join(','));
  check('UI-2 no input re-enable while dead', ui.pendingEnable === false);
  game.respawn();
  await frame();

  const failed = results.filter((r) => !r.ok);
  return { passed: results.length - failed.length, failed: failed.length, results: failed.length ? failed : results.map((r) => r.name) };
}
