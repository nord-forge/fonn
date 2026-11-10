// Theme preference shared by the header theme switcher and the dock. Uses the
// same storage key and values as Starlight (an empty string means "auto"), so
// a saved preference keeps working, and Starlight's inline theme script still
// applies it before the first paint.

const STORAGE_KEY = 'starlight-theme';
const CHANGE_EVENT = 'fonn:theme-change';
export const THEMES = ['dark', 'light', 'auto'];

function parse(value) {
  return THEMES.includes(value) ? value : 'auto';
}

export function currentTheme() {
  try {
    return parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    return 'auto';
  }
}

function resolved(theme) {
  if (theme !== 'auto') return theme;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function setTheme(theme) {
  const value = parse(theme);
  try {
    localStorage.setItem(STORAGE_KEY, value === 'auto' ? '' : value);
  } catch {
    // Storage can be unavailable; the choice still applies to this page.
  }
  document.documentElement.dataset.theme = resolved(value);
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: value }));
}

// Lets every switcher on the page show the same choice.
export function onThemeChange(callback) {
  window.addEventListener(CHANGE_EVENT, (event) => callback(event.detail));
}

// In auto mode, follow the system setting when it changes.
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (currentTheme() === 'auto') setTheme('auto');
});
