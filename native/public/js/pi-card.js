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

// Alt+H is this shell's own reach and stays. Alt+L is the same gesture under the name the product
// uses everywhere else, so somebody who learned it on one surface is not wrong on the other.
// Alt+K went with the custom keyboard on 2026-09-14.
export function bindHarnessKeys({ onHarness, onFullscreen } = {}) {
  addEventListener("keydown", event => {
    if (event.repeat || event.ctrlKey || event.metaKey || !event.altKey) return;
    const code = event.code;
    if (!["KeyH", "KeyL", "KeyF"].includes(code)) return;
    event.preventDefault();
    event.stopPropagation();
    if (code === "KeyH" || code === "KeyL") onHarness?.();
    if (code === "KeyF") onFullscreen?.();
  }, true);
}

layoutPiCard();
addEventListener("resize", layoutPiCard);
addEventListener("imperfect:gridchange", layoutPiCard);
