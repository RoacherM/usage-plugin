const url = (path, query = {}) => {
  const target = new URL('api/usage' + path, document.baseURI);
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') target.searchParams.set(key, value);
  return target;
};

async function call(method, path, { body, query, signal } = {}) {
  const init = { method, credentials: 'same-origin', signal, headers: {} };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  const response = await fetch(url(path, query), init);
  let data;
  try { data = await response.json(); } catch { data = undefined; }
  if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`);
  return data;
}

export const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export const api = {
  summary: ({ range, model }, signal) => call('GET', '/summary', { query: { range, model, tz: browserZone() }, signal }),
  wait: (revision, signal) => call('GET', '/wait', { query: { revision }, signal }),
  reimport: () => call('POST', '/import', { body: {} }),
};
