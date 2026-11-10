// Small text helpers shared by the visualiser modules.

export function formatNumber(value) {
  return value.toLocaleString('en-US');
}

// Makes invisible control characters visible in the output panes.
export function showControlCharacters(text) {
  return text.replace(/\u001b/g, '␛').replace(/\r(?!\n)/g, '␍');
}

export function debounce(callback, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => callback(...args), delay);
  };
}
