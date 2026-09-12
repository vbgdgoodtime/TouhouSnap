// 东方逆转 · 联机房间服务：一个房间 = 一个 Durable Object。
// 只转发、只按 (回合, 座位) 去重；游戏规则一律由两端各算一遍（服务端不是裁判，不校验合法性、不算分、不判胜负）。
// 不做断线重连：客户端刷新页面 = 离开房间，对方等提交包超时后会判那一方认输。

const ROOM_RE = /^[A-Z0-9]{6}$/;

function text(status, body) {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

// 另一个角色
function peerOf(role) {
  return role === "host" ? "guest" : "host";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return text(200, "东方逆转 · 联机房间服务：客户端连 /ws/<6 位房间码>\n");
    }
    if (!url.pathname.startsWith("/ws/")) {
      return text(404, "没有这个路径\n");
    }

    const room = url.pathname.slice("/ws/".length);
    if (!ROOM_RE.test(room)) {
      return text(400, "房间码必须是 6 位大写字母或数字\n");
    }
    if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
      return text(426, "这里只收 WebSocket 升级请求\n");
    }

    // 房间码相同 ⇒ 同一个 DO 实例
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request);
  },
};

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.room = "";
    this.sockets = { host: null, guest: null };
    this.tokens = {}; // 角色 → token：同一个 token 回来还是原角色；断开也让位不了（免得路人占了空位）
    this.turns = new Set(); // 已接受的「回合:座位」
    this.loaded = this.load();
  }

  // DO 空闲后会被回收，认人的 token 得从存储里读回来
  async load() {
    const stored = await this.state.storage.get(["tokens"]);
    this.tokens = stored.get("tokens") || {};
  }

  save() {
    return this.state.storage.put({ tokens: this.tokens });
  }

  send(role, payload) {
    const ws = this.sockets[role];
    if (!ws) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // 连接已经坏了，close / error 处理器会收尾
    }
  }

  // token 见过的角色照旧；否则 host → guest 顺序占坑；两个都占了返回 null
  claim(token) {
    for (const role of ["host", "guest"]) {
      if (token && this.tokens[role] === token) return role;
    }
    if (!("host" in this.tokens)) {
      this.tokens.host = token;
      return "host";
    }
    if (!("guest" in this.tokens)) {
      this.tokens.guest = token;
      return "guest";
    }
    return null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
      return text(426, "这里只收 WebSocket 升级请求\n");
    }
    this.room = url.pathname.slice("/ws/".length);
    await this.loaded;

    const token = url.searchParams.get("token") || "";
    const role = this.claim(token);

    const [client, server] = Object.values(new WebSocketPair());
    server.accept();

    if (!role) {
      // 两个角色都占着：不挤掉房里的人，只告诉新来的
      server.send(JSON.stringify({ t: "error", code: "full" }));
      server.close(1000, "full");
      return new Response(null, { status: 101, webSocket: client });
    }

    const old = this.sockets[role];
    this.sockets[role] = server;
    if (old) {
      // 同一个 token 开了两个页面：旧连接让位
      try {
        old.close(1000, "replaced");
      } catch {
        // 已经断了就算了
      }
    }
    await this.save();

    server.send(
      JSON.stringify({
        t: "welcome",
        room: this.room,
        role,
        peer: !!this.sockets[peerOf(role)],
      })
    );
    this.send(peerOf(role), { t: "peer", online: true });

    server.addEventListener("message", (event) => {
      this.onMessage(role, event.data);
    });
    const gone = () => this.gone(role, server);
    server.addEventListener("close", gone);
    server.addEventListener("error", gone);

    return new Response(null, { status: 101, webSocket: client });
  }

  onMessage(role, raw) {
    if (typeof raw !== "string") return;

    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      return; // 不是 JSON 就不管
    }
    if (!data || typeof data !== "object") return;

    if (data.t === "bye") {
      const ws = this.sockets[role];
      if (ws) {
        try {
          ws.close(1000, "bye");
        } catch {
          this.gone(role, ws);
        }
      }
      return;
    }
    if (data.t !== "msg") return;

    const msg = data.msg;
    if (!msg || typeof msg !== "object") return;

    if (msg.t === "turn") {
      // 同一个 (回合, 座位) 只认第一条 —— 重复提交（或两端各发一份）不会两份都生效
      const key = msg.round + ":" + msg.side;
      if (this.turns.has(key)) return;
      this.turns.add(key);
    }

    this.send(peerOf(role), { t: "msg", from: role, msg });
  }

  // 断开就**释放这个角色**（连同 token）：房间不保存任何对局状态，所以刷新/重开页面的人
  // 可以用同一个房间码重新进来（否则他会看到"房间已满"）。对手会先收到 peer:false。
  gone(role, ws) {
    if (this.sockets[role] !== ws) return; // 已被新连接顶替，别动新的
    this.sockets[role] = null;
    delete this.tokens[role];
    this.save();
    this.send(peerOf(role), { t: "peer", online: false });
  }
}
