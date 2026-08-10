import { createClient } from "npm:@supabase/supabase-js@2";

declare const EdgeRuntime: {waitUntil(promise: Promise<unknown>): void};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const bucketName = "inspiration-videos";
const maxVideoBytes = 500 * 1024 * 1024;
const maxSourceHtmlBytes = 2 * 1024 * 1024;
const sourceHosts = ["xiaohongshu.com", "xhslink.com"];
const mediaHosts = ["xhscdn.com", "xhscdn.net"];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {...corsHeaders, "Content-Type": "application/json; charset=utf-8"},
  });
}

function clean(value: unknown, max = 600) {
  return String(value ?? "").trim().slice(0, max);
}

function hostMatches(host: string, allowed: string[]) {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  return allowed.some(domain => normalized === domain || normalized.endsWith(`.${domain}`));
}

function sourceUrl(value: unknown) {
  try {
    const url = new URL(clean(value, 3000));
    if (url.protocol !== "https:" || !hostMatches(url.hostname, sourceHosts)) return null;
    return url;
  } catch (_) {
    return null;
  }
}

function mediaUrl(value: unknown) {
  try {
    const url = new URL(clean(value, 5000).replace(/^http:\/\//i, "https://"));
    if (url.protocol !== "https:" || !hostMatches(url.hostname, mediaHosts)) return "";
    return url.href;
  } catch (_) {
    return "";
  }
}

function safeExtension(fileName: string, contentType: string) {
  const extension = fileName.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (extension && ["mp4", "mov", "webm", "m4v"].includes(extension)) return extension;
  if (contentType.includes("quicktime")) return "mov";
  if (contentType.includes("webm")) return "webm";
  return "mp4";
}

function parseModelJson(value: string) {
  const cleaned = value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(cleaned); }
  catch (_) {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("Qwen-Omni 返回了无法识别的分析格式");
  }
}

function textList(value: unknown) {
  if (Array.isArray(value)) return value.map(item => clean(typeof item === "string" ? item : JSON.stringify(item), 1600)).filter(Boolean);
  return clean(value, 12_000).split(/\n+/).map(item => item.replace(/^[-*\d.、)\s]+/, "").trim()).filter(Boolean);
}

function normalizeTimeline(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item: any, index) => {
      if (typeof item === "string") return {time: "", title: `片段 ${index + 1}`, detail: clean(item, 1600)};
      return {
        time: clean(item?.time ?? item?.timestamp ?? item?.时间 ?? item?.时间点, 80),
        title: clean(item?.title ?? item?.heading ?? item?.标题 ?? item?.段落, 180),
        detail: clean(item?.detail ?? item?.description ?? item?.content ?? item?.细节 ?? item?.内容, 1800),
      };
    }).filter(item => item.time || item.title || item.detail);
  }
  return textList(value).map((detail, index) => ({time: "", title: `片段 ${index + 1}`, detail}));
}

function pick(root: any, ...keys: string[]) {
  for (const key of keys) {
    const value = root?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function normalizeReport(parsed: any) {
  let root = parsed;
  for (let depth = 0; depth < 3; depth++) {
    const nested = root?.result ?? root?.analysis ?? root?.report ?? root?.data ?? root?.报告 ?? root?.分析结果;
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) break;
    root = nested;
  }
  const report = {
    highlights: clean(pick(root, "highlights", "contentHighlights", "overview", "亮点", "内容亮点", "核心亮点"), 8000),
    timeline: normalizeTimeline(pick(root, "timeline", "timeLine", "segments", "时间线", "逐段时间轴", "分段拆解")),
    structure: clean(pick(root, "structure", "contentStructure", "叙事结构", "内容结构"), 6000),
    audiovisual: clean(pick(root, "audiovisual", "audioVisual", "visualAudio", "视听分析", "画面与声音配合"), 6000),
    reproducibility: clean(pick(root, "reproducibility", "replicability", "copyAnalysis", "可复制性", "可复制性分析"), 8000),
    copyScore: Math.max(1, Math.min(5, Number(pick(root, "copyScore", "replicationScore", "可复制性评分", "复制分数")) || 3)),
    steps: textList(pick(root, "steps", "productionSteps", "actionSteps", "制作步骤", "步骤拆解")),
    evidence: textList(pick(root, "evidence", "observations", "依据", "证据")),
    tags: textList(pick(root, "tags", "keywords", "标签", "关键词")).slice(0, 8),
  };
  const substance = report.highlights.length + report.structure.length + report.audiovisual.length
    + report.reproducibility.length + report.timeline.length * 30 + report.steps.length * 30;
  if (substance < 80) {
    console.error("Qwen report was structurally empty", Object.keys(parsed || {}), Object.keys(root || {}));
    throw new Error("Qwen 已返回，但报告结构为空；系统已阻止空报告，请重新分析一次");
  }
  return report;
}

async function ensureBucket(admin: any) {
  const {error} = await admin.storage.getBucket(bucketName);
  if (!error) return;
  const {error: createError} = await admin.storage.createBucket(bucketName, {
    public: false,
    fileSizeLimit: maxVideoBytes,
    allowedMimeTypes: ["video/mp4", "video/quicktime", "video/webm", "video/x-m4v"],
  });
  if (createError && !createError.message.toLowerCase().includes("already exists")) throw createError;
}

async function fetchSourcePage(input: unknown) {
  let current = sourceUrl(input);
  if (!current) throw new Error("目前只支持自动解析小红书作品链接");

  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6",
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("作品链接跳转地址缺失");
      current = sourceUrl(new URL(location, current).href);
      if (!current) throw new Error("作品链接跳转到了不受支持的网站");
      continue;
    }
    if (!response.ok) throw new Error(`作品页读取失败（${response.status}）`);
    const length = Number(response.headers.get("content-length") || 0);
    if (length > maxSourceHtmlBytes) throw new Error("作品页面内容异常大，已停止解析");
    const html = await response.text();
    if (html.length > maxSourceHtmlBytes) throw new Error("作品页面内容异常大，已停止解析");
    return {html, finalUrl: current.href};
  }
  throw new Error("作品链接跳转次数过多");
}

function initialState(html: string) {
  const marker = "window.__INITIAL_STATE__=";
  const start = html.indexOf(marker);
  if (start < 0) throw new Error("作品页没有公开媒体数据，可能需要登录或链接已失效");
  const valueStart = start + marker.length;
  const end = html.indexOf("</script>", valueStart);
  if (end < 0) throw new Error("作品页数据格式无法识别");
  try { return JSON.parse(html.slice(valueStart, end).trim().replace(/\bundefined\b/g, "null")); }
  catch (_) { throw new Error("作品页数据解析失败，请稍后重试"); }
}

function firstXhsNote(state: any) {
  const map = state?.note?.noteDetailMap;
  if (!map || typeof map !== "object") throw new Error("没有找到可分析的作品内容");
  const detail = Object.values(map).find((entry: any) => entry?.note) as any;
  if (!detail?.note) throw new Error("没有找到可分析的作品内容");
  return detail.note;
}

function pickSubtitle(note: any) {
  try {
    const mediaV2 = JSON.parse(note?.video?.mediaV2 || "{}");
    const subtitles = mediaV2?.video?.opaque1?.subtitles || {};
    const candidate = subtitles["zh-CN"]?.[0]?.url || subtitles.source?.[0]?.url || subtitles["en-US"]?.[0]?.url;
    return mediaUrl(candidate);
  } catch (_) {
    return "";
  }
}

async function fetchSubtitle(url: string) {
  if (!url) return "";
  try {
    const response = await fetch(url, {signal: AbortSignal.timeout(12_000)});
    if (!response.ok) return "";
    return clean(await response.text(), 24_000);
  } catch (_) {
    return "";
  }
}

async function resolveXhs(input: unknown) {
  const {html, finalUrl} = await fetchSourcePage(input);
  const note = firstXhsNote(initialState(html));
  const h264 = note?.video?.media?.stream?.h264;
  const stream = Array.isArray(h264) ? (h264.find((entry: any) => entry?.defaultStream === 0) || h264[0]) : null;
  const video = mediaUrl(stream?.masterUrl || stream?.backupUrls?.[0]);
  const images = Array.isArray(note?.imageList)
    ? note.imageList.map((entry: any) => mediaUrl(entry?.urlDefault || entry?.urlPre || entry?.url)).filter(Boolean).slice(0, 12)
    : [];
  const subtitle = await fetchSubtitle(pickSubtitle(note));
  const chapters = Array.isArray(note?.video?.consumer?.chapters)
    ? note.video.consumer.chapters.map((entry: any) => `${Math.round(Number(entry?.time || 0) / 1000)}秒：${clean(entry?.text, 100)}`).join("；")
    : "";
  if (!video && !images.length) throw new Error("该作品暂时没有解析到可访问的视频或图片");
  return {
    finalUrl,
    title: clean(note?.title, 240),
    creator: clean(note?.user?.nickname, 160),
    description: clean(note?.desc, 5000),
    platform: "小红书",
    mediaType: video ? "video" : "gallery",
    video,
    images,
    subtitle,
    chapters,
    durationSeconds: Math.round(Number(stream?.duration || note?.video?.media?.video?.duration || 0) / (Number(stream?.duration || 0) > 10_000 ? 1000 : 1)),
    coverUrl: images[0] || "",
  };
}

function analysisPrompt(reference: Record<string, unknown>, mediaType: string) {
  const ordering = mediaType === "video"
    ? "按时间顺序拆分；短视频至少 6 段，长视频按每 20–60 秒或每个观点转折拆分。"
    : "按图片顺序拆分，每一张都说明画面、文字信息和它在整体叙事中的作用。";
  const timeExample = mediaType === "video" ? "00:00-00:15" : "第1张";
  return `请完整分析这份${mediaType === "video" ? "视频" : "图集"}作品，做一份可以用于复刻创作的细粒度研究报告。参考信息：${JSON.stringify(reference)}

要求：
1. 不要只总结主题，必须还原作品真正展示和讲解了什么。${ordering}
2. 明确区分口播/字幕、画面动作与界面变化、音乐音效和剪辑节奏，不要凭空补充。
3. 每个重要判断都给出时间点或图片序号、原话摘要或可观察画面作为依据；不确定时明确标注。
4. 特别说明作品中展示的产品是什么、核心交互怎么运作、作者如何搭建以及最终呈现效果。
5. 制作步骤要具体到个人创作者可以执行，并写明每一步的关键产出物。
6. 分析哪些方法可以迁移、哪些依赖原作者资源，以及如何做出差异化。

只返回合法 JSON：
{
  "highlights":"300-600字，具体说明作品内容、产品亮点和表达亮点",
  "timeline":[{"time":"${timeExample}","title":"段落或图片标题","detail":"口播观点、界面操作、画面、字幕和声音细节"}],
  "structure":"200-400字，解释开场、铺垫、演示、论证、转折和收束结构",
  "audiovisual":"200-400字，解释镜头、界面录屏、字幕、口播、音乐和节奏如何配合",
  "reproducibility":"250-500字，说明可复制部分、技术与素材依赖、风险和差异化方案",
  "copyScore":1到5的整数,
  "steps":["8到15个按执行顺序排列的具体制作步骤，每步写清产出物"],
  "evidence":["至少6条：时间点或图片序号｜原话摘要或画面证据｜支持的判断"],
  "tags":["3到6个短标签"]
}`;
}

async function callQwen(mediaContent: any[], reference: Record<string, unknown>, mediaType: string, onResponse?: () => Promise<void>) {
  const apiKey = Deno.env.get("DASHSCOPE_API_KEY");
  const model = Deno.env.get("QWEN_OMNI_MODEL") || "qwen3.5-omni-flash";
  const baseUrl = (Deno.env.get("DASHSCOPE_BASE_URL") || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, "");
  if (!apiKey) throw new Error("Qwen-Omni 服务尚未配置 DASHSCOPE_API_KEY");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json"},
    body: JSON.stringify({
      model,
      stream: false,
      modalities: ["text"],
      temperature: 0.1,
      max_tokens: 4200,
      messages: [
        {role: "system", content: "你是严谨的多模态内容研究员和个人创作教练。所有结论都必须来自作品中可观察到的画面、声音、字幕或页面公开文字。"},
        {role: "user", content: [...mediaContent, {type: "text", text: analysisPrompt(reference, mediaType)}]},
      ],
    }),
    signal: AbortSignal.timeout(360_000),
  });
  const raw = await response.text();
  if (!response.ok) {
    console.error("DashScope request failed", response.status, raw.slice(0, 500));
    let message = raw.slice(0, 220);
    try { message = JSON.parse(raw)?.error?.message || message; } catch (_) { /* keep raw */ }
    throw new Error(`Qwen-Omni 请求失败（${response.status}）：${message}`);
  }
  if (onResponse) await onResponse();
  const payload = JSON.parse(raw);
  const content = payload?.choices?.[0]?.message?.content;
  const textContent = Array.isArray(content) ? content.map((item: any) => item?.text || "").join("") : String(content || "");
  if (!textContent) throw new Error("Qwen-Omni 没有返回分析内容");
  return {model, result: normalizeReport(parseModelJson(textContent))};
}

async function mirrorRemoteVideo(admin: any, supabaseUrl: string, serviceRoleKey: string, remoteUrl: string) {
  if (!mediaUrl(remoteUrl)) throw new Error("解析到的视频地址无效");
  let response: Response;
  try {
    response = await fetch(remoteUrl, {
      signal: AbortSignal.timeout(120_000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36",
        "Accept": "video/mp4,video/*;q=0.9,*/*;q=0.5",
        "Referer": "https://www.xiaohongshu.com/",
      },
    });
  } catch (error) {
    console.error("remote video download failed", error);
    throw new Error(`原视频读取失败：${error instanceof Error ? error.message : "网络连接异常"}`);
  }
  if (!response.ok) throw new Error(`原视频读取失败（${response.status}）`);
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > maxVideoBytes) throw new Error("原视频超过 500 MB，暂时无法自动分析");
  const contentType = clean(response.headers.get("content-type") || "video/mp4", 100).split(";")[0];
  if (!contentType.startsWith("video/") && contentType !== "application/octet-stream") {
    throw new Error(`作品链接返回的不是视频（${contentType || "未知格式"}）`);
  }

  const path = `resolved/${crypto.randomUUID()}.${safeExtension("video.mp4", contentType)}`;
  const uploadHeaders: Record<string, string> = {
    Authorization: `Bearer ${serviceRoleKey}`,
    apikey: serviceRoleKey,
    "Content-Type": contentType.startsWith("video/") ? contentType : "video/mp4",
    "Cache-Control": "3600",
    "x-upsert": "false",
  };
  if (declaredSize > 0) uploadHeaders["Content-Length"] = String(declaredSize);
  let uploadResponse: Response;
  try {
    uploadResponse = await fetch(`${supabaseUrl}/storage/v1/object/${bucketName}/${path}`, {
      method: "POST",
      headers: uploadHeaders,
      body: response.body,
      signal: AbortSignal.timeout(180_000),
    });
  } catch (error) {
    console.error("remote video streaming upload failed", error);
    throw new Error(`视频标准化失败：${error instanceof Error ? error.message : "传输中断"}`);
  }
  if (!uploadResponse.ok) {
    const detail = clean(await uploadResponse.text(), 300);
    console.error("remote video mirror upload failed", uploadResponse.status, detail);
    throw new Error(`视频标准化失败（${uploadResponse.status}）：${detail || "存储服务拒绝了视频"}`);
  }
  const {data: signed, error: signError} = await admin.storage.from(bucketName).createSignedUrl(path, 60 * 60 * 3);
  if (signError || !signed?.signedUrl) {
    await admin.storage.from(bucketName).remove([path]);
    throw signError || new Error("无法创建视频分析地址");
  }
  return {path, signedUrl: signed.signedUrl, byteLength: declaredSize};
}

async function prepareAnalysis(body: any, admin: any, supabaseUrl: string) {
  const path = clean(body.path, 500);
  let directVideo = clean(body.videoUrl, 3000);
  let resolved: Awaited<ReturnType<typeof resolveXhs>> | null = null;
  const metadata = body.metadata || {};

  if (path) {
    if (!path.startsWith("references/")) throw new Error("视频路径无效");
    const {data: signed, error} = await admin.storage.from(bucketName).createSignedUrl(path, 60 * 60 * 3);
    if (error || !signed?.signedUrl) throw error || new Error("无法读取已上传视频");
    directVideo = signed.signedUrl;
  } else if (!/^https:\/\//i.test(directVideo) && body.sourceUrl) {
    resolved = await resolveXhs(body.sourceUrl);
    directVideo = resolved.video;
  }

  let mediaType = "video";
  let mediaContent: any[] = [];
  const shouldMirrorVideo = Boolean(resolved?.video && directVideo);
  const duration = Number(resolved?.durationSeconds || 0);
  const fps = duration >= 240 ? 0.2 : duration >= 90 ? 0.35 : 0.6;
  if (/^https:\/\//i.test(directVideo) && !shouldMirrorVideo) {
    mediaContent = [{type: "video_url", video_url: {url: directVideo, fps}}];
  } else if (shouldMirrorVideo) {
    // Public social-media CDN URLs are normalized inside the streaming task.
    // This gives Qwen a stable URL with standard Content-Length/Content-Type headers.
    mediaContent = [];
  } else if (resolved?.images.length) {
    mediaType = "gallery";
    mediaContent = resolved.images.map((url: string) => ({type: "image_url", image_url: {url}}));
  } else {
    throw new Error("没有解析到可分析的视频或图集；可改用上传文件");
  }

  const reference = {
    title: clean(resolved?.title || metadata.title, 240),
    creator: clean(resolved?.creator || metadata.creator, 160),
    platform: clean(resolved?.platform || metadata.platform, 100),
    type: clean(metadata.type || (mediaType === "video" ? "视频" : "图集"), 100),
    sourceUrl: clean(resolved?.finalUrl || metadata.sourceUrl || body.sourceUrl, 1000),
    userObservation: clean(metadata.userObservation, 1200),
    publicDescription: clean(resolved?.description, 5000),
    chapters: clean(resolved?.chapters, 2000),
    subtitleTranscript: clean(resolved?.subtitle, 24_000),
  };
  const resolvedPayload = resolved ? {
    title: resolved.title, creator: resolved.creator, platform: resolved.platform,
    mediaType, durationSeconds: resolved.durationSeconds, coverUrl: resolved.coverUrl,
    sourceLabel: mediaType === "video" ? "小红书链接·视频实读" : "小红书链接·图集实读",
  } : {mediaType, durationSeconds: 0, sourceLabel: path ? "上传视频·画面声音实读" : "视频直链·画面声音实读"};
  return {mediaContent, reference, mediaType, resolved: resolvedPayload, fps, directVideo, shouldMirrorVideo};
}

function streamAnalysis(body: any, admin: any, supabaseUrl: string, serviceRoleKey: string) {
  const encoder = new TextEncoder();
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const send = (event: string, payload: unknown) => writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
  const startedAt = Date.now();

  const task = (async () => {
    let heartbeat: number | undefined;
    let mirroredPath = "";
    let stage = "connecting";
    let stepIndex = 1;
    try {
      await send("progress", {stage, stepIndex, percent: 10, message: "分析请求已接收，云同步密钥和函数环境验证通过。"});
      stage = "resolving";
      stepIndex = 2;
      await send("progress", {stage, stepIndex, percent: 20, message: "正在打开作品链接并读取公开信息…"});
      const prepared = await prepareAnalysis(body, admin, supabaseUrl);
      await send("progress", {
        stage: "resolved",
        stepIndex: 2,
        percent: 30,
        message: prepared.mediaType === "video"
          ? `链接已解析，已读取${prepared.resolved.durationSeconds ? ` ${Math.ceil(prepared.resolved.durationSeconds / 60)} 分钟` : ""}视频`
          : "链接已解析，已读取作品图集",
        resolved: prepared.resolved,
      });
      let mediaContent = prepared.mediaContent;
      if (prepared.shouldMirrorVideo) {
        stage = "normalizing";
        stepIndex = 3;
        await send("progress", {stage, stepIndex, percent: 38, message: "正在自动读取并标准化原视频，无需手动下载…"});
        const mirrored = await mirrorRemoteVideo(admin, supabaseUrl, serviceRoleKey, prepared.directVideo);
        mirroredPath = mirrored.path;
        mediaContent = [{type: "video_url", video_url: {url: mirrored.signedUrl, fps: prepared.fps}}];
        await send("progress", {
          stage: "normalized",
          stepIndex: 3,
          percent: 54,
          message: `视频已准备好（${Math.max(1, Math.round(mirrored.byteLength / 1024 / 1024))} MB），开始交给 Qwen 分析…`,
        });
      }
      stage = "model";
      stepIndex = 4;
      await send("progress", {stage, stepIndex, percent: 62, message: `Qwen 正在理解画面、声音与字幕（${prepared.fps} FPS），长视频通常需要 1–4 分钟`});
      heartbeat = setInterval(() => {
        const elapsed = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
        const percent = Math.min(88, 62 + Math.floor(elapsed / 12) * 2);
        void send("progress", {stage: "model", stepIndex: 4, percent, message: `Qwen 仍在分析，已等待 ${elapsed} 秒…`}).catch(() => undefined);
      }, 12_000) as unknown as number;
      const analyzed = await callQwen(mediaContent, prepared.reference, prepared.mediaType, async () => {
        stage = "report";
        stepIndex = 5;
        await send("progress", {stage, stepIndex, percent: 92, message: "模型已返回，正在整理字段并检查报告完整性…"});
      });
      stage = "complete";
      stepIndex = 6;
      await send("progress", {stage, stepIndex, percent: 100, message: "拆解报告已生成，正在写入编辑器…"});
      await send("result", {ok: true, ...analyzed, resolved: prepared.resolved});
    } catch (error) {
      console.error("stream analysis failed", error);
      const message = error instanceof Error ? error.message : "作品分析失败";
      try { await send("error", {error: message, stage, stepIndex, percent: 0}); } catch (_) { /* client disconnected */ }
    } finally {
      if (heartbeat !== undefined) clearInterval(heartbeat);
      if (mirroredPath) {
        try { await admin.storage.from(bucketName).remove([mirroredPath]); }
        catch (error) { console.error("temporary mirrored video cleanup failed", error); }
      }
      try { await writer.close(); } catch (_) { /* client disconnected */ }
    }
  })();
  EdgeRuntime.waitUntil(task);
  return new Response(stream.readable, {
    headers: {
      ...corsHeaders,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response("ok", {headers: corsHeaders});
  if (request.method !== "POST") return json({error: "仅支持 POST 请求"}, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!supabaseUrl || !serviceRoleKey || !anonKey) return json({error: "Supabase 函数环境未就绪"}, 500);

    const body = await request.json();
    const action = clean(body.action, 40);
    const accessKey = clean(body.accessKey, 300);
    if (accessKey.length < 24) return json({error: "云同步密钥无效"}, 401);

    const validator = createClient(supabaseUrl, anonKey, {auth: {persistSession: false}});
    const {data: portfolio, error: validationError} = await validator.rpc("portfolio_load", {p_access_key: accessKey});
    if (validationError || !Array.isArray(portfolio) || !portfolio.length) return json({error: "无法验证云同步密钥"}, 401);

    const admin = createClient(supabaseUrl, serviceRoleKey, {auth: {persistSession: false}});

    if (action === "ping") {
      const model = Deno.env.get("QWEN_OMNI_MODEL") || "qwen3.5-omni-flash";
      return json({ok: true, model, configured: Boolean(Deno.env.get("DASHSCOPE_API_KEY")), linkPlatforms: ["小红书"]});
    }

    if (action === "resolve-link") {
      const resolved = await resolveXhs(body.sourceUrl);
      return json({ok: true, resolved: {
        title: resolved.title, creator: resolved.creator, description: resolved.description,
        platform: resolved.platform, mediaType: resolved.mediaType, durationSeconds: resolved.durationSeconds,
        coverUrl: resolved.coverUrl,
      }});
    }

    await ensureBucket(admin);

    if (action === "create-upload") {
      const fileName = clean(body.fileName, 240);
      const contentType = clean(body.contentType, 100).toLowerCase();
      const fileSize = Number(body.fileSize) || 0;
      if (!contentType.startsWith("video/")) return json({error: "只允许上传视频文件"}, 400);
      if (!fileSize || fileSize > maxVideoBytes) return json({error: "视频必须小于 500 MB"}, 400);
      const extension = safeExtension(fileName, contentType);
      const path = `references/${crypto.randomUUID()}.${extension}`;
      const {data: signed, error} = await admin.storage.from(bucketName).createSignedUploadUrl(path);
      if (error || !signed?.signedUrl) throw error || new Error("无法创建视频上传地址");
      const signedUrl = signed.signedUrl.startsWith("http") ? signed.signedUrl : `${supabaseUrl}/storage/v1${signed.signedUrl}`;
      return json({path, signedUrl});
    }

    if (action === "delete") {
      const path = clean(body.path, 500);
      if (!path.startsWith("references/")) return json({error: "视频路径无效"}, 400);
      const {error} = await admin.storage.from(bucketName).remove([path]);
      if (error) throw error;
      return json({ok: true});
    }

    if (action === "analyze-stream") return streamAnalysis(body, admin, supabaseUrl, serviceRoleKey);

    if (action === "analyze") {
      const prepared = await prepareAnalysis(body, admin, supabaseUrl);
      let mediaContent = prepared.mediaContent;
      let mirroredPath = "";
      if (prepared.shouldMirrorVideo) {
        const mirrored = await mirrorRemoteVideo(admin, supabaseUrl, serviceRoleKey, prepared.directVideo);
        mirroredPath = mirrored.path;
        mediaContent = [{type: "video_url", video_url: {url: mirrored.signedUrl, fps: prepared.fps}}];
      }
      const analyzed = await callQwen(mediaContent, prepared.reference, prepared.mediaType);
      if (mirroredPath) await admin.storage.from(bucketName).remove([mirroredPath]);
      return json({ok: true, ...analyzed, resolved: prepared.resolved});
    }

    return json({error: "未知操作"}, 400);
  } catch (error) {
    console.error("inspiration-video error", error);
    const message = error instanceof Error ? error.message : "视频服务发生未知错误";
    const status = /不支持|没有|解析|读取失败|链接|媒体/.test(message) ? 400 : 500;
    return json({error: message}, status);
  }
});
