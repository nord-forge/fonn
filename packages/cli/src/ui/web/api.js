export const SESSION_EXPIRED = 'Session expired: restart fonn ui';

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request(path, options) {
  let response;
  try {
    response = await fetch(`/api/${path}`, { credentials: 'same-origin', ...options });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError('Could not reach Fonn. Check that fonn ui is still running.');
  }
  if (response.status === 401) {
    window.dispatchEvent(new Event('fonn:session-expired'));
    throw new ApiError(SESSION_EXPIRED, 401);
  }
  let body;
  try {
    body = await response.json();
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError(`Fonn returned an unreadable response (${response.status}).`, response.status);
  }
  options.signal?.throwIfAborted();
  if (!response.ok) {
    throw new ApiError(typeof body?.error === 'string' ? body.error : `Request failed (${response.status}).`, response.status);
  }
  return body;
}

export function get(path, { query = {}, signal } = {}) {
  const params = new URLSearchParams(query);
  return request(`${path}${params.size ? `?${params}` : ''}`, { signal, cache: 'no-store' });
}

export function send(method, path, body = {}) {
  return request(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Fonn-Request': '1' },
    body: JSON.stringify(body),
  });
}

export const projectRoute = (root) => `#/project/${encodeURIComponent(root)}`;
export const launchRoute = (id) => `#/launch/${encodeURIComponent(id)}`;
