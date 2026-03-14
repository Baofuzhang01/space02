// ====================================================================
// 多学校抢座管理中枢 — Cloudflare Worker
// ====================================================================
// 功能:
//   1. scheduled()  每分钟轮询所有学校，到点为活跃用户发 dispatch
//   2. fetch()      REST API + 内嵌 Web 管理面板
//
// KV Schema (binding: SEAT_KV):
//   schools                     → 学校 ID 列表 ["001", "002", "003"]
//   school:{id}                 → 学校配置 { id, name, trigger_time, endtime, repo, strategy }
//   school:{id}:users           → 用户 ID 列表
//   school:{id}:user:{userId}   → 单用户完整配置
//
// Secrets: GH_TOKEN, API_KEY
// ====================================================================

const AES_KEY_RAW = "u2oh6Vu^HWe4_AES";

async function getAesKey() {
  const raw = new TextEncoder().encode(AES_KEY_RAW);
  return crypto.subtle.importKey("raw", raw, { name: "AES-CBC" }, false, ["encrypt"]);
}

function pkcs7Pad(data) {
  const bs = 16;
  const pad = bs - (data.length % bs);
  const out = new Uint8Array(data.length + pad);
  out.set(data);
  out.fill(pad, data.length);
  return out;
}

async function aesEncrypt(plaintext) {
  const key = await getAesKey();
  const iv = new TextEncoder().encode(AES_KEY_RAW);
  const padded = pkcs7Pad(new TextEncoder().encode(plaintext));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, padded);
  return btoa(String.fromCharCode(...new Uint8Array(encrypted)));
}

// ─── 辅助函数 ───

function beijingNow() {
  return new Date(Date.now() + 8 * 3600 * 1000);
}

function beijingHHMM() {
  const d = beijingNow();
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function beijingDate() {
  const d = beijingNow();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function beijingDayOfWeek() {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return days[beijingNow().getUTCDay()];
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

// ─── KV 操作 ───

async function getSchools(KV) {
  const raw = await KV.get("schools");
  return raw ? JSON.parse(raw) : [];
}

async function saveSchools(KV, schools) {
  await KV.put("schools", JSON.stringify(schools));
}

async function getSchool(KV, schoolId) {
  const raw = await KV.get(`school:${schoolId}`);
  return raw ? JSON.parse(raw) : null;
}

async function saveSchool(KV, school) {
  await KV.put(`school:${school.id}`, JSON.stringify(school));
}

async function deleteSchool(KV, schoolId) {
  // 删除学校配置
  await KV.delete(`school:${schoolId}`);
  // 删除学校下所有用户
  const userIds = await getSchoolUsers(KV, schoolId);
  for (const uid of userIds) {
    await KV.delete(`school:${schoolId}:user:${uid}`);
  }
  await KV.delete(`school:${schoolId}:users`);
  // 从学校列表移除
  const schools = await getSchools(KV);
  await saveSchools(KV, schools.filter(id => id !== schoolId));
}

async function getSchoolUsers(KV, schoolId) {
  const raw = await KV.get(`school:${schoolId}:users`);
  return raw ? JSON.parse(raw) : [];
}

async function saveSchoolUsers(KV, schoolId, userIds) {
  await KV.put(`school:${schoolId}:users`, JSON.stringify(userIds));
}

async function getUser(KV, schoolId, userId) {
  const raw = await KV.get(`school:${schoolId}:user:${userId}`);
  return raw ? JSON.parse(raw) : null;
}

async function saveUser(KV, schoolId, user) {
  await KV.put(`school:${schoolId}:user:${user.id}`, JSON.stringify(user));
}

async function deleteUser(KV, schoolId, userId) {
  await KV.delete(`school:${schoolId}:user:${userId}`);
  const userIds = await getSchoolUsers(KV, schoolId);
  await saveSchoolUsers(KV, schoolId, userIds.filter(id => id !== userId));
}

// ─── 默认配置 ───

function defaultSchool(id, name) {
  return {
    id,
    name,
    trigger_time: "19:57",
    endtime: "20:00:40",
    fidEnc: "",
    reading_zone_groups: [],
    repo: `BAOfuZhan/${id}`,
    strategy: {
      mode: "C",
      submit_mode: "serial",
      login_lead_seconds: 14,
      slider_lead_seconds: 10,
      pre_fetch_token_ms: 1531,
      first_submit_offset_ms: 9,
      target_offset2_ms: 24,
      target_offset3_ms: 140,
      token_fetch_delay_ms: 45,
      token_fetch_delay_range_ms: [45, 45],
      burst_offsets_ms: [120, 420, 820],
      burst_jitter_range_ms: [0, 0],
    },
  };
}

function defaultUser(id) {
  return {
    id,
    phone: "",
    username: "",
    password: "",
    remark: "",
    status: "active",
    schedule: {
      Monday: { enabled: false, slots: [{roomid:"",seatid:"",times:"",seatPageId:"",fidEnc:""},{roomid:"",seatid:"",times:"",seatPageId:"",fidEnc:""},{roomid:"",seatid:"",times:"",seatPageId:"",fidEnc:""}] },
      Tuesday: { enabled: false, slots: [{roomid:"",seatid:"",times:"",seatPageId:"",fidEnc:""},{roomid:"",seatid:"",times:"",seatPageId:"",fidEnc:""},{roomid:"",seatid:"",times:"",seatPageId:"",fidEnc:""}] },
      Wednesday: { enabled: false, slots: [{roomid:"",seatid:"",times:"",seatPageId:"",fidEnc:""},{roomid:"",seatid:"",times:"",seatPageId:"",fidEnc:""},{roomid:"",seatid:"",times:"",seatPageId:"",fidEnc:""}] },
      Thursday: { enabled: false, slots: [{roomid:"",seatid:"",times:"",seatPageId:"",fidEnc:""},{roomid:"",seatid:"",times:"",seatPageId:"",fidEnc:""},{roomid:"",seatid:"",times:"",seatPageId:"",fidEnc:""}] },
      Friday: { enabled: false, slots: [{roomid:"",seatid:"",times:"",seatPageId:"",fidEnc:""},{roomid:"",seatid:"",times:"",seatPageId:"",fidEnc:""},{roomid:"",seatid:"",times:"",seatPageId:"",fidEnc:""}] },
      Saturday: { enabled: false, slots: [{roomid:"",seatid:"",times:"",seatPageId:"",fidEnc:""},{roomid:"",seatid:"",times:"",seatPageId:"",fidEnc:""},{roomid:"",seatid:"",times:"",seatPageId:"",fidEnc:""}] },
      Sunday: { enabled: false, slots: [{roomid:"",seatid:"",times:"",seatPageId:"",fidEnc:""},{roomid:"",seatid:"",times:"",seatPageId:"",fidEnc:""},{roomid:"",seatid:"",times:"",seatPageId:"",fidEnc:""}] },
    },
  };
}

// ─── GitHub Dispatch ───

async function dispatchGitHub(token, repo, payload) {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "TongYi-Worker",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ event_type: "reserve", client_payload: payload }),
    });
    return res.status === 204;
  } catch (e) {
    console.error("dispatchGitHub error:", e);
    return false;
  }
}

async function dispatchGitHubVerbose(token, repo, payload) {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "TongYi-Worker",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ event_type: "reserve", client_payload: payload }),
    });
    const text = await res.text();
    return { ok: res.status === 204, status: res.status, detail: text };
  } catch (e) {
    return { ok: false, status: 0, detail: e.message || String(e) };
  }
}

// ─── 创建并初始化 GitHub 仓库（内容复制自 hcd）───
const SOURCE_REPO_NAME = "hcd";

async function createAndInitRepo(repoFullName, ghToken) {
  const parts = repoFullName.split("/");
  if (parts.length !== 2) throw new Error(`仓库格式错误: ${repoFullName}，应为 owner/repo`);
  const [owner, repoName] = parts;

  // 源仓库与目标相同则跳过
  if (repoName === SOURCE_REPO_NAME) return { ok: true, skipped: true, reason: "目标即源仓库，跳过" };

  const ghHeaders = {
    Authorization: `Bearer ${ghToken}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "TongYi-Worker",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  // Step 1: 创建新仓库（空，不自动初始化）
  const createResp = await fetch("https://api.github.com/user/repos", {
    method: "POST",
    headers: ghHeaders,
    body: JSON.stringify({
      name: repoName,
      private: false,
      auto_init: false,
      description: `ChaoXing seat reservation - ${repoName}`,
    }),
  });
  const alreadyExists = createResp.status === 422;
  if (!createResp.ok && !alreadyExists) {
    const err = await createResp.text();
    throw new Error(`创建仓库失败 (${createResp.status}): ${err}`);
  }

  // Step 2: 获取源仓库 hcd 的完整文件树
  const treeResp = await fetch(
    `https://api.github.com/repos/${owner}/${SOURCE_REPO_NAME}/git/trees/HEAD?recursive=1`,
    { headers: ghHeaders }
  );
  if (!treeResp.ok) throw new Error(`获取源仓库文件树失败: ${treeResp.status}`);
  const { tree: sourceTree } = await treeResp.json();
  const blobs = sourceTree.filter((item) => item.type === "blob");

  // Step 3: 逐个复制 blob 到新仓库
  const newTreeEntries = [];
  for (const item of blobs) {
    const blobResp = await fetch(
      `https://api.github.com/repos/${owner}/${SOURCE_REPO_NAME}/git/blobs/${item.sha}`,
      { headers: ghHeaders }
    );
    if (!blobResp.ok) continue;
    const blobData = await blobResp.json();

    const newBlobResp = await fetch(
      `https://api.github.com/repos/${owner}/${repoName}/git/blobs`,
      {
        method: "POST",
        headers: ghHeaders,
        body: JSON.stringify({ content: blobData.content, encoding: blobData.encoding }),
      }
    );
    if (!newBlobResp.ok) continue;
    const { sha: newSha } = await newBlobResp.json();
    newTreeEntries.push({ path: item.path, mode: item.mode, type: "blob", sha: newSha });
  }

  // Step 4: 在新仓库创建 tree
  const newTreeResp = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/git/trees`,
    {
      method: "POST",
      headers: ghHeaders,
      body: JSON.stringify({ tree: newTreeEntries }),
    }
  );
  if (!newTreeResp.ok) throw new Error(`创建 tree 失败: ${newTreeResp.status}`);
  const { sha: newTreeSha } = await newTreeResp.json();

  // Step 5: 创建初始 commit（无父节点）
  const newCommitResp = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/git/commits`,
    {
      method: "POST",
      headers: ghHeaders,
      body: JSON.stringify({
        message: `init: copy from ${owner}/${SOURCE_REPO_NAME}`,
        tree: newTreeSha,
      }),
    }
  );
  if (!newCommitResp.ok) throw new Error(`创建 commit 失败: ${newCommitResp.status}`);
  const { sha: newCommitSha } = await newCommitResp.json();

  // Step 6: 创建或更新 main 分支
  const refResp = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/git/refs`,
    {
      method: "POST",
      headers: ghHeaders,
      body: JSON.stringify({ ref: "refs/heads/main", sha: newCommitSha }),
    }
  );
  if (refResp.status === 422) {
    // 分支已存在，强制更新
    const patchResp = await fetch(
      `https://api.github.com/repos/${owner}/${repoName}/git/refs/heads/main`,
      {
        method: "PATCH",
        headers: ghHeaders,
        body: JSON.stringify({ sha: newCommitSha, force: true }),
      }
    );
    if (!patchResp.ok) throw new Error(`更新 main 分支失败: ${patchResp.status}`);
  } else if (!refResp.ok) {
    throw new Error(`创建 main 分支失败: ${refResp.status}`);
  }

  return { ok: true, repo: `${owner}/${repoName}`, files: newTreeEntries.length };
}

const BATCH_SIZE = 20;

function randIntInclusive(min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function parseRangeWithFallback(v, fallback) {
  if (Array.isArray(v) && v.length >= 2) {
    const a = parseInt(v[0], 10);
    const b = parseInt(v[1], 10);
    if (!Number.isNaN(a) && !Number.isNaN(b)) return [a, b];
  }
  if (typeof v === "string" && v.includes(",")) {
    const parts = v.split(",").map(x => parseInt(x.trim(), 10));
    if (parts.length >= 2 && !Number.isNaN(parts[0]) && !Number.isNaN(parts[1])) {
      return [parts[0], parts[1]];
    }
  }
  return [fallback, fallback];
}

function randomizeStrategy(base) {
  const s = { ...(base || {}) };
  const tokenRange = parseRangeWithFallback(s.token_fetch_delay_range_ms, s.token_fetch_delay_ms || 45);
  const burstJitterRange = parseRangeWithFallback(s.burst_jitter_range_ms, 0);

  s.token_fetch_delay_ms = randIntInclusive(tokenRange[0], tokenRange[1]);

  const baseBurst = Array.isArray(s.burst_offsets_ms) ? s.burst_offsets_ms : [120, 420, 820];
  s.burst_offsets_ms = baseBurst.map(v => {
    const baseMs = parseInt(v, 10);
    if (Number.isNaN(baseMs)) return v;
    const jitter = randIntInclusive(burstJitterRange[0], burstJitterRange[1]);
    return Math.max(0, baseMs + jitter);
  });
  return s;
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

async function buildTodayDispatchUsers(KV, schoolId, school, today) {
  const userIds = await getSchoolUsers(KV, schoolId);
  const users = [];
  for (const userId of userIds) {
    const user = await getUser(KV, schoolId, userId);
    if (!user || user.status !== "active") continue;

    const daySchedule = user.schedule[today];
    if (!daySchedule || !daySchedule.enabled) continue;

    // 兼容旧数据（单配置）和新数据（slots数组）
    const rawSlots = daySchedule.slots
      ? daySchedule.slots
      : [{ roomid: daySchedule.roomid, seatid: daySchedule.seatid, times: daySchedule.times, seatPageId: daySchedule.seatPageId || "", fidEnc: daySchedule.fidEnc || "" }];
    const activeSlots = rawSlots.filter(s => s.times && s.roomid);
    if (activeSlots.length === 0) continue;

    users.push({
      username: user.phone || user.username,
      password: user.password,
      remark: user.remark || user.username || user.phone,
      nickname: user.username,
      slots: activeSlots.map(s => ({
        roomid: s.roomid,
        seatid: (s.seatid || "").split(",").map(x => x.trim()).filter(Boolean),
        times: s.times,
        seatPageId: s.seatPageId || "",
        fidEnc: school?.fidEnc || s.fidEnc || "",
      })),
    });
  }
  return users;
}

async function dispatchUsersInBatches(env, school, users) {
  const batches = chunkArray(users, BATCH_SIZE);
  let okBatches = 0;

  for (let i = 0; i < batches.length; i++) {
    const payload = {
      school_id: school.id,
      school_name: school.name,
      trigger_date: beijingDate(),
      batch_index: i + 1,
      batch_total: batches.length,
      users: batches[i].map(u => ({
        ...u,
        endtime: school.endtime,
        strategy: randomizeStrategy(school.strategy),
      })),
    };

    const ok = await dispatchGitHub(env.GH_TOKEN, school.repo, payload);
    if (ok) okBatches++;
    console.log(
      `Dispatch batch ${school.id} ${i + 1}/${batches.length}: ${ok ? "OK" : "FAIL"}`
    );
  }

  return { okBatches, totalBatches: batches.length };
}

function parseSeatIdsRaw(seatidRaw) {
  if (Array.isArray(seatidRaw)) {
    return seatidRaw.map(v => String(v || "").trim()).filter(Boolean);
  }
  return String(seatidRaw || "")
    .split(",")
    .map(v => v.trim())
    .filter(Boolean);
}

function normalizeTimesLabel(rawTimes) {
  if (Array.isArray(rawTimes) && rawTimes.length >= 2) {
    const start = String(rawTimes[0] || "").trim();
    const end = String(rawTimes[1] || "").trim();
    return start && end ? `${start}-${end}` : String(rawTimes || "").trim();
  }
  return String(rawTimes || "").trim();
}

function parseHmsToSeconds(hms) {
  const text = String(hms || "").trim();
  const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;

  const hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  const second = parseInt(match[3] || "0", 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    return null;
  }
  return hour * 3600 + minute * 60 + second;
}

function parseTimesRange(rawTimes) {
  const label = normalizeTimesLabel(rawTimes);
  const parts = label.split(/-|~|至/).map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) {
    return { label, startSec: null, endSec: null, valid: false };
  }

  const startSec = parseHmsToSeconds(parts[0]);
  const endSec = parseHmsToSeconds(parts[1]);
  if (startSec === null || endSec === null || endSec <= startSec) {
    return { label, startSec: null, endSec: null, valid: false };
  }
  return { label, startSec, endSec, valid: true };
}

function isTimeOverlapped(a, b) {
  if (a.valid && b.valid) {
    return a.startSec < b.endSec && b.startSec < a.endSec;
  }
  return a.label && b.label && a.label === b.label;
}

function collectScheduleSeatEntries(schedule) {
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const entries = [];

  for (const day of days) {
    const dayCfg = schedule && schedule[day];
    if (!dayCfg || !dayCfg.enabled) continue;

    const rawSlots = Array.isArray(dayCfg.slots)
      ? dayCfg.slots
      : [{
          roomid: dayCfg.roomid,
          seatid: dayCfg.seatid,
          times: dayCfg.times,
          seatPageId: dayCfg.seatPageId,
          fidEnc: dayCfg.fidEnc,
        }];

    for (const slot of rawSlots) {
      if (!slot || typeof slot !== "object") continue;
      const roomid = String(slot.roomid || "").trim();
      const seatList = parseSeatIdsRaw(slot.seatid);
      const times = parseTimesRange(slot.times);
      if (!roomid || !times.label || seatList.length === 0) continue;

      for (const seat of seatList) {
        entries.push({
          day,
          roomid,
          seat,
          times,
        });
      }
    }
  }

  return entries;
}

function dayNameZh(day) {
  const map = {
    Monday: "周一",
    Tuesday: "周二",
    Wednesday: "周三",
    Thursday: "周四",
    Friday: "周五",
    Saturday: "周六",
    Sunday: "周日",
  };
  return map[day] || day;
}

async function findSeatConflicts(KV, schoolId, schedule, excludeUserId = "") {
  const incomingEntries = collectScheduleSeatEntries(schedule);
  if (incomingEntries.length === 0) return [];

  const userIds = await getSchoolUsers(KV, schoolId);
  const existingByKey = new Map();

  for (const uid of userIds) {
    if (excludeUserId && uid === excludeUserId) continue;

    const existingUser = await getUser(KV, schoolId, uid);
    if (!existingUser) continue;

    const owner = existingUser.username || "(无昵称)";
    const existingEntries = collectScheduleSeatEntries(existingUser.schedule || {});
    for (const entry of existingEntries) {
      const key = `${entry.day}|${entry.roomid}|${entry.seat}`;
      const item = {
        ...entry,
        userId: uid,
        owner,
      };
      const arr = existingByKey.get(key) || [];
      arr.push(item);
      existingByKey.set(key, arr);
    }
  }

  const conflicts = [];
  for (const incoming of incomingEntries) {
    const key = `${incoming.day}|${incoming.roomid}|${incoming.seat}`;
    const occupied = existingByKey.get(key) || [];
    for (const existing of occupied) {
      // 只要同一天、同房间、同座位就算冲突，不判断时间段
      conflicts.push({
        day: incoming.day,
        roomid: incoming.roomid,
        seatid: incoming.seat,
        times: incoming.times.label,
        occupiedBy: existing.owner,
        occupiedUserId: existing.userId,
        occupiedTimes: existing.times.label,
      });
      break;
    }
  }

  return conflicts;
}

function buildSeatConflictError(conflicts) {
  if (!conflicts.length) return "";
  const preview = conflicts.slice(0, 3).map(c => (
    `${dayNameZh(c.day)} 房间${c.roomid} 座位${c.seatid} 时段${c.times} 已被用户“${c.occupiedBy}”占用`
  ));
  const suffix = conflicts.length > 3 ? `；另有 ${conflicts.length - 3} 条冲突` : "";
  return `⚠️ 检测到座位冲突：${preview.join("；")}${suffix}`;
}

// ─── Scheduled Handler ───

async function handleScheduled(env) {
  const now = beijingHHMM();
  const today = beijingDayOfWeek();
  const schoolIds = await getSchools(env.SEAT_KV);

  for (const schoolId of schoolIds) {
    const school = await getSchool(env.SEAT_KV, schoolId);
    if (!school || school.trigger_time !== now) continue;

    const users = await buildTodayDispatchUsers(env.SEAT_KV, schoolId, school, today);
    if (users.length === 0) continue;
    const result = await dispatchUsersInBatches(env, school, users);
    console.log(
      `Scheduled dispatch school ${school.id}: users=${users.length}, batches=${result.okBatches}/${result.totalBatches}`
    );
  }
}

// ─── API Handler ───

async function handleAPI(request, env, path) {
  const KV = env.SEAT_KV;
  const method = request.method;

  // GET /api/schools
  if (method === "GET" && path === "/api/schools") {
    const schoolIds = await getSchools(KV);
    const schools = [];
    for (const id of schoolIds) {
      const school = await getSchool(KV, id);
      if (school) {
        const userIds = await getSchoolUsers(KV, id);
        schools.push({ ...school, userCount: userIds.length });
      }
    }
    return jsonResp({ schools });
  }

  // POST /api/school
  if (method === "POST" && path === "/api/school") {
    const body = await request.json();
    const id = body.id || generateId();
    const name = body.name || `学校 ${id}`;
    const school = defaultSchool(id, name);
    if (body.repo) school.repo = body.repo;
    if (body.trigger_time) school.trigger_time = body.trigger_time;
    if (body.endtime) school.endtime = body.endtime;
    if (body.fidEnc !== undefined) school.fidEnc = body.fidEnc;
    await saveSchool(KV, school);
    const schools = await getSchools(KV);
    if (!schools.includes(id)) {
      schools.push(id);
      await saveSchools(KV, schools);
    }
    // 自动在 GitHub 创建仓库并从 hcd 复制代码
    let repoInit = null;
    if (school.repo && env.GH_TOKEN) {
      try {
        repoInit = await createAndInitRepo(school.repo, env.GH_TOKEN);
      } catch (e) {
        repoInit = { ok: false, error: e.message };
      }
    }
    return jsonResp({ ok: true, school, repoInit });
  }

  // GET /api/school/:id
  const schoolMatch = path.match(/^\/api\/school\/([^/]+)$/);
  if (method === "GET" && schoolMatch) {
    const school = await getSchool(KV, schoolMatch[1]);
    if (!school) return jsonResp({ error: "School not found" }, 404);
    const userIds = await getSchoolUsers(KV, schoolMatch[1]);
    return jsonResp({ school, userCount: userIds.length });
  }

  // PUT /api/school/:id
  if (method === "PUT" && schoolMatch) {
    const school = await getSchool(KV, schoolMatch[1]);
    if (!school) return jsonResp({ error: "School not found" }, 404);
    const body = await request.json();
    Object.assign(school, body, { id: school.id });
    await saveSchool(KV, school);
    return jsonResp({ ok: true, school });
  }

  // DELETE /api/school/:id
  if (method === "DELETE" && schoolMatch) {
    await deleteSchool(KV, schoolMatch[1]);
    return jsonResp({ ok: true });
  }

  // GET /api/school/:id/users
  const usersMatch = path.match(/^\/api\/school\/([^/]+)\/users$/);
  if (method === "GET" && usersMatch) {
    const schoolId = usersMatch[1];
    const userIds = await getSchoolUsers(KV, schoolId);
    const users = [];
    for (const uid of userIds) {
      const user = await getUser(KV, schoolId, uid);
      if (user) {
        const masked = { ...user, password: user.password ? "******" : "" };
        users.push(masked);
      }
    }
    return jsonResp({ users });
  }

  // POST /api/school/:id/user
  const userCreateMatch = path.match(/^\/api\/school\/([^/]+)\/user$/);
  if (method === "POST" && userCreateMatch) {
    const schoolId = userCreateMatch[1];
    const body = await request.json();
    const id = body.id || generateId();
    const user = defaultUser(id);
    user.phone = body.phone || "";
    user.username = body.username || "";
    user.password = body.password ? await aesEncrypt(body.password) : "";
    user.remark = body.remark || "";
    if (body.status === "active" || body.status === "paused") user.status = body.status;
    if (body.schedule) user.schedule = body.schedule;

    if (user.status === "active") {
      const conflicts = await findSeatConflicts(KV, schoolId, user.schedule || {}, "");
      if (conflicts.length > 0) {
        return jsonResp({
          error: buildSeatConflictError(conflicts),
          conflicts,
        }, 409);
      }
    }

    await saveUser(KV, schoolId, user);
    const userIds = await getSchoolUsers(KV, schoolId);
    if (!userIds.includes(id)) {
      userIds.push(id);
      await saveSchoolUsers(KV, schoolId, userIds);
    }
    return jsonResp({ ok: true, user: { ...user, password: "******" } });
  }

  // GET /api/school/:id/user/:userId
  const userMatch = path.match(/^\/api\/school\/([^/]+)\/user\/([^/]+)$/);
  if (method === "GET" && userMatch) {
    const user = await getUser(KV, userMatch[1], userMatch[2]);
    if (!user) return jsonResp({ error: "User not found" }, 404);
    return jsonResp({ user: { ...user, password: user.password ? "******" : "" } });
  }

  // PUT /api/school/:id/user/:userId
  if (method === "PUT" && userMatch) {
    const [_, schoolId, userId] = userMatch;
    const user = await getUser(KV, schoolId, userId);
    if (!user) return jsonResp({ error: "User not found" }, 404);
    const body = await request.json();

    const nextStatus = body.status !== undefined ? body.status : user.status;
    const nextSchedule = body.schedule ? body.schedule : (user.schedule || {});
    if (nextStatus === "active") {
      const conflicts = await findSeatConflicts(KV, schoolId, nextSchedule, userId);
      if (conflicts.length > 0) {
        return jsonResp({
          error: buildSeatConflictError(conflicts),
          conflicts,
        }, 409);
      }
    }

    if (body.phone !== undefined) user.phone = body.phone;
    if (body.username !== undefined) user.username = body.username;
    if (body.password && body.password !== "******") user.password = await aesEncrypt(body.password);
    if (body.remark !== undefined) user.remark = body.remark;
    if (body.status !== undefined) user.status = body.status;
    if (body.schedule) user.schedule = body.schedule;
    await saveUser(KV, schoolId, user);
    return jsonResp({ ok: true, user: { ...user, password: "******" } });
  }

  // DELETE /api/school/:id/user/:userId
  if (method === "DELETE" && userMatch) {
    await deleteUser(KV, userMatch[1], userMatch[2]);
    return jsonResp({ ok: true });
  }

  // POST /api/school/:id/user/:userId/pause
  const pauseMatch = path.match(/^\/api\/school\/([^/]+)\/user\/([^/]+)\/(pause|resume)$/);
  if (method === "POST" && pauseMatch) {
    const [_, schoolId, userId, action] = pauseMatch;
    const user = await getUser(KV, schoolId, userId);
    if (!user) return jsonResp({ error: "User not found" }, 404);
    user.status = action === "pause" ? "paused" : "active";
    await saveUser(KV, schoolId, user);
    return jsonResp({ ok: true, status: user.status });
  }

  // POST /api/trigger/:schoolId
  const triggerSchoolMatch = path.match(/^\/api\/trigger\/([^/]+)$/);
  if (method === "POST" && triggerSchoolMatch) {
    const schoolId = triggerSchoolMatch[1];
    const school = await getSchool(KV, schoolId);
    if (!school) return jsonResp({ error: "School not found" }, 404);
    const today = beijingDayOfWeek();
    const users = await buildTodayDispatchUsers(KV, schoolId, school, today);
    if (users.length === 0) {
      return jsonResp({ ok: true, triggeredUsers: 0, okBatches: 0, totalBatches: 0 });
    }
    const result = await dispatchUsersInBatches(env, school, users);
    return jsonResp({
      ok: true,
      triggeredUsers: users.length,
      okBatches: result.okBatches,
      totalBatches: result.totalBatches,
    });
  }

  // POST /api/trigger/:schoolId/:userId
  const triggerUserMatch = path.match(/^\/api\/trigger\/([^/]+)\/([^/]+)$/);
  if (method === "POST" && triggerUserMatch) {
    const [_, schoolId, userId] = triggerUserMatch;
    const school = await getSchool(KV, schoolId);
    const user = await getUser(KV, schoolId, userId);
    if (!school || !user) return jsonResp({ error: "Not found" }, 404);
    const today = beijingDayOfWeek();
    const daySchedule = user.schedule[today];
    if (!daySchedule || !daySchedule.enabled) {
      return jsonResp({ error: "User has no schedule for today" }, 400);
    }
    const rawSlots = daySchedule.slots
      ? daySchedule.slots
      : [{ roomid: daySchedule.roomid, seatid: daySchedule.seatid, times: daySchedule.times, seatPageId: daySchedule.seatPageId || "", fidEnc: daySchedule.fidEnc || "" }];
    const activeSlots = rawSlots.filter(s => s.times && s.roomid);
    if (activeSlots.length === 0) return jsonResp({ error: "No active slots for today" }, 400);
    const payload = {
      username: user.phone || user.username,
      password: user.password,
      remark: user.remark || user.username || user.phone,
      trigger_date: beijingDate(),
      slots: activeSlots.map(s => ({
        roomid: s.roomid,
        seatid: (s.seatid || "").split(",").map(x => x.trim()).filter(Boolean),
        times: s.times,
        seatPageId: s.seatPageId || "",
        fidEnc: school.fidEnc || s.fidEnc || "",
      })),
      endtime: school.endtime,
      strategy: randomizeStrategy(school.strategy),
    };
    const result = await dispatchGitHubVerbose(env.GH_TOKEN, school.repo, payload);
    if (!result.ok) {
      return jsonResp({
        ok: false,
        error: "GitHub dispatch failed",
        status: result.status,
        detail: result.detail,
        repo: school.repo,
      }, 502);
    }
    return jsonResp({ ok: true, slots: activeSlots.length, repo: school.repo });
  }

  // POST /api/encrypt
  if (method === "POST" && path === "/api/encrypt") {
    const body = await request.json();
    if (!body.password) return jsonResp({ error: "password required" }, 400);
    const encrypted = await aesEncrypt(body.password);
    return jsonResp({ encrypted });
  }

  // POST /api/init-demo (初始化演示数据)
  if (method === "POST" && path === "/api/init-demo") {
    const demoSchools = [
      { id: "001", name: "华东师范大学", repo: "BAOfuZhan/hcd" },
      { id: "002", name: "复旦大学", repo: "BAOfuZhan/fdu" },
      { id: "003", name: "上海交通大学", repo: "BAOfuZhan/sjtu" },
    ];
    const existingSchools = await getSchools(KV);
    for (const demo of demoSchools) {
      if (!existingSchools.includes(demo.id)) {
        const school = defaultSchool(demo.id, demo.name);
        school.repo = demo.repo;
        await saveSchool(KV, school);
        existingSchools.push(demo.id);
      }
    }
    await saveSchools(KV, existingSchools);
    return jsonResp({ ok: true, schools: existingSchools });
  }

  return jsonResp({ error: "Not found" }, 404);
}

// ─── Fetch Handler ───

async function handleFetch(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,X-API-Key",
      },
    });
  }

  // API 鉴权
  if (path.startsWith("/api/")) {
    const apiKey = request.headers.get("X-API-Key") || url.searchParams.get("key");
    if (apiKey !== env.API_KEY) {
      return jsonResp({ error: "Unauthorized" }, 401);
    }
    return handleAPI(request, env, path);
  }

  // 管理面板
  return new Response(ADMIN_HTML, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ─── 管理面板 HTML ───

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>统一抢座管理系统</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f0f2f5;min-height:100vh}
.container{max-width:1200px;margin:0 auto;padding:20px}
.header{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;padding:20px;border-radius:12px;margin-bottom:20px;display:flex;justify-content:space-between;align-items:center}
.header h1{font-size:24px}
.header .time{font-size:14px;opacity:0.9}
.login-box{max-width:400px;margin:100px auto;background:#fff;padding:40px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.1)}
.login-box h2{text-align:center;margin-bottom:30px;color:#333}
.login-box input{width:100%;padding:12px;border:1px solid #ddd;border-radius:8px;font-size:16px;margin-bottom:20px}
.login-box button{width:100%;padding:12px;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer}
.btn{padding:8px 16px;border:none;border-radius:6px;cursor:pointer;font-size:14px;transition:all 0.2s}
.btn-primary{background:#667eea;color:#fff}
.btn-primary:hover{background:#5a6fd6}
.btn-success{background:#52c41a;color:#fff}
.btn-danger{background:#ff4d4f;color:#fff}
.btn-secondary{background:#f0f0f0;color:#333}
.btn-sm{padding:4px 10px;font-size:12px}
.card{background:#fff;border-radius:12px;padding:20px;margin-bottom:16px;box-shadow:0 2px 8px rgba(0,0,0,0.06)}
.card-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid #f0f0f0}
.card-title{font-size:18px;font-weight:600;color:#333}
.school-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
.school-card{background:#fff;border-radius:12px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,0.06);cursor:pointer;transition:all 0.2s;border:2px solid transparent}
.school-card:hover{border-color:#667eea;transform:translateY(-2px)}
.school-card h3{font-size:18px;color:#333;margin-bottom:8px}
.school-card .meta{font-size:13px;color:#888;margin-bottom:12px}
.school-card .stats{display:flex;gap:16px;font-size:13px}
.school-card .stats span{color:#667eea}
.user-table{width:100%;border-collapse:collapse}
.user-table th,.user-table td{padding:12px;text-align:left;border-bottom:1px solid #f0f0f0}
.user-table th{background:#fafafa;font-weight:500;color:#666}
.user-table tr:hover{background:#fafafa}
.status-active{color:#52c41a}
.status-paused{color:#faad14}
.modal{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:1000;overflow-y:auto}
.modal.show{display:flex;align-items:flex-start;justify-content:center;padding:40px 20px}
.modal-content{background:#fff;border-radius:12px;width:100%;max-width:800px;max-height:90vh;overflow-y:auto}
.modal-header{padding:20px;border-bottom:1px solid #f0f0f0;display:flex;justify-content:space-between;align-items:center}
.modal-header h3{font-size:18px}
.modal-close{font-size:24px;cursor:pointer;color:#999}
.modal-body{padding:20px}
.form-group{margin-bottom:16px}
.form-group label{display:block;margin-bottom:6px;font-weight:500;color:#333}
.form-group input,.form-group select,.form-group textarea{width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;font-size:14px}
.form-row{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}
.schedule-grid{display:grid;gap:12px}
.schedule-day{background:#fafafa;border-radius:8px;padding:12px}
.schedule-day-header{display:flex;align-items:center;gap:12px;margin-bottom:8px}
.schedule-day-header input[type="checkbox"]{width:18px;height:18px}
.schedule-day-header label{font-weight:500}
.schedule-day-fields{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.schedule-day-fields input{padding:6px;font-size:12px}
.slot-row{border-top:1px solid #e8e8e8;padding-top:8px;margin-top:8px}
.slot-label{font-size:11px;color:#888;margin-bottom:4px}
.toast{position:fixed;top:20px;right:20px;padding:12px 20px;border-radius:8px;color:#fff;z-index:2000;animation:slideIn 0.3s}
.toast-success{background:#52c41a}
.toast-error{background:#ff4d4f}
@keyframes slideIn{from{transform:translateX(100%);opacity:0}to{transform:translateX(0);opacity:1}}
.breadcrumb{display:flex;align-items:center;gap:8px;margin-bottom:20px;font-size:14px;color:#666}
.breadcrumb a{color:#667eea;text-decoration:none}
.breadcrumb a:hover{text-decoration:underline}
.empty{text-align:center;padding:60px;color:#999}
.empty-icon{font-size:48px;margin-bottom:16px}
.actions{display:flex;gap:8px}
.zone-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.zone-card{background:#fafafa;border:1px solid #ececec;border-radius:10px;padding:12px}
.zone-floor{font-size:13px;font-weight:600;color:#333;margin-bottom:8px}
.zone-list{display:grid;gap:6px}
.zone-item{display:flex;justify-content:space-between;align-items:center;font-size:13px;color:#555;padding:6px 8px;background:#fff;border-radius:6px}
.zone-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#667eea;background:#eef1ff;padding:2px 6px;border-radius:999px}
.zone-right{display:flex;align-items:center;gap:6px}
.copy-btn{border:none;background:#f0f2f7;color:#4b5563;border-radius:6px;padding:2px 8px;font-size:12px;cursor:pointer}
.copy-btn:hover{background:#e5e9f3}
</style>
</head>
<body>
<div id="app"></div>
<script>
const API_BASE = "";
let API_KEY = localStorage.getItem("api_key") || "";
let currentView = "login";
let currentSchool = null;
let schools = [];
let users = [];
const DEFAULT_READING_ZONE_GROUPS = [
  { floor: "2 楼", zones: [{ id: "13474", name: "西阅览区" }, { id: "13473", name: "东阅览区" }, { id: "13476", name: "西电子阅览区" }, { id: "13472", name: "东电子阅览区" }] },
  { floor: "3 楼", zones: [{ id: "13481", name: "西阅览区" }, { id: "13484", name: "中阅览区" }, { id: "13478", name: "东阅览区" }, { id: "13480", name: "西电子阅览区" }, { id: "13475", name: "东电子阅览区" }] },
  { floor: "4 楼", zones: [{ id: "13487", name: "西阅览区" }, { id: "13490", name: "中阅览区" }, { id: "13489", name: "东阅览区" }, { id: "13485", name: "西电子阅览区" }, { id: "13486", name: "东电子阅览区" }, { id: "13492", name: "南区" }] },
  { floor: "5 楼", zones: [{ id: "13493", name: "西阅览区" }, { id: "13497", name: "中阅览区" }, { id: "13494", name: "东阅览区" }] },
  { floor: "6 楼", zones: [{ id: "13499", name: "西阅览区" }, { id: "13500", name: "中阅览区" }, { id: "13502", name: "东阅览区" }, { id: "13505", name: "北阅览区" }] },
  { floor: "7 楼", zones: [{ id: "13504", name: "西阅览区" }, { id: "13506", name: "中阅览区" }, { id: "13507", name: "东阅览区" }] },
  { floor: "8 楼", zones: [{ id: "13495", name: "西阅览区" }, { id: "13496", name: "中阅览室" }, { id: "13498", name: "东阅览区" }, { id: "13501", name: "电子西阅览区" }, { id: "13503", name: "电子东阅览区" }] },
  { floor: "9 楼", zones: [{ id: "13491", name: "西阅览室" }, { id: "13488", name: "中阅览区" }, { id: "13483", name: "东阅览区" }] },
];

function getReadingZoneGroups() {
  const groups = currentSchool && Array.isArray(currentSchool.reading_zone_groups)
    ? currentSchool.reading_zone_groups
    : [];
  const normalized = normalizeReadingZoneGroups(groups);
  return normalized.length ? normalized : DEFAULT_READING_ZONE_GROUPS;
}

function normalizeReadingZoneGroups(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];

  const normalizedGroups = [];
  const flatZones = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;

    // 结构1: [{ floor, zones: [{id,name}] }]
    if (Array.isArray(item.zones)) {
      const floor = String(item.floor || "未分层").trim() || "未分层";
      const zones = item.zones
        .map((z) => {
          if (!z || typeof z !== "object") return null;
          const id = String(z.id || z.roomid || "").trim();
          if (!id) return null;
          const name = String(z.name || z.roomName || z.title || id).trim() || id;
          return { id, name };
        })
        .filter(Boolean);

      if (zones.length) normalizedGroups.push({ floor, zones });
      continue;
    }

    // 结构2: [{ roomid, name, ... }] （extract_room_ids.py --json 输出）
    const id = String(item.roomid || item.id || "").trim();
    if (id) {
      const name = String(item.name || item.roomName || id).trim() || id;
      flatZones.push({ id, name });
    }
  }

  if (flatZones.length) normalizedGroups.push({ floor: "未分层", zones: flatZones });
  return normalizedGroups;
}

function _emptySlot() {
  return { roomid: "", seatid: "", times: "", seatPageId: "", fidEnc: "" };
}

function createEmptyWeeklySchedule() {
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const schedule = {};
  for (const d of days) {
    schedule[d] = { enabled: false, slots: [_emptySlot(), _emptySlot(), _emptySlot()] };
  }
  return schedule;
}

function parseScheduleJsonMapping(rawText) {
  const parsed = JSON.parse(rawText);
  const items = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === "object" ? [parsed] : []);
  if (!items.length) {
    throw new Error("周计划 JSON 必须是对象或数组");
  }

  const schedule = createEmptyWeeklySchedule();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;

    const roomid = String(item.roomid || "").trim();
    const seatPageId = String(item.seatPageId || item.roomid || "").trim();
    const fidEnc = String(item.fidEnc || "").trim();

    let times = item.times;
    if (Array.isArray(times) && times.length >= 2) {
      times = String(times[0]).trim() + "-" + String(times[1]).trim();
    } else {
      times = String(times || "").trim();
    }

    let seatid = item.seatid;
    if (Array.isArray(seatid)) {
      seatid = seatid.map(v => String(v).trim()).filter(Boolean).join(",");
    } else {
      seatid = String(seatid || "").trim();
    }

    const daysofweek = Array.isArray(item.daysofweek) ? item.daysofweek : [];
    for (const day of daysofweek) {
      if (!schedule[day]) continue;
      schedule[day].enabled = true;
      schedule[day].slots.push({ roomid, seatid, times, seatPageId, fidEnc });
    }
  }

  for (const day of Object.keys(schedule)) {
    const slots = (schedule[day].slots || []).filter(s => s && (s.roomid || s.times));
    if (slots.length === 0) {
      schedule[day].enabled = false;
      schedule[day].slots = [_emptySlot(), _emptySlot(), _emptySlot()];
      continue;
    }
    // UI 仍显示 3 行，超出部分不会在表单中展示，但后端可保存全部。
    schedule[day].slots = slots;
  }

  return schedule;
}

function scheduleToJsonMapping(schedule) {
  const result = [];
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  for (const day of days) {
    const dayCfg = schedule?.[day];
    if (!dayCfg || !dayCfg.enabled) continue;
    const slots = Array.isArray(dayCfg.slots)
      ? dayCfg.slots
      : [{ roomid: dayCfg.roomid, seatid: dayCfg.seatid, times: dayCfg.times, seatPageId: dayCfg.seatPageId, fidEnc: dayCfg.fidEnc }];
    for (const s of slots) {
      if (!s || !s.roomid || !s.times) continue;
      let times = s.times;
      if (typeof times === "string") {
        const p = times.split(/-|~|至/).map(x => x.trim()).filter(Boolean);
        times = p.length >= 2 ? [p[0], p[1]] : [times, ""];
      }
      const seatid = String(s.seatid || "").split(",").map(x => x.trim()).filter(Boolean);
      result.push({
        times,
        roomid: String(s.roomid || ""),
        seatid,
        seatPageId: String(s.seatPageId || s.roomid || ""),
        fidEnc: String(s.fidEnc || ""),
        daysofweek: [day],
      });
    }
  }
  return result;
}

function fillScheduleFormFromSchedule(schedule) {
  const days = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
  days.forEach(d => {
    const sch = schedule?.[d] || {};
    document.getElementById("sch_" + d + "_enabled").checked = !!sch.enabled;
    const slots = sch.slots || [{ roomid: sch.roomid, seatid: sch.seatid, times: sch.times, seatPageId: sch.seatPageId, fidEnc: sch.fidEnc }];
    const visibleCount = Math.max(1, Math.min(3, slots.filter(Boolean).length || 1));
    setVisibleSlotsForDay(d, visibleCount);
    [0,1,2].forEach(i => {
      const s = slots[i] || {};
      document.getElementById("sch_" + d + "_s" + i + "_roomid").value = s.roomid || "";
      document.getElementById("sch_" + d + "_s" + i + "_seatid").value = s.seatid || "";
      document.getElementById("sch_" + d + "_s" + i + "_times").value = s.times || "";
      document.getElementById("sch_" + d + "_s" + i + "_seatPageId").value = s.seatPageId || "";
      document.getElementById("sch_" + d + "_s" + i + "_fidEnc").value = s.fidEnc || "";
    });
  });
}

function setVisibleSlotsForDay(day, count) {
  const visibleCount = Math.max(1, Math.min(3, parseInt(count, 10) || 1));
  [0,1,2].forEach(i => {
    const row = document.getElementById("sch_" + day + "_row_" + i);
    if (!row) return;
    row.style.display = i < visibleCount ? "" : "none";
  });
}

function getVisibleSlotsForDay(day) {
  let count = 0;
  [0,1,2].forEach(i => {
    const row = document.getElementById("sch_" + day + "_row_" + i);
    if (row && row.style.display !== "none") count++;
  });
  return Math.max(1, count);
}

function addSlotForDay(day) {
  const current = getVisibleSlotsForDay(day);
  setVisibleSlotsForDay(day, current + 1);
}

function applyScheduleJsonToForm() {
  const scheduleJsonText = (document.getElementById("edit_user_schedule_json").value || "").trim();
  if (!scheduleJsonText) return toast("请先粘贴周计划 JSON", "error");
  try {
    const schedule = parseScheduleJsonMapping(scheduleJsonText);
    fillScheduleFormFromSchedule(schedule);
    toast("已映射到周计划配置");
  } catch (e) {
    toast("周计划 JSON 解析失败: " + (e.message || String(e)), "error");
  }
}

async function api(method, path, body = null) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
  };
  if (body) opts.body = JSON.stringify(body);
  let res;
  try {
    res = await fetch(API_BASE + path, opts);
  } catch (e) {
    return { ok: false, error: "网络请求失败", detail: e.message || String(e), status: 0 };
  }

  const raw = await res.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (_e) {
    data = { ok: res.ok };
    if (!res.ok) {
      data.error = "HTTP " + res.status;
      data.detail = raw;
    }
  }

  if (!data || typeof data !== "object") data = { ok: res.ok };
  if (data.status === undefined) data.status = res.status;
  if (!res.ok && !data.error) data.error = "HTTP " + res.status;
  return data;
}

function toast(msg, type = "success") {
  const t = document.createElement("div");
  t.className = "toast toast-" + type;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

async function copyRoomId(id) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(id);
    } else {
      const input = document.createElement("input");
      input.value = id;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    toast("已复制 ID: " + id);
  } catch (e) {
    toast("复制失败，请手动复制", "error");
  }
}

function render() {
  const app = document.getElementById("app");
  if (currentView === "login") {
    app.innerHTML = renderLogin();
  } else if (currentView === "schools") {
    app.innerHTML = renderSchools();
  } else if (currentView === "school") {
    app.innerHTML = renderSchoolDetail();
  }
  bindEvents();
}

function renderLogin() {
  return \`
    <div class="login-box">
      <h2>统一抢座管理系统</h2>
      <input type="password" id="apiKey" placeholder="请输入管理密钥">
      <button onclick="doLogin()">登 录</button>
    </div>
  \`;
}

function renderSchools() {
  const now = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  return \`
    <div class="container">
      <div class="header">
        <h1>统一抢座管理系统</h1>
        <div class="time">\${now}</div>
      </div>
      <div class="card">
        <div class="card-header">
          <span class="card-title">学校列表</span>
          <button class="btn btn-primary" onclick="showAddSchool()">+ 添加学校</button>
        </div>
        <div class="school-grid">
          \${schools.length ? schools.map(s => \`
            <div class="school-card" onclick="openSchool('\${s.id}')">
              <h3>\${s.name}</h3>
              <div class="meta">ID: \${s.id} | 仓库: \${s.repo}</div>
              <div class="stats">
                <span>\${s.userCount || 0} 名用户</span>
                <span>触发时间: \${s.trigger_time}</span>
              </div>
            </div>
          \`).join("") : '<div class="empty"><div class="empty-icon">📚</div><p>暂无学校，点击上方按钮添加</p></div>'}
        </div>
      </div>
    </div>
    \${renderAddSchoolModal()}
  \`;
}

function renderAddSchoolModal() {
  return \`
    <div class="modal" id="addSchoolModal">
      <div class="modal-content">
        <div class="modal-header">
          <h3>添加学校</h3>
          <span class="modal-close" onclick="closeModal('addSchoolModal')">&times;</span>
        </div>
        <div class="modal-body">
          <div class="form-row">
            <div class="form-group">
              <label>学校 ID（如 001）</label>
              <input type="text" id="new_school_id" placeholder="001">
            </div>
            <div class="form-group">
              <label>学校名称</label>
              <input type="text" id="new_school_name" placeholder="华东师范大学">
            </div>
          </div>
          <div class="form-group">
            <label>GitHub 仓库</label>
            <input type="text" id="new_school_repo" placeholder="BAOfuZhan/hcd">
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>触发时间</label>
              <input type="text" id="new_school_trigger" value="19:57" placeholder="HH:MM">
            </div>
            <div class="form-group">
              <label>截止时间</label>
              <input type="text" id="new_school_endtime" value="20:00:40" placeholder="HH:MM:SS">
            </div>
          </div>
          <div class="form-group">
            <label>学校统一 fidEnc（全校共用）</label>
            <input type="text" id="new_school_fidEnc" placeholder="例如: 1b001674cae092c3">
          </div>
          <button class="btn btn-primary" onclick="doAddSchool()" style="width:100%;margin-top:10px">创建学校</button>
        </div>
      </div>
    </div>
  \`;
}

function renderSchoolDetail() {
  const s = currentSchool;
  if (!s) return "";
  return \`
    <div class="container">
      <div class="header">
        <h1>\${s.name}</h1>
        <div class="actions">
          <button class="btn btn-secondary" onclick="backToSchools()">返回列表</button>
          <button class="btn btn-primary" onclick="showEditSchool()">编辑配置</button>
          <button class="btn btn-success" onclick="triggerSchool()">手动触发</button>
        </div>
      </div>
      <div class="breadcrumb">
        <a href="#" onclick="backToSchools();return false">学校列表</a>
        <span>></span>
        <span>\${s.name}</span>
      </div>
      <div class="card">
        <div class="card-header">
          <span class="card-title">学校配置</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:16px;font-size:14px">
          <div><strong>学校ID:</strong> \${s.id}</div>
          <div><strong>触发时间:</strong> \${s.trigger_time}</div>
          <div><strong>截止时间:</strong> \${s.endtime}</div>
          <div><strong>GitHub仓库:</strong> \${s.repo}</div>
          <div><strong>学校 fidEnc:</strong> \${s.fidEnc || "-"}</div>
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <span class="card-title">用户管理</span>
          <button class="btn btn-primary" onclick="showAddUser()">+ 添加用户</button>
        </div>
        \${users.length ? \`
          <table class="user-table">
            <thead>
              <tr>
                <th>手机号（账号）</th>
                <th>昵称</th>
                <th>状态</th>
                <th>今日计划</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              \${users.slice().sort((a, b) => {
                const na = (a.username || a.remark || "").toLowerCase();
                const nb = (b.username || b.remark || "").toLowerCase();
                return na.localeCompare(nb);
              }).map(u => {
                const today = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][new Date().getDay()];
                const todaySch = u.schedule[today];
                const todayStr = (() => {
                  if (!todaySch || !todaySch.enabled) return "无";
                  const slots = todaySch.slots || [{ roomid: todaySch.roomid, times: todaySch.times }];
                  const active = slots.filter(s => s.times && s.roomid);
                  if (active.length === 0) return "已启用/无有效时段";
                  return active.map(s => s.times).join(" | ");
                })();
                return \`
                  <tr>
                    <td>\${u.phone || "-"}</td>
                    <td>\${u.username || u.remark || "-"}</td>
                    <td class="status-\${u.status}">\${u.status === "active" ? "活跃" : "暂停"}</td>
                    <td style="font-size:12px">\${todayStr}</td>
                    <td class="actions">
                      <button class="btn btn-sm btn-secondary" onclick="showEditUser('\${u.id}')">编辑</button>
                      \${u.status === "active" 
                        ? \`<button class="btn btn-sm btn-danger" onclick="pauseUser('\${u.id}')">暂停</button>\`
                        : \`<button class="btn btn-sm btn-success" onclick="resumeUser('\${u.id}')">恢复</button>\`}
                      <button class="btn btn-sm btn-primary" onclick="triggerUser('\${u.id}')">触发</button>
                      <button class="btn btn-sm btn-danger" onclick="deleteUser('\${u.id}')">删除</button>
                    </td>
                  </tr>
                \`;
              }).join("")}
            </tbody>
          </table>
        \` : '<div class="empty"><div class="empty-icon">👤</div><p>暂无用户，点击上方按钮添加</p></div>'}
      </div>
      <div class="card">
        <div class="card-header">
          <span class="card-title">阅览区 ID 速查</span>
        </div>
        \${renderReadingZonePanel()}
      </div>
    </div>
    \${renderEditSchoolModal()}
    \${renderUserModal()}
  \`;
}

function renderReadingZonePanel() {
  const groups = getReadingZoneGroups();
  return \`
    <div class="zone-grid">
      \${groups.map(group => \`
        <div class="zone-card">
          <div class="zone-floor">\${group.floor}</div>
          <div class="zone-list">
            \${group.zones.map(z => \`
              <div class="zone-item">
                <span>\${z.name}</span>
                <div class="zone-right">
                  <span class="zone-id">\${z.id}</span>
                  <button class="copy-btn" onclick="copyRoomId('\${z.id}')">复制</button>
                </div>
              </div>
            \`).join("")}
          </div>
        </div>
      \`).join("")}
    </div>
  \`;
}

function renderEditSchoolModal() {
  const s = currentSchool || {};
  const st = s.strategy || {};
  const readingZonesText = JSON.stringify(s.reading_zone_groups || [], null, 2)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return \`
    <div class="modal" id="editSchoolModal">
      <div class="modal-content">
        <div class="modal-header">
          <h3>编辑学校配置</h3>
          <span class="modal-close" onclick="closeModal('editSchoolModal')">&times;</span>
        </div>
        <div class="modal-body">
          <div class="form-row">
            <div class="form-group">
              <label>学校名称</label>
              <input type="text" id="edit_school_name" value="\${s.name || ''}">
            </div>
            <div class="form-group">
              <label>GitHub 仓库</label>
              <input type="text" id="edit_school_repo" value="\${s.repo || ''}">
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>触发时间 (HH:MM)</label>
              <input type="text" id="edit_school_trigger" value="\${s.trigger_time || '19:57'}">
            </div>
            <div class="form-group">
              <label>截止时间 (HH:MM:SS)</label>
              <input type="text" id="edit_school_endtime" value="\${s.endtime || '20:00:40'}">
            </div>
          </div>
          <div class="form-group">
            <label>学校统一 fidEnc（全校共用）</label>
            <input type="text" id="edit_school_fidEnc" value="\${s.fidEnc || ''}" placeholder="例如: 1b001674cae092c3">
          </div>
          <div class="form-group">
            <label>阅览区映射 JSON（reading_zone_groups）</label>
            <textarea id="edit_school_reading_zones" rows="8" placeholder='示例: [{"floor":"3楼","zones":[{"id":"13484","name":"中阅览区"}]}]'>\${readingZonesText}</textarea>
          </div>
          <h4 style="margin:20px 0 12px">策略配置</h4>
          <div class="form-row">
            <div class="form-group">
              <label>策略模式（mode）</label>
              <select id="edit_strategy_mode">
                <option value="A" \${st.mode==="A"?"selected":""}>A - 预取token</option>
                <option value="B" \${st.mode==="B"?"selected":""}>B - 即时取token</option>
                <option value="C" \${st.mode==="C"?"selected":""}>C - 延迟取token</option>
              </select>
            </div>
            <div class="form-group">
              <label>提交并发方式（submit_mode）</label>
              <select id="edit_strategy_submit">
                <option value="serial" \${st.submit_mode==="serial"?"selected":""}>serial - 串行</option>
                <option value="burst" \${st.submit_mode==="burst"?"selected":""}>burst - 并行</option>
              </select>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>提前登录秒数（login_lead_seconds）</label>
              <input type="number" id="edit_strategy_login" value="\${st.login_lead_seconds || 14}">
            </div>
            <div class="form-group">
              <label>提前滑块秒数（slider_lead_seconds）</label>
              <input type="number" id="edit_strategy_slider" value="\${st.slider_lead_seconds || 10}">
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>首枪偏移毫秒（first_submit_offset_ms）</label>
              <input type="number" id="edit_strategy_first" value="\${st.first_submit_offset_ms || 9}">
            </div>
            <div class="form-group">
              <label>取 token 延迟毫秒（token_fetch_delay_ms）</label>
              <input type="number" id="edit_strategy_delay" value="\${st.token_fetch_delay_ms || 45}">
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>预取 token 提前毫秒（pre_fetch_token_ms）</label>
              <input type="number" id="edit_strategy_prefetch" value="\${st.pre_fetch_token_ms || 1531}">
            </div>
            <div class="form-group">
              <label>第二枪目标偏移毫秒（target_offset2_ms）</label>
              <input type="number" id="edit_strategy_target2" value="\${st.target_offset2_ms || 24}">
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>第三枪目标偏移毫秒（target_offset3_ms）</label>
              <input type="number" id="edit_strategy_target3" value="\${st.target_offset3_ms || 140}">
            </div>
            <div class="form-group">
              <label>并发连发偏移毫秒列表（burst_offsets_ms）</label>
              <input type="text" id="edit_strategy_burst" value="\${(st.burst_offsets_ms || [120,420,820]).join(',')}" placeholder="例如: 120,420,820">
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>取 token 随机范围（token_fetch_delay_range_ms）</label>
              <input type="text" id="edit_strategy_delay_range" value="\${(st.token_fetch_delay_range_ms || [st.token_fetch_delay_ms || 45, st.token_fetch_delay_ms || 45]).join(',')}" placeholder="例如: 20,80">
            </div>
            <div class="form-group">
              <label>burst_offsets_ms 抖动范围（burst_jitter_range_ms）</label>
              <input type="text" id="edit_strategy_burst_jitter" value="\${(st.burst_jitter_range_ms || [0,0]).join(',')}" placeholder="例如: -30,30（会加到每个 burst 偏移）">
            </div>
          </div>
          <div style="font-size:12px;color:#666;margin-top:6px">
            说明：仅 token_fetch_delay_ms 与 burst_offsets_ms 支持范围随机；其余偏移使用固定值。
          </div>
          <button class="btn btn-primary" onclick="doEditSchool()" style="width:100%;margin-top:16px">保存配置</button>
          <button class="btn btn-danger" onclick="doDeleteSchool()" style="width:100%;margin-top:8px">删除学校</button>
        </div>
      </div>
    </div>
  \`;
}

function renderUserModal() {
  const days = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
  const dayNames = {"Monday":"周一","Tuesday":"周二","Wednesday":"周三","Thursday":"周四","Friday":"周五","Saturday":"周六","Sunday":"周日"};
  return \`
    <div class="modal" id="userModal">
      <div class="modal-content">
        <div class="modal-header">
          <h3 id="userModalTitle">添加用户</h3>
          <span class="modal-close" onclick="closeModal('userModal')">&times;</span>
        </div>
        <div class="modal-body">
          <input type="hidden" id="edit_user_id">
          <div class="form-row">
            <div class="form-group">
              <label>手机号（登录账号）</label>
              <input type="text" id="edit_user_phone" placeholder="超星登录手机号">
            </div>
            <div class="form-group">
              <label>密码（留空不修改）</label>
              <input type="password" id="edit_user_password">
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>昵称（便于识别）</label>
              <input type="text" id="edit_user_username" placeholder="如：张三">
            </div>
            <div class="form-group">
              <label>备注</label>
              <input type="text" id="edit_user_remark" placeholder="其他备注">
            </div>
          </div>
          <h4 style="margin:20px 0 12px">周计划配置</h4>
          <div class="schedule-grid">
            \${days.map(d => \`
              <div class="schedule-day">
                <div class="schedule-day-header">
                  <input type="checkbox" id="sch_\${d}_enabled">
                  <label>\${dayNames[d]}</label>
                </div>
                \${[0,1,2].map(i => \`
                  <div class="slot-row" id="sch_\${d}_row_\${i}" style="\${i > 0 ? 'display:none;' : ''}">
                    <div class="slot-label">时段\${i+1}</div>
                    <div class="schedule-day-fields">
                      <input type="text" id="sch_\${d}_s\${i}_roomid" placeholder="房间ID">
                      <input type="text" id="sch_\${d}_s\${i}_seatid" placeholder="座位号(逗号分隔)">
                      <input type="text" id="sch_\${d}_s\${i}_times" placeholder="09:00-22:00">
                    </div>
                    <div class="schedule-day-fields" style="margin-top:4px">
                      <input type="text" id="sch_\${d}_s\${i}_seatPageId" placeholder="seatPageId">
                      <input type="text" id="sch_\${d}_s\${i}_fidEnc" placeholder="fidEnc">
                      <span></span>
                    </div>
                  </div>
                \`).join("")}
                <button type="button" class="btn btn-sm btn-secondary" onclick="addSlotForDay('\${d}')">+ 添加时段</button>
              </div>
            \`).join("")}
          </div>
          <div class="form-group" style="margin-top:12px">
            <label>周计划 JSON 映射（单一输入框）</label>
            <textarea id="edit_user_schedule_json" rows="8" placeholder='示例: [{"times":["09:00","23:00"],"roomid":"13484","seatid":["356"],"seatPageId":"13484","fidEnc":"4a18e12602b24c8c","daysofweek":["Monday","Tuesday"]}]'></textarea>
            <button type="button" class="btn btn-secondary" onclick="applyScheduleJsonToForm()" style="margin-top:8px">映射到周计划配置</button>
          </div>
          <button class="btn btn-primary" onclick="doSaveUser()" style="width:100%;margin-top:16px">保存用户</button>
        </div>
      </div>
    </div>
  \`;
}

function bindEvents() {}

async function doLogin() {
  const key = document.getElementById("apiKey").value;
  if (!key) return toast("请输入密钥", "error");
  API_KEY = key;
  const res = await api("GET", "/api/schools");
  if (res.error) {
    toast("密钥错误", "error");
    return;
  }
  localStorage.setItem("api_key", key);
  schools = res.schools || [];
  currentView = "schools";
  render();
}

async function loadSchools() {
  const res = await api("GET", "/api/schools");
  schools = res.schools || [];
  render();
}

function showAddSchool() {
  document.getElementById("addSchoolModal").classList.add("show");
}

function closeModal(id) {
  document.getElementById(id).classList.remove("show");
}

async function doAddSchool() {
  const id = document.getElementById("new_school_id").value.trim();
  const name = document.getElementById("new_school_name").value.trim();
  const repo = document.getElementById("new_school_repo").value.trim();
  const trigger_time = document.getElementById("new_school_trigger").value.trim();
  const endtime = document.getElementById("new_school_endtime").value.trim();
  const fidEnc = document.getElementById("new_school_fidEnc").value.trim();
  if (!id || !name) return toast("请填写必要信息", "error");
  const res = await api("POST", "/api/school", { id, name, repo, trigger_time, endtime, fidEnc });
  if (res.ok) {
    let msg = "学校添加成功";
    if (res.repoInit) {
      if (res.repoInit.skipped) {
        msg += "（仓库已是源仓库，跳过初始化）";
      } else if (res.repoInit.ok) {
        msg += "，已创建仓库并复制 " + res.repoInit.files + " 个文件";
      } else {
        msg += "，但仓库初始化失败: " + res.repoInit.error;
      }
    }
    toast(msg);
    closeModal("addSchoolModal");
    loadSchools();
  } else {
    toast(res.error || "添加失败", "error");
  }
}

async function openSchool(id) {
  const res = await api("GET", "/api/school/" + id);
  if (res.error) return toast(res.error, "error");
  currentSchool = res.school;
  const usersRes = await api("GET", "/api/school/" + id + "/users");
  users = usersRes.users || [];
  currentView = "school";
  render();
}

function backToSchools() {
  currentSchool = null;
  users = [];
  currentView = "schools";
  loadSchools();
}

function showEditSchool() {
  document.getElementById("editSchoolModal").classList.add("show");
}

async function doEditSchool() {
  const s = currentSchool;
  const burstOffsetsText = document.getElementById("edit_strategy_burst").value;
  const burstOffsets = burstOffsetsText
    .split(",")
    .map(v => parseInt(v.trim(), 10))
    .filter(v => !Number.isNaN(v));
  const parseRangeInput = (id, fallbackA, fallbackB) => {
    const text = (document.getElementById(id).value || "").trim();
    const arr = text.split(",").map(v => parseInt(v.trim(), 10)).filter(v => !Number.isNaN(v));
    if (arr.length >= 2) return [arr[0], arr[1]];
    return [fallbackA, fallbackB];
  };
  const delayRange = parseRangeInput("edit_strategy_delay_range", 45, 45);
  const burstJitterRange = parseRangeInput("edit_strategy_burst_jitter", 0, 0);
  const readingZonesRaw = (document.getElementById("edit_school_reading_zones").value || "").trim();
  let readingZoneGroups = [];
  if (readingZonesRaw) {
    try {
      const parsed = JSON.parse(readingZonesRaw);
      if (!Array.isArray(parsed)) return toast("阅览区映射 JSON 必须是数组", "error");
      const normalized = normalizeReadingZoneGroups(parsed);
      if (!normalized.length) {
        return toast("阅览区映射 JSON 结构无效：请使用 floor/zones 或 roomid 列表", "error");
      }
      readingZoneGroups = normalized;
    } catch (e) {
      return toast("阅览区映射 JSON 解析失败: " + (e.message || String(e)), "error");
    }
  }
  const body = {
    name: document.getElementById("edit_school_name").value.trim(),
    repo: document.getElementById("edit_school_repo").value.trim(),
    trigger_time: document.getElementById("edit_school_trigger").value.trim(),
    endtime: document.getElementById("edit_school_endtime").value.trim(),
    fidEnc: document.getElementById("edit_school_fidEnc").value.trim(),
    reading_zone_groups: readingZoneGroups,
    strategy: {
      ...s.strategy,
      mode: document.getElementById("edit_strategy_mode").value,
      submit_mode: document.getElementById("edit_strategy_submit").value,
      login_lead_seconds: parseInt(document.getElementById("edit_strategy_login").value) || 14,
      slider_lead_seconds: parseInt(document.getElementById("edit_strategy_slider").value) || 10,
      pre_fetch_token_ms: parseInt(document.getElementById("edit_strategy_prefetch").value) || 1531,
      first_submit_offset_ms: parseInt(document.getElementById("edit_strategy_first").value) || 9,
      target_offset2_ms: parseInt(document.getElementById("edit_strategy_target2").value) || 24,
      target_offset3_ms: parseInt(document.getElementById("edit_strategy_target3").value) || 140,
      token_fetch_delay_ms: parseInt(document.getElementById("edit_strategy_delay").value) || 45,
      token_fetch_delay_range_ms: delayRange,
      burst_offsets_ms: burstOffsets.length ? burstOffsets : [120, 420, 820],
      burst_jitter_range_ms: burstJitterRange,
    }
  };
  const res = await api("PUT", "/api/school/" + s.id, body);
  if (res.ok) {
    toast("配置已保存");
    currentSchool = res.school;
    closeModal("editSchoolModal");
    render();
  } else {
    toast(res.error || "保存失败", "error");
  }
}

async function doDeleteSchool() {
  if (!confirm("确定删除此学校及其所有用户？")) return;
  const res = await api("DELETE", "/api/school/" + currentSchool.id);
  if (res.ok) {
    toast("学校已删除");
    backToSchools();
  } else {
    toast(res.error || "删除失败", "error");
  }
}

async function triggerSchool() {
  if (!confirm("确定手动触发该学校所有活跃用户？")) return;
  const res = await api("POST", "/api/trigger/" + currentSchool.id);
  if (res.ok) {
    toast("已触发 " + (res.triggeredUsers || 0) + " 名用户，批次 " + (res.okBatches || 0) + "/" + (res.totalBatches || 0));
  } else {
    toast(res.error || "触发失败", "error");
  }
}

function showAddUser() {
  document.getElementById("userModalTitle").textContent = "添加用户";
  document.getElementById("edit_user_id").value = "";
  document.getElementById("edit_user_phone").value = "";
  document.getElementById("edit_user_username").value = "";
  document.getElementById("edit_user_password").value = "";
  document.getElementById("edit_user_remark").value = "";
  const days = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
  days.forEach(d => {
    document.getElementById("sch_" + d + "_enabled").checked = false;
    setVisibleSlotsForDay(d, 1);
    [0,1,2].forEach(i => {
      document.getElementById("sch_" + d + "_s" + i + "_roomid").value = "";
      document.getElementById("sch_" + d + "_s" + i + "_seatid").value = "";
      document.getElementById("sch_" + d + "_s" + i + "_times").value = "";
      document.getElementById("sch_" + d + "_s" + i + "_seatPageId").value = "";
      document.getElementById("sch_" + d + "_s" + i + "_fidEnc").value = "";
    });
  });
  document.getElementById("edit_user_schedule_json").value = "";
  document.getElementById("userModal").classList.add("show");
}

async function showEditUser(userId) {
  const res = await api("GET", "/api/school/" + currentSchool.id + "/user/" + userId);
  if (res.error) return toast(res.error, "error");
  const u = res.user;
  document.getElementById("userModalTitle").textContent = "编辑用户";
  document.getElementById("edit_user_id").value = u.id;
  document.getElementById("edit_user_phone").value = u.phone || "";
  document.getElementById("edit_user_username").value = u.username || "";
  document.getElementById("edit_user_password").value = "";
  document.getElementById("edit_user_remark").value = u.remark || "";
  fillScheduleFormFromSchedule(u.schedule || {});
  document.getElementById("edit_user_schedule_json").value = JSON.stringify(scheduleToJsonMapping(u.schedule || {}), null, 2);
  document.getElementById("userModal").classList.add("show");
}

async function doSaveUser() {
  const userId = document.getElementById("edit_user_id").value;
  const phone = document.getElementById("edit_user_phone").value.trim();
  const username = document.getElementById("edit_user_username").value.trim();
  const password = document.getElementById("edit_user_password").value;
  const remark = document.getElementById("edit_user_remark").value.trim();
  if (!phone) return toast("请填写手机号（登录账号）", "error");
  const days = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];

  const schedule = {};
  days.forEach(d => {
    const visibleCount = getVisibleSlotsForDay(d);
    const slotIndexes = Array.from({ length: visibleCount }, (_, i) => i);
    const slots = slotIndexes.map(i => ({
      roomid: document.getElementById("sch_" + d + "_s" + i + "_roomid").value.trim(),
      seatid: document.getElementById("sch_" + d + "_s" + i + "_seatid").value.trim(),
      times: document.getElementById("sch_" + d + "_s" + i + "_times").value.trim(),
      seatPageId: document.getElementById("sch_" + d + "_s" + i + "_seatPageId").value.trim(),
      fidEnc: document.getElementById("sch_" + d + "_s" + i + "_fidEnc").value.trim(),
    }));
    schedule[d] = {
      enabled: document.getElementById("sch_" + d + "_enabled").checked,
      slots,
    };
  });

  const body = { phone, username, remark, schedule };
  if (password) body.password = password;
  let res;
  if (userId) {
    res = await api("PUT", "/api/school/" + currentSchool.id + "/user/" + userId, body);
  } else {
    res = await api("POST", "/api/school/" + currentSchool.id + "/user", body);
  }
  if (res.ok) {
    toast("用户已保存");
    closeModal("userModal");
    openSchool(currentSchool.id);
  } else {
    toast(res.error || "保存失败", "error");
  }
}

async function pauseUser(userId) {
  await api("POST", "/api/school/" + currentSchool.id + "/user/" + userId + "/pause");
  toast("用户已暂停");
  openSchool(currentSchool.id);
}

async function resumeUser(userId) {
  await api("POST", "/api/school/" + currentSchool.id + "/user/" + userId + "/resume");
  toast("用户已恢复");
  openSchool(currentSchool.id);
}

async function triggerUser(userId) {
  try {
    const res = await api("POST", "/api/trigger/" + currentSchool.id + "/" + userId);
    if (res.ok) {
      toast("已触发");
      return;
    }
    const detailText = typeof res.detail === "string" ? res.detail.slice(0, 120) : "";
    const msg = [
      res.error || "触发失败",
      res.status ? ("status=" + res.status) : "",
      detailText,
    ].filter(Boolean).join(" | ");
    toast(msg, "error");
  } catch (e) {
    toast("触发异常: " + (e.message || String(e)), "error");
  }
}

async function deleteUser(userId) {
  if (!confirm("确定删除此用户？")) return;
  await api("DELETE", "/api/school/" + currentSchool.id + "/user/" + userId);
  toast("用户已删除");
  openSchool(currentSchool.id);
}

// 初始化
(async function init() {
  if (API_KEY) {
    const res = await api("GET", "/api/schools");
    if (!res.error) {
      schools = res.schools || [];
      currentView = "schools";
    }
  }
  render();
})();
</script>
</body>
</html>`;

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  },
  async fetch(request, env, ctx) {
    return handleFetch(request, env);
  },
};
