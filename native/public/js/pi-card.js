const NOTE_COLUMNS = 14;
const NOTE_ROWS = 2;

function wholeEven(length, unit, minimum) {
  const whole = Math.max(minimum, Math.floor(length / unit));
  return whole % 2 === 0 ? whole : whole - 1;
}

export function grid() {
  const unit =
    Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--ic-grid-major")
    ) || 24;
  const columns = Math.max(NOTE_COLUMNS, wholeEven(innerWidth, unit, 2));
  const rows = Math.max(NOTE_ROWS, wholeEven(innerHeight, unit, 2));
  const mobile = innerWidth < 1000;
  const originX = mobile ? (innerWidth - columns * unit) / 2 : 0;
  const originY = mobile ? (innerHeight - rows * unit) / 2 : 0;
  document.documentElement.style.setProperty("--ic-grid-major", `${unit}px`);
  return { unit, originX, originY, columns, rows };
}

export function layoutPiCard() {
  grid();
  const note = document.querySelector("#pi-card");
  if (!note || note.hidden) return;
  const { unit, originX, originY, columns } = grid();
  const width = Math.min(NOTE_COLUMNS, columns);
  const left = originX + Math.floor((columns - width) / 2) * unit;
  const top = originY + unit;
  note.style.left = `${left}px`;
  note.style.top = `${top}px`;
  note.style.width = `${width * unit}px`;
  note.style.minHeight = `${NOTE_ROWS * unit}px`;
}

// Alt and Option are the same physical key, but a visitor reads the label printed
// on the hardware in front of them. The bindings themselves are keyed by event.code
// and are unaffected; only what we call the key changes.
export function isApplePlatform() {
  const ua = navigator.userAgent || "";
  const platform = navigator.userAgentData?.platform || navigator.platform || "";
  if (/windows|win32|linux|android|cros/i.test(platform)) return false;
  if (/mac|iphone|ipad|ipod/i.test(platform)) return true;
  return /macintosh|mac os x|iphone|ipad|ipod/i.test(ua) && !/windows|android/i.test(ua);
}

export const ALT_LABEL = isApplePlatform() ? "OPT" : "ALT";

const KEY_BINDINGS = [];
const HELD_KEYS = new WeakMap();

function heldKeys(target) {
  let keys = HELD_KEYS.get(target);
  if (!keys) { keys = new Set(); HELD_KEYS.set(target, keys); }
  return keys;
}

function matches(binding, event) {
  return event.code === binding.code && event.altKey === binding.alt && event.ctrlKey === binding.ctrl &&
    event.metaKey === binding.meta && event.shiftKey === binding.shift;
}

// A binding is both the handler and the description used by the guide. Keeping
// those together prevents the guide from teaching a key that the surface does
// not actually answer.
export function registerKeyBinding({ label, description, code, alt = false, ctrl = false, meta = false, shift = false, when, handler, target = window }) {
  const binding = { label, description, code, alt, ctrl, meta, shift, when: when ?? (() => true), handler };
  KEY_BINDINGS.push(binding);
  const keys = heldKeys(target);
  target.addEventListener("keydown", event => {
		if (!matches(binding, event) || !binding.when(event) || keys.has(event.code)) return;
		keys.add(event.code);
    event.preventDefault();
    event.stopPropagation();
    binding.handler?.(event);
  }, true);
  target.addEventListener("keyup", event => keys.delete(event.code), true);
  target.addEventListener("blur", () => keys.clear(), true);
  return binding;
}

export function activeKeyBindings() {
  return KEY_BINDINGS.filter(binding => {
    try { return binding.when(); } catch { return false; }
  }).map(({ label, description }) => ({ label, description }));
}

// Alt+Y drops the harness. Alt+T drops it showing the tabs, which is the same
// panel with a different face. The shell owns Alt+L now, so this registry does
// not leave two surfaces competing for it.
export function bindHarnessKeys({ onHarness, onFullscreen, onTabs } = {}) {
  if (onHarness) {
    registerKeyBinding({ label: "Alt+Y", description: "open the agent", code: "KeyY", alt: true, handler: onHarness });
  }
  if (onFullscreen) registerKeyBinding({ label: "Alt+F", description: "toggle full width", code: "KeyF", alt: true, handler: onFullscreen });
  if (onTabs) registerKeyBinding({ label: "Alt+T", description: "open sessions", code: "KeyT", alt: true, handler: onTabs });
}

layoutPiCard();
addEventListener("resize", layoutPiCard);
addEventListener("imperfect:gridchange", layoutPiCard);
