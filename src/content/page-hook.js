(() => {
  if (window.__njfCompanionHook) return;
  Object.defineProperty(window, '__njfCompanionHook', { value: true });

  const EVENT = 'njf-companion:api-error';
  const MAX_BODY = 64 * 1024;

  const truncate = (text) => {
    const s = String(text ?? '');
    return s.length > MAX_BODY ? `${s.slice(0, MAX_BODY)}\n… [truncated, ${s.length} characters]` : s;
  };

  function describeBody(body) {
    if (body == null) return '';
    if (typeof body === 'string') return truncate(body);
    if (body instanceof URLSearchParams) return truncate(body.toString());
    if (body instanceof FormData) {
      const parts = [];
      for (const [k, v] of body.entries()) {
        parts.push(typeof v === 'string' ? `${k}=${v}` : `${k}=[file ${v.name || 'blob'} · ${v.size} bytes · ${v.type || 'unknown'}]`);
      }
      return truncate(`[multipart/form-data]\n${parts.join('\n')}`);
    }
    if (body instanceof Blob) return `[Blob · ${body.size} bytes · ${body.type || 'unknown'}]`;
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return `[binary · ${body.byteLength} bytes]`;
    return `[${Object.prototype.toString.call(body).slice(8, -1)}]`;
  }

  function parseHeaderBlock(block) {
    const out = {};
    for (const line of String(block || '').trim().split(/[\r\n]+/)) {
      const i = line.indexOf(':');
      if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    return out;
  }

  const headersToObject = (h) => {
    const out = {};
    try {
      new Headers(h || undefined).forEach((v, k) => (out[k] = v));
    } catch {
    }
    return out;
  };

  function report(entry) {
    try {
      window.dispatchEvent(new CustomEvent(EVENT, { detail: JSON.stringify({ ...entry, page: location.href }) }));
    } catch {
    }
  }

  const meta = new WeakMap();
  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSend = XHR.send;
  const origSetHeader = XHR.setRequestHeader;

  XHR.open = function (method, url, ...rest) {
    try {
      meta.set(this, { method: String(method || 'GET').toUpperCase(), url: new URL(String(url), location.href).href, headers: {} });
    } catch {
      meta.delete(this);
    }
    return origOpen.call(this, method, url, ...rest);
  };

  XHR.setRequestHeader = function (name, value) {
    const m = meta.get(this);
    if (m) m.headers[String(name)] = String(value);
    return origSetHeader.call(this, name, value);
  };

  async function xhrBody(xhr) {
    try {
      switch (xhr.responseType) {
        case '':
        case 'text':
          return truncate(xhr.responseText);
        case 'json':
          return truncate(JSON.stringify(xhr.response, null, 2));
        case 'blob':
          return xhr.response && xhr.response.size <= MAX_BODY ? await xhr.response.text() : `[Blob · ${xhr.response?.size ?? 0} bytes]`;
        case 'arraybuffer':
          return xhr.response && xhr.response.byteLength <= MAX_BODY
            ? new TextDecoder().decode(xhr.response)
            : `[binary · ${xhr.response?.byteLength ?? 0} bytes]`;
        default:
          return `[${xhr.responseType}]`;
      }
    } catch {
      return '';
    }
  }

  XHR.send = function (body) {
    const m = meta.get(this);
    if (m) {
      const start = performance.now();
      const ts = Date.now();
      let failure = null;
      this.addEventListener('abort', () => (failure = 'aborted'));
      this.addEventListener('timeout', () => (failure = 'Timeout'));
      this.addEventListener('error', () => (failure = failure || 'Network error'));
      this.addEventListener('loadend', async () => {
        const status = this.status;
        if (failure === 'aborted' || (status >= 200 && status < 300)) return;
        report({
          kind: 'xhr',
          method: m.method,
          url: m.url,
          status,
          statusText: status ? this.statusText : failure || 'Network error',
          ts,
          ms: Math.round(performance.now() - start),
          requestHeaders: m.headers,
          requestBody: describeBody(body),
          responseHeaders: parseHeaderBlock(this.getAllResponseHeaders()),
          responseBody: status ? await xhrBody(this) : '',
        });
      });
    }
    return origSend.call(this, body);
  };

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      const isRequest = typeof Request !== 'undefined' && input instanceof Request;
      let url;
      try {
        url = new URL(isRequest ? input.url : String(input), location.href).href;
      } catch {
        return origFetch.apply(this, arguments);
      }
      const method = String(init?.method || (isRequest ? input.method : 'GET')).toUpperCase();
      const requestHeaders = headersToObject(init?.headers || (isRequest ? input.headers : undefined));
      const requestBody = describeBody(init?.body);
      const start = performance.now();
      const ts = Date.now();
      const base = { kind: 'fetch', method, url, ts, requestHeaders, requestBody };

      return origFetch.apply(this, arguments).then(
        (res) => {
          if (!res.ok) {
            const ms = Math.round(performance.now() - start);
            res
              .clone()
              .text()
              .catch(() => '')
              .then((text) =>
                report({ ...base, status: res.status, statusText: res.statusText, ms, responseHeaders: headersToObject(res.headers), responseBody: truncate(text) }),
              );
          }
          return res;
        },
        (err) => {
          if (err?.name !== 'AbortError') {
            report({ ...base, status: 0, statusText: 'Network error', ms: Math.round(performance.now() - start), responseHeaders: {}, responseBody: '' });
          }
          throw err;
        },
      );
    };
  }
})();
