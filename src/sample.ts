/** Synthetic data only. Never derived from captures or private fixtures. */
export function sampleHar(count = 100) {
  return {
    log: {
      version: '1.2',
      creator: { name: 'Public analyzer sample', version: '1' },
      entries: Array.from({ length: count }, (_, i) => {
        const family = i % 10;
        const mime =
          family === 7
            ? 'text/html'
            : family === 8
              ? 'application/octet-stream'
              : family === 9
                ? 'text/plain'
                : 'application/json';
        const text =
          family === 7
            ? '<h1>Inert HTML sample</h1><script>throw new Error("never executed")</script>'
            : family === 8
              ? 'AAECAwQ='
              : family === 9
                ? `Result ${i}\nOutcome ${i % 3}\nDone`
                : JSON.stringify({
                    id: i,
                    ok: i % 3 !== 0,
                    items: [{ name: `item-${i}`, price: i + 0.5 }],
                    ...(i % 4 === 0 ? { detail: { code: 'alternate' } } : {}),
                  });
        const postData =
          family === 0
            ? {
                mimeType: 'application/json',
                text: JSON.stringify({ name: `item-${i}`, enabled: i % 3 !== 0 }),
              }
            : family === 1
              ? {
                  mimeType: 'application/xml',
                  text: `<item id="${i}"><name>item-${i}</name></item>`,
                }
              : family === 2
                ? {
                    mimeType: 'application/x-www-form-urlencoded',
                    text: `name=item-${i}&enabled=${i % 3 !== 0}`,
                  }
                : family === 3
                  ? {
                      mimeType: 'multipart/form-data; boundary=sample',
                      text: `--sample\r\nContent-Disposition: form-data; name="name"\r\n\r\nitem-${i}\r\n--sample--\r\n`,
                    }
                  : family === 4
                    ? {
                        mimeType: 'multipart/form-data',
                        params: [
                          { name: 'name', value: `item-${i}` },
                          {
                            name: 'attachment',
                            fileName: `item-${i}.txt`,
                            contentType: 'text/plain',
                          },
                        ],
                      }
                    : undefined;
        return {
          startedDateTime: '2026-01-01T00:00:00.000Z',
          time: 20 + (i % 300),
          request: {
            httpVersion: 'HTTP/1.1',
            method: family < 5 ? 'POST' : family === 5 && i % 3 === 0 ? 'HEAD' : 'GET',
            url: `https://sample.invalid/api/items/${family}${family === 6 ? `?name=item-${i}` : ''}`,
            headers: [
              { name: 'Accept', value: mime },
              ...(family === 7 ? [{ name: 'X-Example', value: String(i) }] : []),
            ],
            queryString: [],
            ...(postData ? { postData } : {}),
          },
          response: {
            httpVersion: 'HTTP/1.1',
            statusText: i % 3 === 0 ? 'Forbidden' : 'OK',
            status: i % 3 === 0 ? 403 : 200,
            headers: [
              { name: 'Content-Type', value: mime },
              { name: 'Set-Cookie', value: `a=${i}` },
              { name: 'Set-Cookie', value: 'b=2' },
            ],
            content: {
              mimeType: mime,
              size: text.length,
              ...(family === 5 ? {} : { text: family === 6 ? '' : text }),
              ...(family === 8 ? { encoding: 'base64' } : {}),
            },
          },
        };
      }),
    },
  };
}
