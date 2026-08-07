import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const bucketName = "inspiration-videos";
const maxVideoBytes = 500 * 1024 * 1024;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {...corsHeaders, "Content-Type": "application/json; charset=utf-8"},
  });
}

function clean(value: unknown, max = 600) {
  return String(value ?? "").trim().slice(0, max);
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

async function ensureBucket(admin: ReturnType<typeof createClient>) {
  const {error} = await admin.storage.getBucket(bucketName);
  if (!error) return;
  const {error: createError} = await admin.storage.createBucket(bucketName, {
    public: false,
    fileSizeLimit: maxVideoBytes,
    allowedMimeTypes: ["video/mp4", "video/quicktime", "video/webm", "video/x-m4v"],
  });
  if (createError && !createError.message.toLowerCase().includes("already exists")) throw createError;
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
      return json({ok: true, model, configured: Boolean(Deno.env.get("DASHSCOPE_API_KEY"))});
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

    if (action === "analyze") {
      const apiKey = Deno.env.get("DASHSCOPE_API_KEY");
      const model = Deno.env.get("QWEN_OMNI_MODEL") || "qwen3.5-omni-flash";
      const baseUrl = (Deno.env.get("DASHSCOPE_BASE_URL") || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, "");
      if (!apiKey) return json({error: "Qwen-Omni 服务尚未配置 DASHSCOPE_API_KEY"}, 503);

      const path = clean(body.path, 500);
      let videoUrl = clean(body.videoUrl, 3000);
      if (path) {
        if (!path.startsWith("references/")) return json({error: "视频路径无效"}, 400);
        const {data: signed, error} = await admin.storage.from(bucketName).createSignedUrl(path, 60 * 60 * 3);
        if (error || !signed?.signedUrl) throw error || new Error("无法读取已上传视频");
        videoUrl = signed.signedUrl;
      }
      if (!/^https:\/\//i.test(videoUrl)) return json({error: "请上传视频或提供 HTTPS 视频直链"}, 400);

      const metadata = body.metadata || {};
      const reference = {
        title: clean(metadata.title, 240),
        creator: clean(metadata.creator, 160),
        platform: clean(metadata.platform, 100),
        type: clean(metadata.type, 100),
        sourceUrl: clean(metadata.sourceUrl, 1000),
        userObservation: clean(metadata.userObservation, 1200),
      };
      const prompt = `请完整观看并聆听这个视频，做一份可以用于复刻创作的细粒度研究报告。参考信息：${JSON.stringify(reference)}

要求：
1. 不要只总结主题，必须还原视频真正讲了什么，并按时间顺序拆分段落。
2. 时间轴尽量覆盖完整视频；短视频至少 6 段，长视频按每 20–60 秒或每个观点转折拆分。
3. 明确区分口播内容、字幕信息、画面动作、音乐/音效及剪辑节奏，不要凭空补充。
4. 每个重要判断都给出时间点、原话摘要或可观察画面作为依据；不确定时明确标注。
5. 制作步骤要具体到个人创作者可以执行，并写明关键产出物。
6. 分析哪些方法可以迁移，哪些依赖原作者资源，以及如何做出差异化。

只返回合法 JSON：
{
  "highlights":"300-600字，具体说明最值得学习的内容与表达亮点",
  "timeline":[{"time":"00:00-00:15","title":"段落标题","detail":"口播观点、案例、画面、字幕和声音细节"}],
  "structure":"200-400字，解释开场、铺垫、论证、案例、转折和收束结构",
  "audiovisual":"200-400字，解释镜头、字幕、口播、音乐、音效和节奏如何配合",
  "reproducibility":"250-500字，说明可复制部分、资源依赖、风险和差异化方案",
  "copyScore":1到5的整数,
  "steps":["8到15个按执行顺序排列的具体制作步骤，每步写清产出物"],
  "evidence":["至少6条：时间点｜原话摘要或画面证据｜支持的判断"],
  "tags":["3到6个短标签"]
}`;

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json"},
        body: JSON.stringify({
          model,
          stream: false,
          modalities: ["text"],
          temperature: 0.15,
          max_tokens: 8000,
          messages: [
            {role: "system", content: "你是严谨的视频内容研究员和个人创作教练。所有结论都必须来自视频中可观察到的画面或声音证据。"},
            {role: "user", content: [
              {type: "video_url", video_url: {url: videoUrl}},
              {type: "text", text: prompt},
            ]},
          ],
        }),
      });
      const raw = await response.text();
      if (!response.ok) {
        console.error("DashScope request failed", response.status, raw.slice(0, 500));
        let message = raw.slice(0, 220);
        try { message = JSON.parse(raw)?.error?.message || message; } catch (_) { /* keep raw message */ }
        return json({error: `Qwen-Omni 请求失败（${response.status}）：${message}`}, 502);
      }
      const payload = JSON.parse(raw);
      const content = payload?.choices?.[0]?.message?.content;
      const textContent = Array.isArray(content) ? content.map(item => item?.text || "").join("") : String(content || "");
      if (!textContent) return json({error: "Qwen-Omni 没有返回分析内容"}, 502);
      return json({ok: true, model, result: parseModelJson(textContent)});
    }

    return json({error: "未知操作"}, 400);
  } catch (error) {
    console.error("inspiration-video error", error);
    return json({error: error instanceof Error ? error.message : "视频服务发生未知错误"}, 500);
  }
});
