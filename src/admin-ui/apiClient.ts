/** Embedded console apiClient; composed into the nonce-protected HTML shell. */
export const apiClient = String.raw`    function current(session) {
      if (session !== connection || session.signal.aborted) throw new DOMException("连接已结束", "AbortError");
    }
    async function api(path, method, body, session = connection) {
      current(session);
      if (!token) throw new Error("请先连接管理员令牌");
      const response = await fetch("/api/v1" + path, {
        method: method || "GET",
        headers: {Authorization: "Bearer " + token, ...(body === undefined ? {} : {"Content-Type":"application/json"})},
        ...(body === undefined ? {} : {body:JSON.stringify(body)}),
        cache:"no-store",
        credentials:"omit",
        signal:session.signal
      });
      const data = await response.json().catch(() => ({}));
      current(session);
      if (!response.ok) {
        const err = data.error || {};
        const error = new Error((err.code || "HTTP_" + response.status) + ": " + (err.message || response.statusText));
        error.code = err.code;error.status = response.status;
        if (response.status === 401) {endConnection();notify("令牌已过期或无效，请重新连接。" + error.message,true);}
        throw error;
      }
      return data;
    }
    async function allPages(path, session) {
      const output = [];
      for (let offset = 0; offset < 10000; offset += 100) {
        const data = await api(path + "?offset=" + offset + "&limit=100", undefined, undefined, session);
        output.push(...(data.items || []));
        if (!data.items || data.items.length < 100) return output;
      }
      throw new Error("管理列表超过 10000 条，请缩小数据范围");
    }
`;
