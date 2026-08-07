(() => {
  "use strict";
  const DATA_KEY = "ai_project_portfolio_kanban_v2";
  const CLOUD_KEY = "ai_project_portfolio_cloud_config_v1";
  const AI_KEY = "ai_project_portfolio_ai_config_v1";
  const LOCAL_BOARD_KEY = "ai_project_inspiration_board_v1";
  const BOARD_ID = "__INSPIRATION_BOARD__";
  const MAX_JSON_CHARS = 3_800_000;
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[char]));
  const uid = prefix => globalThis.crypto?.randomUUID?.() || `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const clone = value => globalThis.structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value));

  let data = readJSON(DATA_KEY, []);
  let detachedInspirations = readJSON(LOCAL_BOARD_KEY, []);
  let cloudConfig = readJSON(CLOUD_KEY, null);
  let editingId = "";
  let pendingCover = null;
  let cloudTimer = null;

  function readJSON(key, fallback){
    try { const value = JSON.parse(localStorage.getItem(key)); return value ?? fallback; }
    catch(error){ return fallback; }
  }

  function hasRealProjects(){ return data.some(item => item?.status !== "__system__"); }
  function boardRecord({create=true}={}){
    let record = data.find(item => item?.id === BOARD_ID);
    if(!record && create && hasRealProjects()){
      record = {id:BOARD_ID, name:"灵感研究所数据", status:"__system__", result:"__system__", inspirations:[], updatedAt:new Date().toISOString()};
      data.push(record);
    }
    if(!record) return null;
    if(!Array.isArray(record.inspirations)) record.inspirations = [];
    return record;
  }

  function inspirations(){ return boardRecord({create:false})?.inspirations || detachedInspirations; }
  function replaceInspirations(list){
    const record = boardRecord();
    if(record) record.inspirations = list;
    else detachedInspirations = list;
  }
  function migrateDetached(){
    if(!hasRealProjects() || !detachedInspirations.length) return;
    const record = boardRecord();
    const merged = new Map(record.inspirations.map(item => [item.id, item]));
    detachedInspirations.forEach(item => merged.set(item.id, item));
    record.inspirations = [...merged.values()];
    detachedInspirations = [];
    localStorage.removeItem(LOCAL_BOARD_KEY);
  }
  function cleanLegacyDetachedBoard(){
    if(hasRealProjects()) return;
    const record = boardRecord({create:false});
    if(record?.inspirations?.length){
      const merged = new Map(detachedInspirations.map(item => [item.id, item]));
      record.inspirations.forEach(item => merged.set(item.id, item));
      detachedInspirations = [...merged.values()];
    }
    data = data.filter(item => item?.id !== BOARD_ID);
    localStorage.removeItem(DATA_KEY);
    if(detachedInspirations.length) localStorage.setItem(LOCAL_BOARD_KEY, JSON.stringify(detachedInspirations));
  }
  function safeUrl(value){
    try { const url = new URL(value); return ["http:","https:"].includes(url.protocol) ? url.href : ""; }
    catch(error){ return ""; }
  }
  function hostLabel(value){
    try { return new URL(value).hostname.replace(/^www\./, ""); }
    catch(error){ return "REFERENCE"; }
  }
  function platformFromUrl(value){
    const host = hostLabel(value).toLowerCase();
    if(host.includes("xiaohongshu") || host.includes("xhslink")) return "小红书";
    if(host.includes("bilibili") || host === "b23.tv") return "Bilibili";
    if(host.includes("youtube") || host === "youtu.be") return "YouTube";
    if(host.includes("douyin")) return "抖音";
    if(host.includes("github")) return "GitHub";
    if(host.includes("instagram")) return "Instagram";
    if(host.includes("pinterest") || host.includes("pin.it")) return "Pinterest";
    if(host.includes("weixin.qq.com")) return "公众号";
    return host === "REFERENCE" ? "" : "网站";
  }
  function normalizeItem(raw={}){
    return {
      id:raw.id || uid("idea"), url:safeUrl(raw.url), title:String(raw.title || "未命名灵感"), creator:String(raw.creator || ""),
      platform:String(raw.platform || platformFromUrl(raw.url)), type:String(raw.type || ""), note:String(raw.note || ""), cover:raw.cover || null,
      analysis:{highlights:String(raw.analysis?.highlights || ""), reproducibility:String(raw.analysis?.reproducibility || ""), steps:Array.isArray(raw.analysis?.steps) ? raw.analysis.steps : String(raw.analysis?.steps || "").split(/\n+/).filter(Boolean)},
      copyScore:Math.max(0, Math.min(5, Number(raw.copyScore) || 0)), tags:Array.isArray(raw.tags) ? raw.tags : [],
      createdAt:raw.createdAt || new Date().toISOString(), updatedAt:raw.updatedAt || new Date().toISOString()
    };
  }

  function hasCloud(){ return Boolean(cloudConfig?.url && cloudConfig?.anonKey && cloudConfig?.spaceId); }
  function cloudBase(){ return cloudConfig.url.replace(/\/+$/, "") + "/rest/v1"; }
  function cloudHeaders(){ return {apikey:cloudConfig.anonKey, Authorization:`Bearer ${cloudConfig.anonKey}`, "Content-Type":"application/json"}; }
  function setSyncState(state, label){
    const el = $("#syncState"); el.dataset.state = state;
    el.querySelector("span").textContent = label || ({offline:"本地灵感",pending:"正在同步",synced:"云端已同步",error:"同步失败"}[state]);
  }
  async function uploadCloud(){
    if(!hasCloud() || !hasRealProjects()) return setSyncState("offline");
    setSyncState("pending");
    try {
      const response = await fetch(`${cloudBase()}/rpc/portfolio_save`, {method:"POST", headers:cloudHeaders(), body:JSON.stringify({p_access_key:cloudConfig.spaceId, p_projects:data})});
      if(!response.ok) throw new Error(`${response.status} ${await response.text()}`);
      setSyncState("synced");
    } catch(error){ console.error("灵感资料同步失败", error); setSyncState("error"); toast("已保存在当前浏览器，但云端同步失败"); }
  }
  function queueCloud(){
    if(!hasCloud() || !hasRealProjects()) return setSyncState("offline");
    setSyncState("pending"); clearTimeout(cloudTimer); cloudTimer = setTimeout(uploadCloud, 650);
  }
  function persist({cloud=true}={}){
    if(!hasRealProjects()){
      cleanLegacyDetachedBoard();
      localStorage.setItem(LOCAL_BOARD_KEY, JSON.stringify(detachedInspirations));
      setSyncState("offline");
      return;
    }
    migrateDetached();
    boardRecord().updatedAt = new Date().toISOString();
    const serialized = JSON.stringify(data);
    if(serialized.length > MAX_JSON_CHARS) throw new Error("图片总量过大，请删除部分封面后再保存。");
    localStorage.setItem(DATA_KEY, serialized);
    if(cloud) queueCloud();
  }
  async function pullCloud(){
    if(!hasCloud()){ setSyncState("offline"); return false; }
    setSyncState("pending", "读取云端");
    try {
      const response = await fetch(`${cloudBase()}/rpc/portfolio_load`, {method:"POST", headers:cloudHeaders(), body:JSON.stringify({p_access_key:cloudConfig.spaceId})});
      if(!response.ok) throw new Error(`${response.status} ${await response.text()}`);
      const rows = await response.json();
      if(rows.length && Array.isArray(rows[0].projects)) data = rows[0].projects;
      migrateDetached();
      if(hasRealProjects()) localStorage.setItem(DATA_KEY, JSON.stringify(data));
      else cleanLegacyDetachedBoard();
      setSyncState("synced"); render(); return true;
    } catch(error){ console.error("灵感资料读取失败", error); setSyncState("error"); toast("云端读取失败，正在显示本机资料"); return false; }
  }

  function toast(message){
    const el = $("#toast"); el.textContent = message; el.classList.add("show");
    clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove("show"), 2800);
  }
  function analyzed(item){ return Boolean(item.analysis.highlights || item.analysis.reproducibility || item.analysis.steps.length); }
  function filteredItems(){
    const query = $("#searchInput").value.trim().toLowerCase();
    const platform = $("#platformFilter").value;
    const state = $("#analysisFilter").value;
    const score = Number($("#scoreFilter").value || 0);
    return inspirations().map(normalizeItem).filter(item => {
      const hay = [item.title,item.creator,item.platform,item.type,item.note,item.analysis.highlights,item.analysis.reproducibility,...item.analysis.steps,...item.tags].join(" ").toLowerCase();
      const scoreMatch = !score || (score === 4 ? item.copyScore >= 4 : score === 3 ? item.copyScore === 3 : item.copyScore > 0 && item.copyScore <= 2);
      return (!query || hay.includes(query)) && (!platform || item.platform === platform) && (!state || (state === "analyzed") === analyzed(item)) && scoreMatch;
    }).sort((a,b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
  function renderStats(){
    const list = inspirations().map(normalizeItem);
    $("#totalCount").textContent = list.length;
    $("#analyzedCount").textContent = list.filter(analyzed).length;
    $("#reproCount").textContent = list.filter(item => item.copyScore >= 4).length;
    $("#platformCount").textContent = new Set(list.map(item => item.platform).filter(Boolean)).size;
  }
  function renderPlatforms(){
    const select = $("#platformFilter"), current = select.value;
    const values = [...new Set(inspirations().map(item => normalizeItem(item).platform).filter(Boolean))].sort();
    select.innerHTML = `<option value="">全部平台</option>${values.map(value => `<option value="${esc(value)}">${esc(value)}</option>`).join("")}`;
    select.value = values.includes(current) ? current : "";
  }
  function cardHTML(item, index){
    const url = safeUrl(item.url), cover = item.cover?.dataUrl;
    const steps = item.analysis.steps.slice(0, 6);
    return `<article class="idea-card" style="animation-delay:${Math.min(index * 60, 360)}ms" data-card="${esc(item.id)}">
      <div class="card-visual ${cover ? "" : "no-cover"}">${cover ? `<img src="${esc(cover)}" alt="${esc(item.title)}封面" />` : `<span class="domain-mark">${esc(hostLabel(url))}</span>`}<span class="platform-pill">${esc(item.platform || "来源待补")}</span>${item.copyScore ? `<span class="score-stamp">${item.copyScore}<small>/5</small></span>` : ""}</div>
      <div class="card-content"><div class="card-source">${esc(item.type || "REFERENCE")} · ${new Date(item.createdAt).toLocaleDateString("zh-CN")}</div><h3>${esc(item.title)}</h3>${item.creator ? `<div class="creator">by ${esc(item.creator)}</div>` : ""}
      ${item.note ? `<blockquote class="personal-note">“${esc(item.note)}”</blockquote>` : ""}
      ${analyzed(item) ? `${item.analysis.highlights ? `<section class="analysis-block"><h4><b>1</b> 内容亮点</h4><p>${esc(item.analysis.highlights)}</p></section>` : ""}${item.analysis.reproducibility ? `<section class="analysis-block"><h4><b>2</b> 可复制性</h4><p>${esc(item.analysis.reproducibility)}</p></section>` : ""}${steps.length ? `<section class="analysis-block"><h4><b>3</b> 制作步骤</h4><ol class="step-list">${steps.map(step => `<li>${esc(step)}</li>`).join("")}</ol></section>` : ""}` : `<div class="pending-analysis">还没有拆解。让 AI 帮你从“喜欢”走到“会做”。</div>`}
      ${item.tags.length ? `<div class="card-tags">${item.tags.map(tag => `<span># ${esc(tag)}</span>`).join("")}</div>` : ""}
      <div class="card-footer">${url ? `<a class="source-link" href="${esc(url)}" target="_blank" rel="noopener">查看原作 ↗</a>` : `<span></span>`}<div class="card-actions"><button class="text-button" data-analyze="${esc(item.id)}">AI 分析</button><button class="text-button" data-edit="${esc(item.id)}">编辑</button><button class="text-button danger" data-delete="${esc(item.id)}">删除</button></div></div></div>
    </article>`;
  }
  function render(){
    renderStats(); renderPlatforms();
    const all = inspirations(), list = filteredItems();
    $("#emptyState").hidden = all.length !== 0;
    $("#inspirationGrid").innerHTML = list.map(cardHTML).join("");
    if(all.length && !list.length) $("#inspirationGrid").innerHTML = `<div class="empty-state" style="grid-column:1/-1"><h3>没有符合筛选的灵感</h3><p>换一个关键词或清除筛选试试。</p></div>`;
    const configured = Boolean(getAIConfig()); $("#aiConfigLabel").textContent = configured ? "AI 已配置" : "配置 AI";
    if(!hasCloud()) setSyncState("offline");
  }

  function setValue(id, value){ $(id).value = value ?? ""; }
  function renderCover(){
    $("#coverPreview").innerHTML = pendingCover?.dataUrl ? `<div class="preview-wrap"><img src="${esc(pendingCover.dataUrl)}" alt="封面预览" /><button class="remove-cover" type="button" id="removeCoverBtn" aria-label="移除封面">×</button></div>` : "";
  }
  function openEditor(id=""){
    const item = inspirations().map(normalizeItem).find(entry => entry.id === id);
    editingId = item?.id || ""; pendingCover = item?.cover ? clone(item.cover) : null;
    $("#editorTitle").textContent = item ? "编辑灵感卡" : "收下一份灵感"; setValue("#itemId", editingId); setValue("#itemUrl", item?.url); setValue("#itemTitle", item?.title === "未命名灵感" ? "" : item?.title); setValue("#itemCreator", item?.creator); setValue("#itemPlatform", item?.platform); setValue("#itemType", item?.type); setValue("#itemNote", item?.note); setValue("#itemHighlights", item?.analysis.highlights); setValue("#itemReproducibility", item?.analysis.reproducibility); setValue("#itemSteps", item?.analysis.steps.join("\n")); setValue("#itemScore", item?.copyScore || 0); setValue("#itemTags", item?.tags.join(", "));
    renderCover(); $("#analysisHint").textContent = "AI 不会自动浏览受限页面。标题和你的观察越具体，分析越准确。"; $("#editorDialog").showModal(); $("#itemUrl").focus();
  }
  function formItem(){
    const previous = inspirations().map(normalizeItem).find(item => item.id === editingId);
    const url = $("#itemUrl").value.trim();
    const platform = $("#itemPlatform").value.trim() || platformFromUrl(url);
    const title = $("#itemTitle").value.trim() || `${platform || hostLabel(url)} 灵感`;
    return normalizeItem({id:editingId || uid("idea"), url, title, creator:$("#itemCreator").value.trim(), platform, type:$("#itemType").value.trim(), note:$("#itemNote").value.trim(), cover:pendingCover,
      analysis:{highlights:$("#itemHighlights").value.trim(), reproducibility:$("#itemReproducibility").value.trim(), steps:$("#itemSteps").value.split(/\n+/).map(value => value.trim()).filter(Boolean)}, copyScore:Number($("#itemScore").value), tags:$("#itemTags").value.split(/[,，]/).map(value => value.trim()).filter(Boolean), createdAt:previous?.createdAt, updatedAt:new Date().toISOString()});
  }
  function saveItem(event){
    event.preventDefault(); const item = formItem(); if(!item.url) return;
    const list = inspirations(), index = list.findIndex(entry => entry.id === item.id); if(index >= 0) list[index] = item; else list.unshift(item);
    try { persist(); } catch(error){ alert(error.message); return; }
    $("#editorDialog").close(); render(); toast(index >= 0 ? "灵感卡已更新" : "灵感卡已收藏");
  }

  function imageData(file){
    return new Promise((resolve, reject) => {
      if(!file?.type?.startsWith("image/")) return reject(new Error("请选择图片文件"));
      const reader = new FileReader(); reader.onerror = () => reject(new Error("图片读取失败"));
      reader.onload = () => { const image = new Image(); image.onerror = () => reject(new Error("无法识别图片")); image.onload = () => { const scale = Math.min(1, 1300 / image.width); const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale)); canvas.getContext("2d").drawImage(image,0,0,canvas.width,canvas.height); let quality=.82, dataUrl=canvas.toDataURL("image/webp",quality); while(dataUrl.length>230000 && quality>.35){ quality-=.1; dataUrl=canvas.toDataURL("image/webp",quality); } resolve({name:file.name || "粘贴封面", dataUrl}); }; image.src = reader.result; }; reader.readAsDataURL(file);
    });
  }
  async function setCover(file){ try { pendingCover = await imageData(file); renderCover(); toast("封面已加入，保存卡片后生效"); } catch(error){ alert(error.message); } }

  function getAIConfig(){ const value = readJSON(AI_KEY,null); return value?.endpoint && value?.model && value?.apiKey ? value : null; }
  function completionUrl(endpoint){ const clean=endpoint.trim().replace(/\/+$/,""); return /\/chat\/completions$/i.test(clean) ? clean : `${clean}/chat/completions`; }
  function isDeepSeekV4(config){ try { const host=new URL(config.endpoint).hostname.toLowerCase(); return (host==="api.deepseek.com"||host.endsWith(".deepseek.com")) && /^deepseek-v4-/i.test(config.model); } catch(error){ return false; } }
  async function callAI(system, user){
    const config=getAIConfig(); if(!config) throw new Error("请先配置 AI 模型");
    const body={model:config.model,temperature:.25,max_tokens:1800,stream:false,messages:[{role:"system",content:system},{role:"user",content:user}]}; if(isDeepSeekV4(config)) body.thinking={type:"disabled"};
    let response; try { response=await fetch(completionUrl(config.endpoint),{method:"POST",headers:{Authorization:`Bearer ${config.apiKey}`,"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify(body)}); } catch(error){ throw new Error("浏览器无法连接模型。请检查网络、API 地址或跨域权限。"); }
    const raw=await response.text(); if(!response.ok) throw new Error(`模型请求失败（${response.status}）：${raw.slice(0,160)}`); let payload; try { payload=JSON.parse(raw); } catch(error){ throw new Error("模型返回了无法识别的数据"); } const content=payload?.choices?.[0]?.message?.content; if(!content) throw new Error("模型没有返回内容"); return content.trim();
  }
  function parseAIJson(text){ const cleaned=text.replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/i,"").trim(); try{return JSON.parse(cleaned);}catch(error){const start=cleaned.indexOf("{"),end=cleaned.lastIndexOf("}");if(start>=0&&end>start)return JSON.parse(cleaned.slice(start,end+1));throw new Error("AI 返回格式不正确，请重试");} }
  async function analyzeForm(){
    if(!getAIConfig()){ openAISettings("请先配置模型，再进行灵感拆解。"); return; }
    const url=$("#itemUrl").value.trim();
    const title=$("#itemTitle").value.trim() || `${$("#itemPlatform").value.trim() || platformFromUrl(url) || hostLabel(url)} 灵感`;
    const note=$("#itemNote").value.trim(); if(!url) return toast("请先粘贴作品链接");
    const button=$("#analyzeBtn"); button.disabled=true; button.textContent="AI 正在拆解…"; $("#analysisHint").textContent="正在识别亮点、依赖条件和最小复刻路径…";
    try {
      const system="你是创意作品拆解教练。你的任务不是空泛夸奖，而是帮助个人创作者理解一件参考作品为什么有效、哪些部分可以转化为自己的方法，并拆成低门槛的实际制作步骤。不能访问链接时必须基于用户提供的信息分析，不要假装看过页面。只返回 JSON。";
      const prompt=`参考作品：${JSON.stringify({url,title,creator:$("#itemCreator").value.trim(),platform:$("#itemPlatform").value.trim(),type:$("#itemType").value.trim(),userObservation:note})}\n只返回：{"highlights":"80-160字，分析内容或体验亮点","reproducibility":"80-160字，说明可复制部分、依赖条件和差异化建议","copyScore":1到5的整数,"steps":["4到8个具体步骤"],"tags":["2到5个短标签"]}`;
      const result=parseAIJson(await callAI(system,prompt)); $("#itemHighlights").value=String(result.highlights||""); $("#itemReproducibility").value=String(result.reproducibility||""); $("#itemSteps").value=(Array.isArray(result.steps)?result.steps:[]).join("\n"); $("#itemScore").value=String(Math.max(1,Math.min(5,Number(result.copyScore)||3))); $("#itemTags").value=(Array.isArray(result.tags)?result.tags:[]).join(", "); $("#analysisHint").textContent="分析已生成。你可以先修改，再保存到卡片。"; toast("AI 拆解完成");
    } catch(error){ $("#analysisHint").textContent=error.message; toast(error.message); }
    finally { button.disabled=false; button.textContent="✦ AI 一键分析"; }
  }

  function openAISettings(message=""){
    const config=getAIConfig()||{endpoint:"https://api.deepseek.com/v1",model:"deepseek-chat",apiKey:""}; setValue("#aiEndpoint",config.endpoint); setValue("#aiModel",config.model); setValue("#aiKey",config.apiKey); $("#aiMessage").textContent=message; $("#aiMessage").classList.remove("error"); $("#aiDialog").showModal();
  }
  function readAIForm(){ const config={endpoint:$("#aiEndpoint").value.trim().replace(/\/+$/, ""),model:$("#aiModel").value.trim(),apiKey:$("#aiKey").value.trim()}; if(!/^https:\/\//i.test(config.endpoint)||!config.model||!config.apiKey) throw new Error("请完整填写 API 地址、模型名称和 API Key"); return config; }
  async function testAI(){
    const previous=localStorage.getItem(AI_KEY); try { localStorage.setItem(AI_KEY,JSON.stringify(readAIForm())); $("#aiMessage").textContent="正在测试连接…"; const reply=await callAI("你是连接测试助手。","只回复 OK"); $("#aiMessage").textContent=`连接成功：${reply.slice(0,40)}`; $("#aiMessage").classList.remove("error"); } catch(error){ if(previous)localStorage.setItem(AI_KEY,previous);else localStorage.removeItem(AI_KEY); $("#aiMessage").textContent=error.message; $("#aiMessage").classList.add("error"); }
  }

  $("#addInspirationBtn").addEventListener("click",()=>openEditor()); $$('[data-open-editor]').forEach(button=>button.addEventListener("click",()=>openEditor())); $$('[data-close-editor]').forEach(button=>button.addEventListener("click",()=>$("#editorDialog").close())); $("#inspirationForm").addEventListener("submit",saveItem);
  $("#itemUrl").addEventListener("blur",()=>{ if(!$("#itemPlatform").value)$("#itemPlatform").value=platformFromUrl($("#itemUrl").value); });
  $("#chooseCoverBtn").addEventListener("click",()=>$("#coverInput").click()); $("#coverInput").addEventListener("change",event=>{ if(event.target.files[0])setCover(event.target.files[0]); event.target.value=""; });
  $("#coverZone").addEventListener("paste",event=>{ const file=[...(event.clipboardData?.items||[])].find(item=>item.type?.startsWith("image/"))?.getAsFile(); if(file){event.preventDefault();setCover(file);} }); $("#coverZone").addEventListener("focus",event=>event.currentTarget.classList.add("active")); $("#coverZone").addEventListener("blur",event=>event.currentTarget.classList.remove("active")); $("#coverPreview").addEventListener("click",event=>{ if(event.target.closest("#removeCoverBtn")){pendingCover=null;renderCover();} });
  $("#analyzeBtn").addEventListener("click",analyzeForm);
  $("#inspirationGrid").addEventListener("click",event=>{ const edit=event.target.closest("[data-edit]"); if(edit)return openEditor(edit.dataset.edit); const analyze=event.target.closest("[data-analyze]"); if(analyze){openEditor(analyze.dataset.analyze);setTimeout(analyzeForm,0);return;} const del=event.target.closest("[data-delete]"); if(del&&confirm("确定删除这张灵感卡吗？")){replaceInspirations(inspirations().filter(item=>item.id!==del.dataset.delete));persist();render();toast("灵感卡已删除");} });
  ["searchInput","platformFilter","analysisFilter","scoreFilter"].forEach(id=>$("#"+id).addEventListener(id==="searchInput"?"input":"change",render));
  $("#aiConfigBtn").addEventListener("click",()=>openAISettings()); $$('[data-close-ai]').forEach(button=>button.addEventListener("click",()=>$("#aiDialog").close())); $("#aiForm").addEventListener("submit",event=>{event.preventDefault();try{localStorage.setItem(AI_KEY,JSON.stringify(readAIForm()));$("#aiDialog").close();render();toast("AI 配置已保存");}catch(error){$("#aiMessage").textContent=error.message;$("#aiMessage").classList.add("error");}}); $("#testAiBtn").addEventListener("click",testAI); $("#clearAiBtn").addEventListener("click",()=>{localStorage.removeItem(AI_KEY);$("#aiDialog").close();render();toast("AI 配置已清除");});
  $("#refreshCloudBtn").addEventListener("click",async()=>{ if(!hasCloud())return toast("请先在项目看板中配置云同步"); await pullCloud(); toast("灵感库已从云端刷新"); });

  cleanLegacyDetachedBoard(); render(); if(hasCloud()) pullCloud();
})();
