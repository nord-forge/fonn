// Screen-reader announcements through the page's polite live region.
const live = document.getElementById('live');

export function announce(message) {
  if (!live) return;
  // Clearing first makes repeated identical messages announce again. A timer,
  // not an animation frame, so a busy frame loop cannot delay the message.
  live.textContent = '';
  setTimeout(() => {
    live.textContent = message;
  }, 50);
}
