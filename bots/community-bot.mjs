// src/shared/protocol.ts
var PACKET = {
  Name: 32,
  FunData: 32,
  Mapping: 7,
  FunctionKey: 169,
  Trigger: 32,
  Stick: 36,
  Sensor: 41
};
var CalPart = {
  LeftStick: 1 << 0,
  RightStick: 1 << 1,
  LeftTrigger: 1 << 2,
  RightTrigger: 1 << 3,
  Motion: 1 << 4,
  Sticks: 1 << 0 | 1 << 1,
  Triggers: 1 << 2 | 1 << 3
};

// src/shared/profile.ts
var FUN = PACKET.Name;
var DEAD_OFFSET = 3;
function readDeadzone(p) {
  return {
    begin: p.u16be(DEAD_OFFSET),
    end: p.u16be(DEAD_OFFSET + 2),
    beginAnti: p.u16be(DEAD_OFFSET + 4),
    endAnti: p.u16be(DEAD_OFFSET + 6)
  };
}
function writeDeadzone(p, d) {
  p.setU16be(DEAD_OFFSET, d.begin);
  p.setU16be(DEAD_OFFSET + 2, d.end);
  p.setU16be(DEAD_OFFSET + 4, d.beginAnti);
  p.setU16be(DEAD_OFFSET + 6, d.endAnti);
}
var trigger = {
  deadEnabled: (p) => p.bit(2, 0),
  setDeadEnabled: (p, on) => p.setBit(2, 0, on),
  deadzone: readDeadzone,
  setDeadzone: writeDeadzone,
  /** Deadzone as whole percent for the UI (5 → "5%"). */
  deadzonePercent(d) {
    return { begin: d.begin / 10, end: d.end / 10, beginAnti: d.beginAnti / 10, endAnti: d.endAnti / 10 };
  },
  mapped: (p) => p.bit(11, 0),
  mapValues: (p) => [p.u8(12), p.u8(13), p.u8(14)],
  setMap: (p, keys) => {
    p.setBit(11, 0, keys.some((k) => k !== 0));
    p.setU8(12, keys[0]);
    p.setU8(13, keys[1]);
    p.setU8(14, keys[2]);
  },
  toggleOnPress: (p) => p.bit(15, 0),
  setToggle: (p, on) => p.setBit(15, 0, on),
  quickTrigger: {
    status: (p) => p.u8(16),
    start: (p) => p.u8(17),
    end: (p) => p.u8(18),
    set: (p, status, start, end) => {
      p.setU8(16, status);
      p.setU8(17, start);
      p.setU8(18, end);
    }
  }
};
var stick = {
  enabled: (p) => p.bit(0, 0),
  setEnabled: (p, on) => p.setBit(0, 0, on),
  /** True when the stick profile byte is cleared (`stick_en = 0`). */
  isProfileBypassed: (p) => !stick.enabled(p),
  /**
   * GameSir's "Stick Trajectory" switch — their `stick_square` byte.
   *
   * Proven from GameSir Connect's own bundle: its reader sets
   * `rawEnabled = (stick_square != 0)` (defaulting to true when `stick_en` is
   * 0) and its writer always emits `stick_en = 1; stick_square = rawEnabled ?
   * 1 : 0`, with `STICKCURVE_MODE = { Square: 0, Circle: 1 }` consumed as
   * `type = rawEnabled ? Square : Circle`. Their UI names the two states
   * "Circle" (outer path corrected into a pure circle) and "Raw" (raw sensor
   * data, a square-circle path). There is no vendor third mode, and no code
   * path in their app ever clears `stick_en`.
   */
  squareGate: (p) => p.bit(1, 0),
  setSquareGate: (p, on) => p.setBit(1, 0, on),
  deadEnabled: (p) => p.bit(2, 0),
  setDeadEnabled: (p, on) => p.setBit(2, 0, on),
  deadzone: readDeadzone,
  setDeadzone: writeDeadzone,
  deadzonePercent: trigger.deadzonePercent,
  /** Curve sample points: 5 × (original, target), bytes 14..23. */
  curve(p) {
    const points = [];
    for (let i = 0; i < 5; i++) {
      points.push({ x: p.u8(14 + i * 2), y: p.u8(15 + i * 2) });
    }
    return points;
  },
  setCurve(p, points) {
    points.slice(0, 5).forEach((pt, i) => {
      p.setU8(14 + i * 2, pt.x);
      p.setU8(15 + i * 2, pt.y);
    });
  },
  /**
   * Curve transform, bytes 11..13 (`linear_module_en`, curve type,
   * curve rate in GameSir's own reader/writer).
   *
   * The 5 curve points are NOT the whole story: the firmware also applies
   * this transform on top. Proven against stock fixtures — every linear
   * stick carries `en=1/type=0/rate=100` (identity), while shaped sticks
   * carry e.g. `type=3/rate=74` or `type=1/rate=65`. Writing curve points
   * without resetting these bytes leaves a stale transform active, so the
   * pad keeps bending the new points with the old curvature — curves
   * (including linear/raw) feel wrong until the type is rewritten too.
   */
  linearModule(p) {
    return { en: p.bit(11, 0), type: p.u8(12), rate: p.u8(13) };
  },
  setLinearModule(p, en, type, rate) {
    p.setBit(11, 0, en);
    p.setU8(12, type);
    p.setU8(13, rate);
  },
  /**
   * Identity transform: the 5 points are used exactly as written.
   * Always pair with a curve write — never write points alone.
   */
  markCurveIdentity(p) {
    stick.setLinearModule(p, true, 0, 100);
  },
  /** Matching points are a no-op only when no vendor curve transform remains. */
  matchesCurveIdentity(p, points) {
    const lm = stick.linearModule(p);
    const current = stick.curve(p);
    return lm.en && lm.type === 0 && lm.rate === 100 && points.length === current.length && points.every((q, i) => q.x === current[i].x && q.y === current[i].y);
  },
  /** True when the 5 points are linear AND the transform is identity. */
  isIdentityCurve(p) {
    const pts = stick.curve(p);
    const lm = stick.linearModule(p);
    return lm.en && lm.type === 0 && lm.rate === 100 && pts.length === LINEAR_CURVE.length && pts.every((q, i) => q.x === LINEAR_CURVE[i].x && q.y === LINEAR_CURVE[i].y);
  },
  /**
   * Output lock: force locked sticks back to normal stick output.
   *
   * Only repairs `mapIndex 4` (Mouse) → 1/2 (this stick) and touches nothing
   * else — no deadzone/curve/rate bytes, no `mapped` flag. Returns whether
   * anything changed. Used by the write path so a locked stick can never
   * reach the pad in Mouse output (runaway-cursor guard).
   */
  lockStickOutput(sticks, locks) {
    let changed = false;
    sticks.forEach((s, i) => {
      if (locks[i] && stick.mapIndex(s) === 4) {
        stick.setMapIndex(s, i === 0 ? 1 : 2);
        changed = true;
      }
    });
    return changed;
  },
  /**
   * Our neutral-state classifier: the calibrated identity (processing on,
   * linear points with an identity transform, zero deadzone window, neutral
   * axis ratio, no square bit) or the legacy full bypass (`stick_en` clear,
   * which older builds of this app wrote as "pure raw 1:1").
   *
   * This is deliberately NOT called "raw" any more: the vendor's Raw is the
   * `stick_square` trajectory above (raw sensor data at the outer edge), and
   * this app no longer clears `stick_en` — the UI reads the trajectory bit
   * directly and only mentions the bypass when it finds one. Kept because
   * tests/curveidentity.ts pins the byte behaviour of both states.
   */
  isNeutralState(p) {
    if (!stick.enabled(p)) return true;
    const dz = stick.deadzone(p);
    return stick.enabled(p) && !stick.squareGate(p) && stick.deadEnabled(p) && dz.begin === 0 && dz.end === 1e3 && dz.beginAnti === 0 && dz.endAnti === 1e3 && stick.isIdentityCurve(p) && stick.axisRatio(p) === 50;
  },
  /** Map block begins at byte 24. */
  mapped: (p) => p.bit(24, 0),
  setMapped: (p, on) => p.setBit(24, 0, on),
  /**
   * Axis invert flags, bytes +25/+26 (bit 0 each, like every other `*_en`
   * flag in this packet). Always 0 in the captured fixtures, so the exact
   * polarity is vendor-undocumented — verify on the live sticks after
   * setting. Writes touch only bit 0 so neighbouring bits survive.
   */
  flipX: (p) => p.bit(25, 0),
  setFlipX: (p, on) => p.setBit(25, 0, on),
  flipY: (p) => p.bit(26, 0),
  setFlipY: (p, on) => p.setBit(26, 0, on),
  axisRatio: (p) => p.u8(27),
  setAxisRatio: (p, v) => p.setU8(27, v),
  /** Ratio the firmware applies: an unmapped stick behaves as balanced (50). */
  axisScale: (p) => stick.mapped(p) ? stick.axisRatio(p) : 50,
  /**
   * Connect's X/Y sensitivity scale: 0 horizontal only, 50 balanced, 100
   * vertical only. Connect always writes the map block enabled, so an
   * unmapped stick gets its own default output (1 left / 2 right); an
   * existing mapping (e.g. Mouse) is kept.
   */
  setAxisScale(p, side, ratio) {
    if (!stick.mapped(p)) {
      stick.setMapped(p, true);
      stick.setMapIndex(p, side === 0 ? 1 : 2);
    }
    stick.setAxisRatio(p, Math.max(0, Math.min(100, Math.round(ratio))));
  },
  mapIndex: (p) => p.u8(29),
  setMapIndex: (p, v) => p.setU8(29, v),
  /**
   * Mouse-mapping sensitivity, byte 28 (GameSir `map_module.mouse_dpi`).
   * Only has an effect once `mapIndex` is 4 (`Mouse`) — see PROTOCOL §12.4.
   * Neutral is 50.
   */
  mouseDpi: (p) => p.u8(28),
  setMouseDpi: (p, v) => p.setU8(28, v),
  /**
   * Zero dead zone, pure linear 1:1 — the "physics" preset.
   *
   * `dead_en` stays on with `begin = 0`, so the input window becomes
   * `[0,100] → [0,100]`: nothing is clipped at the bottom and full output still
   * arrives only at full deflection. The output window is left neutral and
   * `axis_ratio` neutral, and the curve transform bytes reset to identity
   * (type 0 / rate 100) — without that, a stale curvature from a previous
   * preset keeps bending the linear points and the stick does not feel raw.
   *
   * Deliberately preserves the orthogonal axes: shape gate, flips, output
   * mapping and mouse rate are left alone, so this preset linearises
   * response without disturbing gate or output choices.
   *
   * These are EEPROM bytes in the stick packet, not an app-side transform —
   * PROTOCOL §4.5 and §12.5. Lives here rather than in the page so the exact
   * bytes it produces can be pinned by a test instead of eyeballed.
   */
  applyPhysics(p) {
    p.setBit(2, 0, true);
    writeDeadzone(p, { begin: 0, end: 1e3, beginAnti: 0, endAnti: 1e3 });
    for (let i = 0; i < LINEAR_CURVE.length; i++) {
      p.setU8(14 + i * 2, LINEAR_CURVE[i].x);
      p.setU8(15 + i * 2, LINEAR_CURVE[i].y);
    }
    p.setU8(27, 50);
    stick.markCurveIdentity(p);
  }
};
var LINEAR_CURVE = [
  { x: 0, y: 0 },
  { x: 64, y: 64 },
  { x: 128, y: 128 },
  { x: 191, y: 191 },
  { x: 255, y: 255 }
];

// src/shared/sharecode.ts
var CURVE_PREFIX = "SLC1.";
var PROFILE_PREFIX = "SLP1.";
var ShareCodeError = class extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
  code;
};
var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function toBase64Url(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = bytes[i] << 16 | (bytes[i + 1] ?? 0) << 8 | (bytes[i + 2] ?? 0);
    out += B64[n >> 18 & 63] + B64[n >> 12 & 63];
    if (i + 1 < bytes.length) out += B64[n >> 6 & 63];
    if (i + 2 < bytes.length) out += B64[n & 63];
  }
  return out;
}
function fromBase64Url(text) {
  const clean = text.replace(/[\s=]/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const out = [];
  let acc = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new ShareCodeError("damaged");
    acc = acc << 6 | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push(acc >> bits & 255);
    }
  }
  return Uint8Array.from(out);
}
function encodeCurve(curve) {
  const body = { s: curve.scale, p: curve.pts.flatMap((q) => [Math.round(q.x), Math.round(q.y)]) };
  if (curve.name) body.n = curve.name.slice(0, 24);
  return CURVE_PREFIX + toBase64Url(new TextEncoder().encode(JSON.stringify(body)));
}
function decodeCurve(code) {
  const text = code.trim();
  if (!text.startsWith(CURVE_PREFIX)) throw new ShareCodeError(text.startsWith(PROFILE_PREFIX) ? "isProfile" : "notCurve");
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(fromBase64Url(text.slice(CURVE_PREFIX.length))));
  } catch {
    throw new ShareCodeError("damaged");
  }
  const scale = body.s === 1e3 ? 1e3 : body.s === 255 ? 255 : null;
  if (!scale) throw new ShareCodeError("damaged");
  const flat = Array.isArray(body.p) ? body.p : [];
  if (flat.length % 2 !== 0 || flat.length < 4 || flat.length > 20 || !flat.every((v) => Number.isInteger(v) && v >= 0 && v <= scale)) {
    throw new ShareCodeError("badPoints");
  }
  const pts = [];
  for (let i = 0; i < flat.length; i += 2) pts.push({ x: flat[i], y: flat[i + 1] });
  for (let i = 1; i < pts.length; i++) if (pts[i].x < pts[i - 1].x) throw new ShareCodeError("badPoints");
  const name = typeof body.n === "string" && body.n.trim() ? body.n.trim().slice(0, 24) : void 0;
  return { name, scale, pts };
}

// src/shared/community.ts
var COMMUNITY_REPO = "Realkiyoshii/stick-labs";
var COMMUNITY_BRANCH = "community-data";
var COMMUNITY_FEED_URL = `https://raw.githubusercontent.com/${COMMUNITY_REPO}/${COMMUNITY_BRANCH}/curves.json`;
var COMMUNITY_LABEL = "community-curve";
var COMMUNITY_GAMES = [
  "Apex Legends",
  "Call of Duty",
  "Fortnite",
  "Rainbow Six Siege",
  "Overwatch 2",
  "Marvel Rivals",
  "The Finals",
  "Battlefield",
  "Valorant",
  "Other"
];
var COMMUNITY_LIMITS = {
  perDay: 5,
  perAuthor: 50,
  /** Hidden once reports reach this and outnumber likes. */
  hideReports: 5,
  feedMax: 5e3
};
var BLOCKED = ["nigg", "fagg", "retard", "kike", "chink", "tranny", "whore", "slut", "cunt", "nazi", "hitler", "porn", "fuck", "shit", "bitch", "pussy"];
function cleanCurveName(raw) {
  const name = raw.replace(/[\u0000-\u001f\u007f​-‏‪-‮]/g, "").replace(/https?:\/\/\S+|www\.\S+/gi, "").replace(/[<>`@#]/g, "").replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 24) return null;
  const letters = name.toLowerCase().normalize("NFKD").replace(/[0@]/g, "o").replace(/[1!|]/g, "i").replace(/3/g, "e").replace(/[4]/g, "a").replace(/[5$]/g, "s").replace(/[^a-z]/g, "");
  if (BLOCKED.some((w) => letters.includes(w))) return null;
  return name;
}
function to255(curve) {
  const k = 255 / curve.scale;
  return curve.pts.map((q) => ({ x: Math.round(q.x * k), y: Math.round(q.y * k) }));
}
function sameCurve(a, b) {
  return JSON.stringify(to255(a)) === JSON.stringify(to255(b));
}
function parseFeed(data) {
  const list = data?.curves;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list.slice(0, COMMUNITY_LIMITS.feedMax)) {
    const e = raw;
    try {
      if (!Number.isInteger(e.id) || e.id < 1) continue;
      const name = typeof e.name === "string" ? cleanCurveName(e.name) : null;
      const game = COMMUNITY_GAMES.find((g) => g === e.game) ?? "Other";
      const author = typeof e.author === "string" && /^[A-Za-z0-9-]{1,39}$/.test(e.author) ? e.author : null;
      if (!name || !author) continue;
      const flat = Array.isArray(e.pts) ? e.pts : [];
      const curve = decodeCurve(encodeCurve({ scale: e.scale === 1e3 ? 1e3 : 255, pts: pairs(flat) }));
      const likes = Number.isInteger(e.likes) && e.likes > 0 ? e.likes : 0;
      const created = typeof e.created === "string" && !Number.isNaN(Date.parse(e.created)) ? e.created : (/* @__PURE__ */ new Date(0)).toISOString();
      out.push({ id: e.id, name, game, author, scale: curve.scale, pts: curve.pts, likes, created });
    } catch {
    }
  }
  return out;
}
function pairs(flat) {
  const pts = [];
  for (let i = 0; i + 1 < flat.length; i += 2) pts.push({ x: flat[i], y: flat[i + 1] });
  return pts;
}
function serializeFeed(curves, updated) {
  return JSON.stringify({
    version: 1,
    updated,
    curves: curves.map((c) => ({ id: c.id, name: c.name, game: c.game, author: c.author, scale: c.scale, pts: c.pts.flatMap((q) => [q.x, q.y]), likes: c.likes, created: c.created }))
  });
}
function parseIssueForm(body) {
  const fields = {};
  const parts = body.replace(/\r/g, "").split(/^### /m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf("\n");
    const label = part.slice(0, nl < 0 ? void 0 : nl).trim().toLowerCase();
    const value = nl < 0 ? "" : part.slice(nl + 1).trim();
    fields[label] = value === "_No response_" ? "" : value;
  }
  return { name: fields["curve name"] ?? "", game: fields["game"] ?? "", code: (fields["curve code"] ?? "").replace(/```\w*/g, "").trim() };
}

// scripts/community-bot.ts
var repo = process.env.GITHUB_REPOSITORY || COMMUNITY_REPO;
var token = process.env.GITHUB_TOKEN;
if (!token) throw new Error("GITHUB_TOKEN is required");
async function gh(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json", ...init.headers }
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} \u2192 ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : await res.json();
}
var has = (issue, label) => issue.labels.some((l) => l.name === label);
async function liveIssues() {
  const out = [];
  for (let page = 1; ; page++) {
    const batch = await gh(`/repos/${repo}/issues?labels=${COMMUNITY_LABEL},live&state=open&per_page=100&page=${page}`);
    out.push(...batch.filter((i) => !i.pull_request));
    if (batch.length < 100) return out;
  }
}
function readSubmission(issue) {
  const form = parseIssueForm(issue.body ?? "");
  const errors = [];
  const name = cleanCurveName(form.name);
  if (!name) errors.push("The curve name must be 2\u201324 characters and follow the community rules.");
  const game = COMMUNITY_GAMES.find((g) => g === form.game);
  if (!game) errors.push("Pick a game from the list.");
  let decoded = null;
  try {
    decoded = decodeCurve(form.code);
  } catch {
    errors.push('The curve code is missing or damaged. In Stick Labs, press "Copy curve code" on the Curves tab and paste it again.');
  }
  if (errors.length || !name || !game || !decoded) return { errors };
  return {
    errors,
    curve: { id: issue.number, name, game, author: issue.user.login, scale: decoded.scale, pts: decoded.pts, likes: issue.reactions?.["+1"] ?? 0, created: issue.created_at }
  };
}
async function comment(n, text) {
  await gh(`/repos/${repo}/issues/${n}/comments`, { method: "POST", body: JSON.stringify({ body: text }) });
}
async function validate(n) {
  const issue = await gh(`/repos/${repo}/issues/${n}`);
  if (!has(issue, COMMUNITY_LABEL) || issue.pull_request) return console.log(`#${n}: not a curve submission`);
  if (issue.state === "closed" && !has(issue, "rejected")) return console.log(`#${n}: closed, skipping`);
  const { curve, errors } = readSubmission(issue);
  const user = await gh(`/users/${encodeURIComponent(issue.user.login)}`);
  if (user.type !== "User") errors.push("Only personal GitHub accounts can post curves.");
  const others = (await liveIssues()).filter((i) => i.number !== n);
  const mine = others.filter((i) => i.user.login === issue.user.login);
  if (mine.filter((i) => Date.now() - Date.parse(i.created_at) < 864e5).length >= COMMUNITY_LIMITS.perDay) errors.push(`You can post ${COMMUNITY_LIMITS.perDay} curves a day. Try again tomorrow.`);
  if (mine.length >= COMMUNITY_LIMITS.perAuthor) errors.push(`You already have ${COMMUNITY_LIMITS.perAuthor} curves posted. Close an old one first.`);
  if (curve) {
    const copy = others.map(readSubmission).find((s) => s.curve && sameCurve(s.curve, curve));
    if (copy?.curve) errors.push(`This curve is already posted as "${copy.curve.name}" (#${copy.curve.id}).`);
  }
  if (errors.length === 0 && curve) {
    if (!has(issue, "live")) {
      await gh(`/repos/${repo}/issues/${n}/labels`, { method: "POST", body: JSON.stringify({ labels: ["live"] }) });
      if (has(issue, "rejected")) await gh(`/repos/${repo}/issues/${n}/labels/rejected`, { method: "DELETE" });
      if (issue.state === "closed") await gh(`/repos/${repo}/issues/${n}`, { method: "PATCH", body: JSON.stringify({ state: "open" }) });
      await comment(n, `\u2705 **${curve.name}** is live in Community curves in the app and the web app.

React \u{1F44D} if you like it. React \u{1F44E} to report it.`);
    }
    console.log(`#${n}: live`);
    return;
  }
  if (has(issue, "live")) await gh(`/repos/${repo}/issues/${n}/labels/live`, { method: "DELETE" });
  if (!has(issue, "rejected")) await gh(`/repos/${repo}/issues/${n}/labels`, { method: "POST", body: JSON.stringify({ labels: ["rejected"] }) });
  await comment(n, `\u274C This curve wasn't posted:

${errors.map((e) => `- ${e}`).join("\n")}

Edit this issue to fix it and the bot checks it again.`);
  if (issue.state === "open") await gh(`/repos/${repo}/issues/${n}`, { method: "PATCH", body: JSON.stringify({ state: "closed", state_reason: "not_planned" }) });
  console.log(`#${n}: rejected \u2014 ${errors.join(" | ")}`);
}
async function rebuild() {
  const curves = [];
  for (const issue of await liveIssues()) {
    const { curve } = readSubmission(issue);
    if (!curve) continue;
    const likes = issue.reactions?.["+1"] ?? 0;
    const reports = issue.reactions?.["-1"] ?? 0;
    if (reports >= COMMUNITY_LIMITS.hideReports && reports > likes) continue;
    if (curves.some((c) => sameCurve(c, curve))) continue;
    curves.push(curve);
  }
  curves.sort((a, b) => b.created.localeCompare(a.created));
  const path = `/repos/${repo}/contents/curves.json`;
  let sha;
  let current = "";
  try {
    const file = await gh(`${path}?ref=${COMMUNITY_BRANCH}`);
    sha = file.sha;
    current = Buffer.from(file.content, "base64").toString("utf8");
  } catch {
  }
  const strip = (json) => {
    try {
      return JSON.stringify(parseFeed(JSON.parse(json)));
    } catch {
      return "";
    }
  };
  const next = serializeFeed(curves, (/* @__PURE__ */ new Date()).toISOString());
  if (current && strip(current) === strip(next)) return console.log(`feed unchanged (${curves.length} curves)`);
  await gh(path, { method: "PUT", body: JSON.stringify({ message: `community: ${curves.length} curves`, content: Buffer.from(next).toString("base64"), branch: COMMUNITY_BRANCH, sha }) });
  console.log(`feed written (${curves.length} curves)`);
}
var [mode, arg] = process.argv.slice(2);
if (mode === "validate") await validate(Number(arg));
else if (mode === "rebuild") await rebuild();
else throw new Error("usage: community-bot validate <issue> | rebuild");
