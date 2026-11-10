// Animation steps are scheduled here so a new run can cancel the old one.
const pending = new Set();

export function later(callback, delay) {
  const timer = setTimeout(() => {
    pending.delete(timer);
    callback();
  }, delay);
  pending.add(timer);
}

export function cancelAll() {
  for (const timer of pending) clearTimeout(timer);
  pending.clear();
}
