// 깃허브 Actions에서 실행. data.js의 채널 목록을 유튜브 API로 조회해 live.json / ids.json에 저장한다.
// 할당량(하루 10,000)은 이 스크립트 한 곳에서만 쓰이므로 방문자 수와 무관하게 고정된다.
import fs from "node:fs";

const KEY = process.env.YT_API_KEY;
if (!KEY) { console.error("YT_API_KEY secret이 없습니다. 저장소 Settings > Secrets > Actions 에 추가하세요."); process.exit(1); }
const MODE = process.env.MODE || "auto";            // auto | full | live
const SEARCH = Math.max(0, +process.env.SEARCH_COUNT || 0);
const VN = 8;                                       // 채널당 보관할 최근 영상 수
const FULL_EVERY_MS = 4 * 36e5;                     // 전체 갱신 주기
const LIVE_PER = 2;                                 // 라이브 확인 시 채널당 볼 최신 영상 수
const DAILY_CAP = 9600;                             // 이 선을 넘기면 멈춤 (여유 400)
const FATAL = new Set(["quotaExceeded", "dailyLimitExceeded", "keyInvalid", "forbidden", "accessNotConfigured", "ipRefererBlocked", "badRequest"]); // 계속해 봐야 소용없는 오류

const read = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
const src = fs.readFileSync("data.js", "utf8");
const ACC = JSON.parse(src.slice(src.indexOf("["), src.lastIndexOf("]") + 1));
const live = read("live.json", { generatedAt: 0, fullAt: 0, channels: {}, quota: { day: "", used: 0 } });
const ids = read("ids.json", {});                   // accountId -> {ytId, auto} | {ytId:null, failed}

const day = new Date(Date.now() - 7 * 36e5).toISOString().slice(0, 10); // 할당량은 태평양 시간 자정에 초기화
if (live.quota.day !== day) live.quota = { day, used: 0 };
let used = 0;
const left = () => DAILY_CAP - live.quota.used - used;

async function yt(path, params) {
  const u = new URL((process.env.YT_API_BASE || "https://www.googleapis.com/youtube/v3/") + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set("key", KEY);
  used += path === "search" ? 100 : 1;
  const r = await fetch(u); const j = await r.json();
  if (!r.ok) { const e = new Error(j.error?.message || r.status); e.reason = j.error?.errors?.[0]?.reason || (r.status === 400 ? "badRequest" : r.status === 403 ? "forbidden" : ""); throw e; }
  return j;
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; try { await fn(it); } catch (e) { if (FATAL.has(e.reason)) throw e; console.warn("skip:", e.message); } }
  }));
}
const chunks = (arr, n) => { const o = []; for (let k = 0; k < arr.length; k += n) o.push(arr.slice(k, k + n)); return o; };
const idOf = a => a.ytId || ids[a.id]?.ytId || null;
let fatal = null;
const save = () => {
  // data.js에서 빠진 계정의 흔적 정리
  const accIds = new Set(ACC.map(a => a.id)); for (const k of Object.keys(ids)) if (!accIds.has(k)) delete ids[k];
  const chIds = new Set(ACC.map(idOf).filter(Boolean)); for (const k of Object.keys(live.channels)) if (!chIds.has(k)) delete live.channels[k];
  live.quota.used += used; live.generatedAt = Date.now();
  fs.writeFileSync("live.json", JSON.stringify(live));
  fs.writeFileSync("ids.json", JSON.stringify(ids));
  console.log(`saved. this run ${used} units, today ${live.quota.used}, channels ${Object.keys(live.channels).length}`);
};

// 영상 조회수 + 라이브 여부 (50개당 1단위)
async function videoStats(chIds, perChannel) {
  const vmap = {};
  for (const id of chIds) { const c = live.channels[id]; if (!c?.vids) continue; c.vids.slice(0, perChannel).forEach(v => vmap[v.id] = id); if (c.live?.id) vmap[c.live.id] = id; }
  const vids = Object.keys(vmap); const found = {};
  await pool(chunks(vids, 50), 4, async b => {
    const j = await yt("videos", { part: "snippet,statistics,liveStreamingDetails", id: b.join(","), maxResults: 50 });
    for (const v of j.items || []) {
      const cid = vmap[v.id]; if (!cid) continue;
      const rec = live.channels[cid].vids.find(x => x.id === v.id); if (rec) rec.views = +v.statistics?.viewCount || 0;
      if (v.snippet.liveBroadcastContent === "live" && !found[cid]) found[cid] = { id: v.id, title: v.snippet.title, viewers: +v.liveStreamingDetails?.concurrentViewers || 0 };
    }
  });
  for (const id of chIds) if (live.channels[id]) live.channels[id].live = found[id] || null;
}

try {
  // 1) 핸들 -> 채널 ID (1단위, 한 번만)
  const needHandle = ACC.filter(a => !idOf(a) && a.yt && !(ids[a.id]?.failed > Date.now() - 7 * 864e5));
  await pool(needHandle, 6, async a => {
    if (left() < 50) return;
    let id = null;
    if (/^UC[\w-]{20,}$/.test(a.yt)) id = a.yt;
    else { const j = await yt("channels", { part: "id", forHandle: a.yt.replace(/^@/, "") }); id = j.items?.[0]?.id || null; }
    ids[a.id] = id ? { ytId: id, auto: false } : { ytId: null, failed: Date.now() };
  });
  // 2) 이름 검색 (100단위, 요청한 개수만큼)
  if (SEARCH > 0) {
    const cands = ACC.filter(a => !idOf(a) && !a.yt && !a.noyt && !(ids[a.id]?.failed > Date.now() - 30 * 864e5)).slice(0, SEARCH);
    for (const a of cands) {
      if (left() < 150) { console.log("할당량 부족으로 검색 중단"); break; }
      const j = await yt("search", { part: "snippet", type: "channel", q: a.name, maxResults: 1, regionCode: "KR", relevanceLanguage: "ko" });
      const id = j.items?.[0]?.snippet?.channelId || null;
      ids[a.id] = id ? { ytId: id, auto: true } : { ytId: null, failed: Date.now() };
      console.log("search:", a.name, "->", id);
    }
  }
  const all = [...new Set(ACC.map(idOf).filter(Boolean))];
  const doFull = MODE === "full" || (MODE === "auto" && Date.now() - (live.fullAt || 0) > FULL_EVERY_MS - 6e4);
  const fullCost = Math.ceil(all.length / 50) + all.length + Math.ceil(all.length * VN / 50);

  if (doFull && left() > fullCost + 100) {
    // 3) 채널 정보 (50개당 1단위)
    await pool(chunks(all, 50), 4, async b => {
      const j = await yt("channels", { part: "snippet,statistics,contentDetails", id: b.join(","), maxResults: 50 });
      for (const c of j.items || []) {
        const prev = live.channels[c.id] || {};
        live.channels[c.id] = { title: c.snippet.title, handle: c.snippet.customUrl || "", avatar: c.snippet.thumbnails?.medium?.url || c.snippet.thumbnails?.default?.url || "",
          subs: c.statistics?.hiddenSubscriberCount ? null : +c.statistics?.subscriberCount || 0, views: +c.statistics?.viewCount || 0,
          uploads: c.contentDetails?.relatedPlaylists?.uploads || "", vids: prev.vids || [], live: prev.live || null };
      }
    });
    // 4) 최근 영상 (채널당 1단위)
    const withUploads = all.filter(id => live.channels[id]?.uploads);
    await pool(withUploads, 8, async id => {
      const j = await yt("playlistItems", { part: "snippet", playlistId: live.channels[id].uploads, maxResults: VN });
      live.channels[id].vids = (j.items || []).map(v => ({ id: v.snippet.resourceId.videoId, title: v.snippet.title, at: v.snippet.publishedAt }));
    });
    // 5) 조회수·라이브
    await videoStats(all, VN);
    live.fullAt = Date.now();
    console.log("full refresh done:", all.length, "channels");
  } else if (left() > 60) {
    // 라이브만 (채널당 최신 2개, 50개당 1단위)
    await videoStats(all.filter(id => live.channels[id]?.vids?.length), LIVE_PER);
    console.log("live check done");
  } else {
    console.log("오늘 할당량이 거의 다 차서 건너뜀:", live.quota.used);
  }
} catch (e) {
  console.error("중단:", e.reason || "", e.message);
  if (e.reason !== "quotaExceeded") fatal = e; // 키 오류·권한 오류 등은 Actions를 실패로 표시해 바로 알 수 있게
} finally {
  save();
  if (fatal) process.exit(1);
}
