(() => {
  "use strict";
  const DATA_KEY = "ai_project_portfolio_kanban_v2";
  const CLOUD_KEY = "ai_project_portfolio_cloud_config_v1";
  const AI_KEY = "ai_project_portfolio_ai_config_v1";
  const LOCAL_BOARD_KEY = "ai_project_inspiration_board_v1";
  const BOARD_ID = "__INSPIRATION_BOARD__";
  const MAX_JSON_CHARS = 3_800_000;
  const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
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
  let pendingVideo = null;
  let pendingVideoFile = null;
  let removedVideoPath = "";
  let pendingAnalysisModel = "";
  let pendingAnalyzedAt = "";
  let pendingAnalysisSource = "";
  let cloudTimer = null;

  function readJSON(key, fallback){
    try { const value = JSON.parse(localStorage.getItem(key)); return value ?? fallback; }
    catch(error){ return fallback; }
  }
  function safeArray(value){ return Array.isArray(value) ? value.map(item => String(item ?? "").trim()).filter(Boolean) : String(value || "").split(/\n+/).map(item => item.trim()).filter(Boolean); }
  function normalizeTimeline(value){
    if(!Array.isArray(value)) value = parseTimeline(String(value || ""));
    return value.map(entry => typeof entry === "string" ? parseTimelineLine(entry) : ({time:String(entry?.time || ""), title:String(entry?.title || entry?.detail || ""), detail:String(entry?.detail || "")})).filter(entry => entry.time || entry.title || entry.detail);
  }
  function parseTimelineLine(line){
    const parts = String(line).split(/[｜|]/); return {time:(parts.shift() || "").trim(), title:(parts.shift() || "").trim(), detail:parts.join("｜").trim()};
  }
  function parseTimeline(value){ return String(value || "").split(/\n+/).map(line => line.trim()).filter(Boolean).map(parseTimelineLine); }
  function timelineText(value){ return normalizeTimeline(value).map(entry => [entry.time,entry.title,entry.detail].filter(Boolean).join("｜")).join("\n"); }

  function hasRealProjects(){ return data.some(item => item?.status !== "__system__"); }
  function boardRecord({create=true}={}){
    let record = data.find(item => item?.id === BOARD_ID);
    if(!record && create && hasRealProjects()){
      record = {id:BOARD_ID,name:"灵感研究所数据",status:"__system__",result:"__system__",inspirations:[],updatedAt:new Date().toISOString()};
      data.push(record);
    }
    if(!record) return null;
    if(!Array.isArray(record.inspirations)) record.inspirations = [];
    return record;
  }
  function inspirations(){ return boardRecord({create:false})?.inspirations || detachedInspirations; }
  function replaceInspirations(list){ const record=boardRecord(); if(record)record.inspirations=list;else detachedInspirations=list; }
  function migrateDetached(){
    if(!hasRealProjects() || !detachedInspirations.length) return;
    const record=boardRecord(), merged=new Map(record.inspirations.map(item=>[item.id,item]));
    detachedInspirations.forEach(item=>merged.set(item.id,item)); record.inspirations=[...merged.values()]; detachedInspirations=[]; localStorage.removeItem(LOCAL_BOARD_KEY);
  }
  function cleanLegacyDetachedBoard(){
    if(hasRealProjects()) return;
    const record=boardRecord({create:false});
    if(record?.inspirations?.length){const merged=new Map(detachedInspirations.map(item=>[item.id,item]));record.inspirations.forEach(item=>merged.set(item.id,item));detachedInspirations=[...merged.values()];}
    data=data.filter(item=>item?.id!==BOARD_ID); localStorage.removeItem(DATA_KEY); if(detachedInspirations.length)localStorage.setItem(LOCAL_BOARD_KEY,JSON.stringify(detachedInspirations));
  }

  function safeUrl(value){ try {const url=new URL(value);return ["http:","https:"].includes(url.protocol)?url.href:"";} catch(error){return "";} }
  function hostLabel(value){ try{return new URL(value).hostname.replace(/^www\./,"");}catch(error){return "REFERENCE";} }
  function platformFromUrl(value){
    const host=hostLabel(value).toLowerCase();
    if(host.includes("xiaohongshu")||host.includes("xhslink"))return "小红书";if(host.includes("bilibili")||host==="b23.tv")return "Bilibili";if(host.includes("youtube")||host==="youtu.be")return "YouTube";if(host.includes("douyin"))return "抖音";if(host.includes("github"))return "GitHub";if(host.includes("instagram"))return "Instagram";if(host.includes("pinterest")||host.includes("pin.it"))return "Pinterest";if(host.includes("weixin.qq.com"))return "公众号";return host==="REFERENCE"?"":"网站";
  }
  function supportsLinkAnalysis(value){
    try{const host=new URL(value).hostname.toLowerCase();return host==="xiaohongshu.com"||host.endsWith(".xiaohongshu.com")||host==="xhslink.com"||host.endsWith(".xhslink.com");}catch(error){return false;}
  }
  function normalizeItem(raw={}){
    const video = raw.video && (raw.video.path || raw.video.url) ? {path:String(raw.video.path||""),url:safeUrl(raw.video.url),name:String(raw.video.name||""),type:String(raw.video.type||"video/mp4"),size:Number(raw.video.size)||0,uploadedAt:raw.video.uploadedAt||""} : null;
    return {id:raw.id||uid("idea"),url:safeUrl(raw.url),title:String(raw.title||"未命名灵感"),creator:String(raw.creator||""),platform:String(raw.platform||platformFromUrl(raw.url)),type:String(raw.type||""),note:String(raw.note||""),cover:raw.cover||null,video,
      analysis:{highlights:String(raw.analysis?.highlights||""),timeline:normalizeTimeline(raw.analysis?.timeline),structure:String(raw.analysis?.structure||""),audiovisual:String(raw.analysis?.audiovisual||""),reproducibility:String(raw.analysis?.reproducibility||""),steps:safeArray(raw.analysis?.steps),evidence:safeArray(raw.analysis?.evidence),model:String(raw.analysis?.model||""),source:String(raw.analysis?.source||""),analyzedAt:raw.analysis?.analyzedAt||""},
      copyScore:Math.max(0,Math.min(5,Number(raw.copyScore)||0)),tags:Array.isArray(raw.tags)?raw.tags:[],createdAt:raw.createdAt||new Date().toISOString(),updatedAt:raw.updatedAt||new Date().toISOString()};
  }

  function hasCloud(){ return Boolean(cloudConfig?.url&&cloudConfig?.anonKey&&cloudConfig?.spaceId); }
  function cloudBase(){ return cloudConfig.url.replace(/\/+$/,"")+"/rest/v1"; }
  function cloudHeaders(){ return {apikey:cloudConfig.anonKey,Authorization:`Bearer ${cloudConfig.anonKey}`,"Content-Type":"application/json"}; }
  function setSyncState(state,label){const el=$("#syncState");el.dataset.state=state;el.querySelector("span").textContent=label||({offline:"本地灵感",pending:"正在同步",synced:"云端已同步",error:"同步失败"}[state]);}
  async function uploadCloud(){
    if(!hasCloud()||!hasRealProjects())return setSyncState("offline");setSyncState("pending");
    try{const response=await fetch(`${cloudBase()}/rpc/portfolio_save`,{method:"POST",headers:cloudHeaders(),body:JSON.stringify({p_access_key:cloudConfig.spaceId,p_projects:data})});if(!response.ok)throw new Error(`${response.status} ${await response.text()}`);setSyncState("synced");}
    catch(error){console.error("灵感资料同步失败",error);setSyncState("error");toast("已保存在当前浏览器，但云端同步失败");}
  }
  function queueCloud(){if(!hasCloud()||!hasRealProjects())return setSyncState("offline");setSyncState("pending");clearTimeout(cloudTimer);cloudTimer=setTimeout(uploadCloud,650);}
  function persist({cloud=true}={}){
    if(!hasRealProjects()){cleanLegacyDetachedBoard();localStorage.setItem(LOCAL_BOARD_KEY,JSON.stringify(detachedInspirations));setSyncState("offline");return;}
    migrateDetached();boardRecord().updatedAt=new Date().toISOString();const serialized=JSON.stringify(data);if(serialized.length>MAX_JSON_CHARS)throw new Error("图片总量过大，请删除部分封面后再保存。");localStorage.setItem(DATA_KEY,serialized);if(cloud)queueCloud();
  }
  async function pullCloud(){
    if(!hasCloud()){setSyncState("offline");return false;}setSyncState("pending","读取云端");
    try{const response=await fetch(`${cloudBase()}/rpc/portfolio_load`,{method:"POST",headers:cloudHeaders(),body:JSON.stringify({p_access_key:cloudConfig.spaceId})});if(!response.ok)throw new Error(`${response.status} ${await response.text()}`);const rows=await response.json();if(rows.length&&Array.isArray(rows[0].projects))data=rows[0].projects;migrateDetached();if(hasRealProjects())localStorage.setItem(DATA_KEY,JSON.stringify(data));else cleanLegacyDetachedBoard();setSyncState("synced");render();return true;}
    catch(error){console.error("灵感资料读取失败",error);setSyncState("error");toast("云端读取失败，正在显示本机资料");return false;}
  }

  function toast(message){const el=$("#toast");el.textContent=message;el.classList.add("show");clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.classList.remove("show"),3000);}
  function analyzed(item){return Boolean(item.analysis.highlights||item.analysis.timeline.length||item.analysis.reproducibility||item.analysis.steps.length);}
  function filteredItems(){
    const query=$("#searchInput").value.trim().toLowerCase(),platform=$("#platformFilter").value,state=$("#analysisFilter").value,score=Number($("#scoreFilter").value||0);
    return inspirations().map(normalizeItem).filter(item=>{const timeline=item.analysis.timeline.flatMap(entry=>[entry.time,entry.title,entry.detail]);const hay=[item.title,item.creator,item.platform,item.type,item.note,item.analysis.highlights,item.analysis.structure,item.analysis.audiovisual,item.analysis.reproducibility,...timeline,...item.analysis.steps,...item.analysis.evidence,...item.tags].join(" ").toLowerCase();const scoreMatch=!score||(score===4?item.copyScore>=4:score===3?item.copyScore===3:item.copyScore>0&&item.copyScore<=2);return(!query||hay.includes(query))&&(!platform||item.platform===platform)&&(!state||(state==="analyzed")===analyzed(item))&&scoreMatch;}).sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
  function renderStats(){const list=inspirations().map(normalizeItem);$("#totalCount").textContent=list.length;$("#analyzedCount").textContent=list.filter(analyzed).length;$("#reproCount").textContent=list.filter(item=>item.copyScore>=4).length;$("#platformCount").textContent=new Set(list.map(item=>item.platform).filter(Boolean)).size;}
  function renderPlatforms(){const select=$("#platformFilter"),current=select.value,values=[...new Set(inspirations().map(item=>normalizeItem(item).platform).filter(Boolean))].sort();select.innerHTML=`<option value="">全部平台</option>${values.map(value=>`<option value="${esc(value)}">${esc(value)}</option>`).join("")}`;select.value=values.includes(current)?current:"";}
  function timelineHTML(timeline){return timeline.slice(0,6).map(entry=>`<li><time>${esc(entry.time||"—")}</time><span><strong>${esc(entry.title)}</strong>${entry.detail?`<br>${esc(entry.detail)}`:""}</span></li>`).join("");}
  function cardHTML(item,index){
    const url=safeUrl(item.url),cover=item.cover?.dataUrl,steps=item.analysis.steps.slice(0,6),hasVideo=Boolean(item.video?.path||item.video?.url),canLink=supportsLinkAnalysis(url);
    return `<article class="idea-card" style="animation-delay:${Math.min(index*60,360)}ms" data-card="${esc(item.id)}"><div class="card-visual ${cover?"":"no-cover"}">${cover?`<img src="${esc(cover)}" alt="${esc(item.title)}封面" />`:`<span class="domain-mark">${esc(hostLabel(url))}</span>`}<span class="platform-pill">${esc(item.platform||"来源待补")}</span>${item.copyScore?`<span class="score-stamp">${item.copyScore}<small>/5</small></span>`:""}</div><div class="card-content"><div class="card-source">${esc(item.type||"REFERENCE")} · ${new Date(item.createdAt).toLocaleDateString("zh-CN")}</div><h3>${esc(item.title)}</h3>${item.creator?`<div class="creator">by ${esc(item.creator)}</div>`:""}${item.analysis.source?`<span class="analysis-source-badge">✦ ${esc(item.analysis.source)}${item.analysis.model?` · ${esc(item.analysis.model)}`:""}</span>`:hasVideo?`<span class="video-badge">▶ 已连接视频素材</span>`:""}${item.note?`<blockquote class="personal-note">“${esc(item.note)}”</blockquote>`:""}
      ${analyzed(item)?`${item.analysis.highlights?`<section class="analysis-block"><h4><b>1</b> 内容亮点</h4><p>${esc(item.analysis.highlights)}</p></section>`:""}${item.analysis.timeline.length?`<section class="analysis-block"><h4><b>2</b> 逐段时间轴</h4><ol class="timeline-list">${timelineHTML(item.analysis.timeline)}</ol></section>`:""}${item.analysis.structure?`<section class="analysis-block compact"><details><summary>内容结构</summary><p>${esc(item.analysis.structure)}</p></details></section>`:""}${item.analysis.audiovisual?`<section class="analysis-block compact"><details><summary>画面与声音配合</summary><p>${esc(item.analysis.audiovisual)}</p></details></section>`:""}${item.analysis.reproducibility?`<section class="analysis-block"><h4><b>3</b> 可复制性</h4><p>${esc(item.analysis.reproducibility)}</p></section>`:""}${steps.length?`<section class="analysis-block"><h4><b>4</b> 制作步骤</h4><ol class="step-list">${steps.map(step=>`<li>${esc(step)}</li>`).join("")}</ol></section>`:""}${item.analysis.evidence.length?`<section class="analysis-block compact"><details><summary>查看分析依据</summary><ul class="evidence-list">${item.analysis.evidence.map(entry=>`<li>${esc(entry)}</li>`).join("")}</ul></details></section>`:""}`:`<div class="pending-analysis">还没有拆解。${hasVideo||canLink?"让 Qwen-Omni 读取原作品，再给你结论。":"当前平台暂不支持链接实读，可改用上传素材。"}</div>`}
      ${item.tags.length?`<div class="card-tags">${item.tags.map(tag=>`<span># ${esc(tag)}</span>`).join("")}</div>`:""}<div class="card-footer">${url?`<a class="source-link" href="${esc(url)}" target="_blank" rel="noopener">查看原作 ↗</a>`:"<span></span>"}<div class="card-actions"><button class="text-button" data-analyze="${esc(item.id)}">${hasVideo||canLink?"深度分析":"文本分析"}</button><button class="text-button" data-edit="${esc(item.id)}">编辑</button><button class="text-button danger" data-delete="${esc(item.id)}">删除</button></div></div></div></article>`;
  }
  function render(){renderStats();renderPlatforms();const all=inspirations(),list=filteredItems();$("#emptyState").hidden=all.length!==0;$("#inspirationGrid").innerHTML=list.map(cardHTML).join("");if(all.length&&!list.length)$("#inspirationGrid").innerHTML=`<div class="empty-state" style="grid-column:1/-1"><h3>没有符合筛选的灵感</h3><p>换一个关键词或清除筛选试试。</p></div>`;const configured=Boolean(getAIConfig());$("#aiConfigLabel").textContent=configured?"文本 AI 已配置":"配置文本 AI";if(!hasCloud())setSyncState("offline");}

  function setValue(id,value){$(id).value=value??"";}
  function renderCover(){$("#coverPreview").innerHTML=pendingCover?.dataUrl?`<div class="preview-wrap"><img src="${esc(pendingCover.dataUrl)}" alt="封面预览" /><button class="remove-cover" type="button" id="removeCoverBtn" aria-label="移除封面">×</button></div>`:"";}
  function formatBytes(bytes){if(!bytes)return "";const units=["B","KB","MB","GB"];let value=bytes,index=0;while(value>=1024&&index<units.length-1){value/=1024;index++;}return `${value.toFixed(index?1:0)} ${units[index]}`;}
  function renderVideo(){
    const status=$("#videoStatus"),meta=$("#videoMeta"),remove=$("#removeVideoBtn");
    if(pendingVideoFile){status.textContent=pendingVideoFile.name;meta.textContent=`待上传 · ${formatBytes(pendingVideoFile.size)} · 保存或分析时自动上传`;remove.hidden=false;updateAnalysisMode();return;}
    if(pendingVideo?.path){status.textContent=pendingVideo.name||"已上传视频";meta.textContent=`Supabase 私密存储${pendingVideo.size?` · ${formatBytes(pendingVideo.size)}`:""}`;remove.hidden=false;updateAnalysisMode();return;}
    if(supportsLinkAnalysis($("#itemUrl").value)){status.textContent="链接可自动解析";meta.textContent="无需下载：分析时自动读取原视频或图集";remove.hidden=true;updateAnalysisMode();return;}
    status.textContent="选择视频文件（备用）";meta.textContent="当前链接无法自动解析时，可上传 MP4 / MOV / WebM";remove.hidden=true;updateAnalysisMode();
  }
  function updateAnalysisMode(){const button=$("#analyzeBtn");if(!button)return;const hasVideo=Boolean(pendingVideoFile||pendingVideo?.path||safeUrl($("#itemVideoUrl").value.trim()));button.textContent=hasVideo?"✦ 视频深度分析":supportsLinkAnalysis($("#itemUrl").value)?"✦ 解析链接并深度分析":"✦ 文本辅助分析";}
  function setOmniState(text,state=""){$("#omniState").textContent=text;$("#omniState").className=state;}
  function openEditor(id=""){
    const item=inspirations().map(normalizeItem).find(entry=>entry.id===id);editingId=item?.id||"";pendingCover=item?.cover?clone(item.cover):null;pendingVideo=item?.video?clone(item.video):null;pendingVideoFile=null;removedVideoPath="";pendingAnalysisModel=item?.analysis.model||"";pendingAnalyzedAt=item?.analysis.analyzedAt||"";pendingAnalysisSource=item?.analysis.source||"";
    $("#editorTitle").textContent=item?"编辑灵感卡":"收下一份灵感";setValue("#itemId",editingId);setValue("#itemUrl",item?.url);setValue("#itemTitle",item?.title==="未命名灵感"?"":item?.title);setValue("#itemCreator",item?.creator);setValue("#itemPlatform",item?.platform);setValue("#itemType",item?.type);setValue("#itemNote",item?.note);setValue("#itemVideoUrl",item?.video?.url);setValue("#itemHighlights",item?.analysis.highlights);setValue("#itemTimeline",timelineText(item?.analysis.timeline));setValue("#itemStructure",item?.analysis.structure);setValue("#itemAudiovisual",item?.analysis.audiovisual);setValue("#itemReproducibility",item?.analysis.reproducibility);setValue("#itemSteps",item?.analysis.steps.join("\n"));setValue("#itemEvidence",item?.analysis.evidence.join("\n"));setValue("#itemScore",item?.copyScore||0);setValue("#itemTags",item?.tags.join(", "));
    renderCover();renderVideo();$("#analysisHint").textContent=supportsLinkAnalysis(item?.url)?"点击分析后，系统会自动读取小红书原视频或图集，无需手动下载。":"先粘贴作品链接；支持的平台会自动解析，上传素材仅作备用。";setOmniState(hasCloud()?"正在检测 Qwen-Omni 服务…":"请先在项目看板配置云同步");$("#editorDialog").showModal();$("#itemUrl").focus();if(hasCloud())checkOmniService();
  }
  function formItem(){
    const previous=inspirations().map(normalizeItem).find(item=>item.id===editingId),url=$("#itemUrl").value.trim(),platform=$("#itemPlatform").value.trim()||platformFromUrl(url),title=$("#itemTitle").value.trim()||`${platform||hostLabel(url)} 灵感`,directVideo=safeUrl($("#itemVideoUrl").value.trim());
    const video=(pendingVideo?.path||directVideo)?{...(pendingVideo||{}),url:directVideo}:null;
    return normalizeItem({id:editingId||uid("idea"),url,title,creator:$("#itemCreator").value.trim(),platform,type:$("#itemType").value.trim(),note:$("#itemNote").value.trim(),cover:pendingCover,video,analysis:{highlights:$("#itemHighlights").value.trim(),timeline:parseTimeline($("#itemTimeline").value),structure:$("#itemStructure").value.trim(),audiovisual:$("#itemAudiovisual").value.trim(),reproducibility:$("#itemReproducibility").value.trim(),steps:safeArray($("#itemSteps").value),evidence:safeArray($("#itemEvidence").value),model:pendingAnalysisModel||previous?.analysis.model,source:pendingAnalysisSource||previous?.analysis.source,analyzedAt:pendingAnalyzedAt||previous?.analysis.analyzedAt},copyScore:Number($("#itemScore").value),tags:$("#itemTags").value.split(/[,，]/).map(value=>value.trim()).filter(Boolean),createdAt:previous?.createdAt,updatedAt:new Date().toISOString()});
  }

  function videoServiceUrl(){return `${cloudConfig.url.replace(/\/+$/,"")}/functions/v1/inspiration-video`;}
  async function callVideoService(action,payload={}){
    if(!hasCloud())throw new Error("请先在项目看板中配置云同步");
    const response=await fetch(videoServiceUrl(),{method:"POST",headers:{apikey:cloudConfig.anonKey,"Content-Type":"application/json"},body:JSON.stringify({action,accessKey:cloudConfig.spaceId,...payload})});
    const raw=await response.text();let result;try{result=JSON.parse(raw);}catch(error){result={error:raw};}if(!response.ok)throw new Error(result.error||`视频服务请求失败（${response.status}）`);return result;
  }
  async function checkOmniService(){try{const result=await callVideoService("ping");if(!result.configured)throw new Error("Qwen-Omni 密钥尚未配置");setOmniState(`${result.model||"Qwen-Omni"} 已就绪`,"ready");return true;}catch(error){setOmniState(error.message,"error");return false;}}
  function uploadWithProgress(signedUrl,file){
    return new Promise((resolve,reject)=>{const progress=$("#uploadProgress"),bar=progress.querySelector("i"),label=progress.querySelector("span");progress.hidden=false;bar.style.width="2%";label.textContent="开始上传视频…";const xhr=new XMLHttpRequest();xhr.open("PUT",signedUrl);xhr.setRequestHeader("Content-Type",file.type||"video/mp4");xhr.upload.onprogress=event=>{if(!event.lengthComputable)return;const value=Math.max(2,Math.round(event.loaded/event.total*100));bar.style.width=`${value}%`;label.textContent=`正在上传 ${value}%`;};xhr.onload=()=>{if(xhr.status>=200&&xhr.status<300){bar.style.width="100%";label.textContent="视频上传完成";setTimeout(()=>{progress.hidden=true;},700);resolve();}else reject(new Error(`视频上传失败（${xhr.status}）`));};xhr.onerror=()=>reject(new Error("视频上传中断，请检查网络"));xhr.send(file);});
  }
  async function uploadSelectedVideo(){
    if(!pendingVideoFile)return pendingVideo;if(!hasCloud())throw new Error("上传视频前，请先在项目看板中配置云同步");
    const file=pendingVideoFile,created=await callVideoService("create-upload",{fileName:file.name,contentType:file.type||"video/mp4",fileSize:file.size});await uploadWithProgress(created.signedUrl,file);pendingVideo={path:created.path,name:file.name,type:file.type||"video/mp4",size:file.size,uploadedAt:new Date().toISOString(),url:safeUrl($("#itemVideoUrl").value.trim())};pendingVideoFile=null;renderVideo();return pendingVideo;
  }
  async function deleteStoredVideo(path){if(!path||!hasCloud())return;try{await callVideoService("delete",{path});}catch(error){console.warn("视频清理失败",error);}}
  async function saveItem(event){
    event.preventDefault();const submit=event.submitter||$("#inspirationForm button[type='submit']"),oldText=submit.textContent;submit.disabled=true;submit.textContent=pendingVideoFile?"正在上传视频…":"正在保存…";
    try{if(pendingVideoFile)await uploadSelectedVideo();const item=formItem();if(!item.url)throw new Error("请填写原作品链接");const list=inspirations(),index=list.findIndex(entry=>entry.id===item.id);if(index>=0)list[index]=item;else list.unshift(item);persist();if(removedVideoPath&&removedVideoPath!==item.video?.path)deleteStoredVideo(removedVideoPath);$("#editorDialog").close();render();toast(index>=0?"灵感卡已更新":"灵感卡已收藏");}
    catch(error){alert(error.message);}finally{submit.disabled=false;submit.textContent=oldText;}
  }

  function imageData(file){return new Promise((resolve,reject)=>{if(!file?.type?.startsWith("image/"))return reject(new Error("请选择图片文件"));const reader=new FileReader();reader.onerror=()=>reject(new Error("图片读取失败"));reader.onload=()=>{const image=new Image();image.onerror=()=>reject(new Error("无法识别图片"));image.onload=()=>{const scale=Math.min(1,1300/image.width),canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));canvas.getContext("2d").drawImage(image,0,0,canvas.width,canvas.height);let quality=.82,dataUrl=canvas.toDataURL("image/webp",quality);while(dataUrl.length>230000&&quality>.35){quality-=.1;dataUrl=canvas.toDataURL("image/webp",quality);}resolve({name:file.name||"粘贴封面",dataUrl});};image.src=reader.result;};reader.readAsDataURL(file);});}
  async function setCover(file){try{pendingCover=await imageData(file);renderCover();toast("封面已加入，保存卡片后生效");}catch(error){alert(error.message);}}
  function selectVideo(file){if(!file?.type?.startsWith("video/"))return alert("请选择 MP4、MOV 或 WebM 视频文件");if(file.size>MAX_VIDEO_BYTES)return alert("视频超过 500 MB，请压缩后再上传");if(pendingVideo?.path&&!removedVideoPath)removedVideoPath=pendingVideo.path;pendingVideo=null;pendingVideoFile=file;renderVideo();toast("视频已选择，保存或分析时自动上传");}

  function getAIConfig(){const value=readJSON(AI_KEY,null);return value?.endpoint&&value?.model&&value?.apiKey?value:null;}
  function completionUrl(endpoint){const clean=endpoint.trim().replace(/\/+$/,"");return /\/chat\/completions$/i.test(clean)?clean:`${clean}/chat/completions`;}
  function isDeepSeekV4(config){try{const host=new URL(config.endpoint).hostname.toLowerCase();return(host==="api.deepseek.com"||host.endsWith(".deepseek.com"))&&/^deepseek-v4-/i.test(config.model);}catch(error){return false;}}
  async function callAI(system,user){const config=getAIConfig();if(!config)throw new Error("请先配置文本 AI 模型");const body={model:config.model,temperature:.25,max_tokens:2200,stream:false,messages:[{role:"system",content:system},{role:"user",content:user}]};if(isDeepSeekV4(config))body.thinking={type:"disabled"};let response;try{response=await fetch(completionUrl(config.endpoint),{method:"POST",headers:{Authorization:`Bearer ${config.apiKey}`,"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify(body)});}catch(error){throw new Error("浏览器无法连接文本模型，请检查网络或跨域权限");}const raw=await response.text();if(!response.ok)throw new Error(`模型请求失败（${response.status}）：${raw.slice(0,160)}`);let payload;try{payload=JSON.parse(raw);}catch(error){throw new Error("模型返回了无法识别的数据");}const content=payload?.choices?.[0]?.message?.content;if(!content)throw new Error("模型没有返回内容");return content.trim();}
  function parseAIJson(text){const cleaned=String(text).replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/i,"").trim();try{return JSON.parse(cleaned);}catch(error){const start=cleaned.indexOf("{"),end=cleaned.lastIndexOf("}");if(start>=0&&end>start)return JSON.parse(cleaned.slice(start,end+1));throw new Error("AI 返回格式不正确，请重试");}}
  function applyAnalysis(result,model="",source=""){$("#itemHighlights").value=String(result.highlights||result.overview||"");$("#itemTimeline").value=timelineText(result.timeline);$("#itemStructure").value=String(result.structure||"");$("#itemAudiovisual").value=String(result.audiovisual||"");$("#itemReproducibility").value=String(result.reproducibility||"");$("#itemSteps").value=safeArray(result.steps).join("\n");$("#itemEvidence").value=safeArray(result.evidence).join("\n");$("#itemScore").value=String(Math.max(1,Math.min(5,Number(result.copyScore)||3)));$("#itemTags").value=safeArray(result.tags).join(", ");pendingAnalysisModel=model;pendingAnalysisSource=source;pendingAnalyzedAt=new Date().toISOString();}
  async function analyzeMediaForm(){
    if(pendingVideoFile)await uploadSelectedVideo();const directVideo=safeUrl($("#itemVideoUrl").value.trim()),path=pendingVideo?.path,source=$("#itemUrl").value.trim();if(!path&&!directVideo&&!supportsLinkAnalysis(source))throw new Error("当前平台暂不支持链接实读，请改用上传文件");
    const metadata={sourceUrl:source,title:$("#itemTitle").value.trim(),creator:$("#itemCreator").value.trim(),platform:$("#itemPlatform").value.trim(),type:$("#itemType").value.trim(),userObservation:$("#itemNote").value.trim()};const response=await callVideoService("analyze",{path,videoUrl:directVideo,sourceUrl:!path&&!directVideo?source:"",metadata}),resolved=response.resolved||{};
    if(resolved.title&&!$("#itemTitle").value.trim())$("#itemTitle").value=resolved.title;if(resolved.creator&&!$("#itemCreator").value.trim())$("#itemCreator").value=resolved.creator;if(resolved.platform)$("#itemPlatform").value=resolved.platform;if(resolved.mediaType)$("#itemType").value=resolved.mediaType==="video"?"视频":"图集";if(resolved.coverUrl&&!pendingCover){pendingCover={name:"作品封面",dataUrl:resolved.coverUrl};renderCover();}
    applyAnalysis(response.result,response.model,resolved.sourceLabel||"作品内容实读");$("#analysisHint").textContent=`${resolved.sourceLabel||"作品内容实读"}完成 · ${response.model||"Qwen-Omni"}。请检查并保存卡片。`;setOmniState(`${response.model||"Qwen-Omni"} 已就绪`,"ready");
  }
  async function analyzeTextForm(){
    if(!getAIConfig()){openAISettings("当前平台无法自动读取。请配置文本模型，或返回编辑器上传素材。");return false;}const url=$("#itemUrl").value.trim(),title=$("#itemTitle").value.trim()||`${$("#itemPlatform").value.trim()||platformFromUrl(url)||hostLabel(url)} 灵感`,note=$("#itemNote").value.trim();if(!url)throw new Error("请先粘贴作品链接");const system="你是创意作品拆解教练。不能访问链接时必须基于用户提供的信息分析，不要假装看过页面。只返回 JSON。";const prompt=`参考作品：${JSON.stringify({url,title,creator:$("#itemCreator").value.trim(),platform:$("#itemPlatform").value.trim(),type:$("#itemType").value.trim(),userObservation:note})}\n只返回：{"highlights":"80-160字","reproducibility":"80-160字","copyScore":1到5,"steps":["4到8个具体步骤"],"tags":["2到5个短标签"]}`;const config=getAIConfig(),result=parseAIJson(await callAI(system,prompt));applyAnalysis(result,config.model,"仅文字推测");$("#analysisHint").textContent="这是基于标题与观察生成的文字推测，并未读取原作品内容。";return true;
  }
  async function analyzeForm(){
    const hasVideo=Boolean(pendingVideoFile||pendingVideo?.path||safeUrl($("#itemVideoUrl").value.trim())),canLink=supportsLinkAnalysis($("#itemUrl").value.trim()),hasMedia=hasVideo||canLink,button=$("#analyzeBtn");button.disabled=true;button.textContent=hasVideo?"Qwen 正在看完整视频…":canLink?"正在解析链接并读取作品…":"AI 正在分析文字…";$("#analysisHint").textContent=hasMedia?"正在自动获取媒体，同时理解画面、字幕、口播、音乐和内容结构；长视频需要几分钟…":"正在根据标题和你的观察进行辅助分析…";
    try{if(hasMedia)await analyzeMediaForm();else await analyzeTextForm();toast(hasMedia?"作品深度拆解完成":"文本分析完成");}catch(error){$("#analysisHint").textContent=error.message;toast(error.message);}finally{button.disabled=false;updateAnalysisMode();}
  }

  function openAISettings(message=""){const config=getAIConfig()||{endpoint:"https://api.deepseek.com/v1",model:"deepseek-chat",apiKey:""};setValue("#aiEndpoint",config.endpoint);setValue("#aiModel",config.model);setValue("#aiKey",config.apiKey);$("#aiMessage").textContent=message;$("#aiMessage").classList.remove("error");$("#aiDialog").showModal();}
  function readAIForm(){const config={endpoint:$("#aiEndpoint").value.trim().replace(/\/+$/,"") ,model:$("#aiModel").value.trim(),apiKey:$("#aiKey").value.trim()};if(!/^https:\/\//i.test(config.endpoint)||!config.model||!config.apiKey)throw new Error("请完整填写 API 地址、模型名称和 API Key");return config;}
  async function testAI(){const previous=localStorage.getItem(AI_KEY);try{localStorage.setItem(AI_KEY,JSON.stringify(readAIForm()));$("#aiMessage").textContent="正在测试连接…";const reply=await callAI("你是连接测试助手。","只回复 OK");$("#aiMessage").textContent=`连接成功：${reply.slice(0,40)}`;$("#aiMessage").classList.remove("error");}catch(error){if(previous)localStorage.setItem(AI_KEY,previous);else localStorage.removeItem(AI_KEY);$("#aiMessage").textContent=error.message;$("#aiMessage").classList.add("error");}}

  $("#addInspirationBtn").addEventListener("click",()=>openEditor());$$('[data-open-editor]').forEach(button=>button.addEventListener("click",()=>openEditor()));$$('[data-close-editor]').forEach(button=>button.addEventListener("click",()=>$("#editorDialog").close()));$("#inspirationForm").addEventListener("submit",saveItem);
  $("#itemUrl").addEventListener("input",()=>{if(!$("#itemPlatform").value)$("#itemPlatform").value=platformFromUrl($("#itemUrl").value);renderVideo();$("#analysisHint").textContent=supportsLinkAnalysis($("#itemUrl").value)?"链接已识别：点击右侧按钮即可自动读取作品，无需下载。":"当前链接将使用文字辅助分析；也可上传视频作为备用。";});
  $("#chooseCoverBtn").addEventListener("click",()=>$("#coverInput").click());$("#coverInput").addEventListener("change",event=>{if(event.target.files[0])setCover(event.target.files[0]);event.target.value="";});$("#coverZone").addEventListener("paste",event=>{const file=[...(event.clipboardData?.items||[])].find(item=>item.type?.startsWith("image/"))?.getAsFile();if(file){event.preventDefault();setCover(file);}});$("#coverZone").addEventListener("focus",event=>event.currentTarget.classList.add("active"));$("#coverZone").addEventListener("blur",event=>event.currentTarget.classList.remove("active"));$("#coverPreview").addEventListener("click",event=>{if(event.target.closest("#removeCoverBtn")){pendingCover=null;renderCover();}});
  $("#chooseVideoBtn").addEventListener("click",()=>$("#videoInput").click());$("#videoInput").addEventListener("change",event=>{if(event.target.files[0])selectVideo(event.target.files[0]);event.target.value="";});["dragenter","dragover"].forEach(type=>$("#videoZone").addEventListener(type,event=>{event.preventDefault();event.currentTarget.classList.add("dragging");}));["dragleave","drop"].forEach(type=>$("#videoZone").addEventListener(type,event=>{event.preventDefault();event.currentTarget.classList.remove("dragging");if(type==="drop"&&event.dataTransfer?.files[0])selectVideo(event.dataTransfer.files[0]);}));$("#removeVideoBtn").addEventListener("click",()=>{if(pendingVideo?.path&&!removedVideoPath)removedVideoPath=pendingVideo.path;pendingVideo=null;pendingVideoFile=null;renderVideo();});
  $("#analyzeBtn").addEventListener("click",analyzeForm);
  $("#inspirationGrid").addEventListener("click",event=>{const edit=event.target.closest("[data-edit]");if(edit)return openEditor(edit.dataset.edit);const analyze=event.target.closest("[data-analyze]");if(analyze){openEditor(analyze.dataset.analyze);setTimeout(analyzeForm,0);return;}const del=event.target.closest("[data-delete]");if(del&&confirm("确定删除这张灵感卡吗？")){const item=inspirations().map(normalizeItem).find(entry=>entry.id===del.dataset.delete);replaceInspirations(inspirations().filter(entry=>entry.id!==del.dataset.delete));persist();if(item?.video?.path)deleteStoredVideo(item.video.path);render();toast("灵感卡已删除");}});
  ["searchInput","platformFilter","analysisFilter","scoreFilter"].forEach(id=>$("#"+id).addEventListener(id==="searchInput"?"input":"change",render));
  $("#aiConfigBtn").addEventListener("click",()=>openAISettings());$$('[data-close-ai]').forEach(button=>button.addEventListener("click",()=>$("#aiDialog").close()));$("#aiForm").addEventListener("submit",event=>{event.preventDefault();try{localStorage.setItem(AI_KEY,JSON.stringify(readAIForm()));$("#aiDialog").close();render();toast("文本 AI 配置已保存");}catch(error){$("#aiMessage").textContent=error.message;$("#aiMessage").classList.add("error");}});$("#testAiBtn").addEventListener("click",testAI);$("#clearAiBtn").addEventListener("click",()=>{localStorage.removeItem(AI_KEY);$("#aiDialog").close();render();toast("文本 AI 配置已清除");});
  $("#refreshCloudBtn").addEventListener("click",async()=>{if(!hasCloud())return toast("请先在项目看板中配置云同步");await pullCloud();await checkOmniService();toast("灵感库已从云端刷新");});

  cleanLegacyDetachedBoard();render();if(hasCloud())pullCloud();
})();
