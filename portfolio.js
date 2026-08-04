(() => {
  "use strict";
  const DATA_KEY = "ai_project_portfolio_kanban_v2";
  const CLOUD_KEY = "ai_project_portfolio_cloud_config_v1";
  const AI_KEY = "ai_project_portfolio_ai_config_v1";
  const MAX_JSON_CHARS = 3_800_000;
  const MAX_GALLERY = 6;
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[char]));
  const clone = value => globalThis.structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  const today = () => new Date().toISOString().slice(0, 10);
  const uid = prefix => globalThis.crypto?.randomUUID?.() || `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  let data = readJSON(DATA_KEY, []);
  let cloudConfig = readJSON(CLOUD_KEY, null);
  let editingProjectId = "";
  let pendingMedia = {cover:null, images:[]};
  let activeImageTarget = "cover";
  let syncTimer = null;

  function readJSON(key, fallback){
    try { const value = JSON.parse(localStorage.getItem(key)); return value ?? fallback; }
    catch(error){ return fallback; }
  }

  function text(value, fallback="待补充"){
    return String(value || "").trim() || fallback;
  }

  function defaultPortfolio(project){
    return {
      included:true,
      displayState:"draft",
      category:"AI 实践",
      title:project.name || "未命名作品",
      headline:project.purpose || "",
      launchDate:project.updatedAt || today(),
      idea:{
        problem:project.analysis || "",
        inspiration:"",
        targetUsers:"",
        value:project.purpose || ""
      },
      buildPath:[project.nextAction].filter(Boolean).join("\n"),
      media:{cover:null, images:[], videoUrl:""},
      users:{actualCount:"", scenarios:"", feedback:"", metrics:""},
      outcomes:{results:project.analysis || "", lessons:"", nextVersion:project.nextAction || ""},
      links:{demo:"", repo:"", article:""},
      promotion:{title:"", copy:""},
      createdAt:new Date().toISOString(),
      updatedAt:new Date().toISOString()
    };
  }

  function normalizedPortfolio(project){
    const base = defaultPortfolio(project);
    const stored = project.portfolio || {};
    return {
      ...base, ...stored,
      idea:{...base.idea, ...(stored.idea || {})},
      media:{...base.media, ...(stored.media || {}), images:Array.isArray(stored.media?.images) ? stored.media.images : []},
      users:{...base.users, ...(stored.users || {})},
      outcomes:{...base.outcomes, ...(stored.outcomes || {})},
      links:{...base.links, ...(stored.links || {})},
      promotion:{...base.promotion, ...(stored.promotion || {})}
    };
  }

  function works(){ return data.filter(project => project.portfolio?.included); }
  function completedAvailable(){ return data.filter(project => project.status === "已做成" && !project.portfolio?.included); }

  function hasCloud(){ return Boolean(cloudConfig?.url && cloudConfig?.anonKey && cloudConfig?.spaceId); }
  function cloudBase(){ return cloudConfig.url.replace(/\/+$/, "") + "/rest/v1"; }
  function cloudHeaders(){ return {apikey:cloudConfig.anonKey, Authorization:`Bearer ${cloudConfig.anonKey}`, "Content-Type":"application/json"}; }
  function syncState(state, label){
    const el = $("#syncState");
    el.dataset.state = state;
    el.querySelector("span").textContent = label || ({offline:"本地资料", pending:"正在同步", synced:"云端已同步", error:"同步失败"}[state]);
  }

  async function uploadCloud(){
    if(!hasCloud()) return;
    syncState("pending");
    try {
      const response = await fetch(`${cloudBase()}/rpc/portfolio_save`, {method:"POST", headers:cloudHeaders(), body:JSON.stringify({p_access_key:cloudConfig.spaceId, p_projects:data})});
      if(!response.ok) throw new Error(`${response.status} ${await response.text()}`);
      syncState("synced");
    } catch(error){
      console.error("作品资料同步失败", error);
      syncState("error");
      toast("已保存到当前浏览器，但云端同步失败");
    }
  }

  function queueCloud(){
    if(!hasCloud()) return syncState("offline");
    syncState("pending"); clearTimeout(syncTimer); syncTimer = setTimeout(uploadCloud, 650);
  }

  function persist({cloud=true}={}){
    const serialized = JSON.stringify(data);
    if(serialized.length > MAX_JSON_CHARS) throw new Error("图片总量过大。请删除部分图片或换用视频链接后再保存。");
    localStorage.setItem(DATA_KEY, serialized);
    if(cloud) queueCloud();
  }

  async function pullCloud(){
    if(!hasCloud()){ syncState("offline"); return false; }
    syncState("pending", "读取云端");
    try {
      const response = await fetch(`${cloudBase()}/rpc/portfolio_load`, {method:"POST", headers:cloudHeaders(), body:JSON.stringify({p_access_key:cloudConfig.spaceId})});
      if(!response.ok) throw new Error(`${response.status} ${await response.text()}`);
      const rows = await response.json();
      if(rows.length && Array.isArray(rows[0].projects)){
        data = rows[0].projects;
        localStorage.setItem(DATA_KEY, JSON.stringify(data));
      }
      syncState("synced"); render(); return true;
    } catch(error){
      console.error("作品资料读取失败", error); syncState("error"); toast("云端读取失败，正在显示本机资料"); return false;
    }
  }

  function toast(message){
    const el = $("#toast"); el.textContent = message; el.classList.add("show");
    clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove("show"), 2600);
  }

  function render(){
    renderStats(); renderCategories(); renderWorks(); renderPicker();
    if(!hasCloud()) syncState("offline");
  }

  function renderStats(){
    const list = works();
    $("#workCount").textContent = list.length;
    $("#showcaseCount").textContent = list.filter(project => project.portfolio.displayState === "showcase").length;
    $("#userCount").textContent = list.reduce((sum, project) => sum + (Number(project.portfolio.users?.actualCount) || 0), 0);
    $("#versionCount").textContent = list.reduce((sum, project) => sum + (project.versions?.length || 0), 0);
  }

  function renderCategories(){
    const select = $("#categoryFilter");
    const current = select.value;
    const categories = [...new Set(works().map(project => project.portfolio.category).filter(Boolean))].sort();
    select.innerHTML = `<option value="">全部分类</option>${categories.map(item => `<option value="${esc(item)}">${esc(item)}</option>`).join("")}`;
    select.value = categories.includes(current) ? current : "";
  }

  function filteredWorks(){
    const query = $("#workSearch").value.trim().toLowerCase();
    const state = $("#stateFilter").value;
    const category = $("#categoryFilter").value;
    return works().filter(project => {
      const p = project.portfolio;
      const haystack = [p.title, p.headline, p.category, p.idea?.problem, p.idea?.value, project.name].join(" ").toLowerCase();
      return (!query || haystack.includes(query)) && (!state || p.displayState === state) && (!category || p.category === category);
    }).sort((a,b) => String(b.portfolio.updatedAt || "").localeCompare(String(a.portfolio.updatedAt || "")));
  }

  function renderWorks(){
    const all = works();
    const list = filteredWorks();
    $("#emptyState").hidden = all.length !== 0;
    $("#workGrid").hidden = all.length === 0;
    $("#workGrid").innerHTML = list.map((project, index) => {
      const p = project.portfolio;
      const cover = p.media?.cover?.dataUrl;
      return `<article class="work-card" style="animation-delay:${Math.min(index * 55, 330)}ms">
        <button class="work-cover ${cover ? "" : "no-image"}" data-view-work="${esc(project.id)}" aria-label="查看 ${esc(p.title)}">
          ${cover ? `<img src="${esc(cover)}" alt="${esc(p.title)}封面" />` : `<span>${esc(p.headline || p.title)}</span>`}
          <i class="work-index">${String(index + 1).padStart(2,"0")}</i>
        </button>
        <div class="work-body">
          <div class="work-meta"><span>${esc(p.category || "未分类")} · ${esc(p.launchDate || "日期待补")}</span><span class="state-pill ${p.displayState === "showcase" ? "showcase" : ""}">${p.displayState === "showcase" ? "展示中" : "草稿"}</span></div>
          <h3>${esc(p.title || project.name)}</h3><p>${esc(p.headline || "还没有填写一句话说明")}</p>
          <div class="work-card-foot"><span>${Number(p.users?.actualCount) || 0} 位用户 · ${project.versions?.length || 0} 个版本</span><div><button class="text-btn" data-edit-work="${esc(project.id)}">编辑</button>　<button class="text-btn" data-view-work="${esc(project.id)}">查看案例 →</button></div></div>
        </div>
      </article>`;
    }).join("");
    if(all.length && !list.length) $("#workGrid").innerHTML = `<div class="picker-empty">没有符合当前筛选的作品。</div>`;
  }

  function renderPicker(){
    const query = $("#pickerSearch")?.value.trim().toLowerCase() || "";
    const list = completedAvailable().filter(project => !query || [project.name,project.purpose,project.id].join(" ").toLowerCase().includes(query));
    $("#pickerList").innerHTML = list.length ? list.map(project => `<article class="picker-item"><div><h3>${esc(project.name)}</h3><p>${esc(project.id)} · ${esc(project.updatedAt || "")} · ${esc(project.purpose || "暂无目的说明")}</p></div><button class="primary compact" data-include-work="${esc(project.id)}">收录</button></article>`).join("") : `<div class="picker-empty">${completedAvailable().length ? "没有匹配的项目" : "所有已完成项目都已经收录"}</div>`;
  }

  function openPicker(){ renderPicker(); $("#pickerDialog").showModal(); $("#pickerSearch").focus(); }
  function includeProject(id){
    const project = data.find(item => item.id === id); if(!project) return;
    project.portfolio = normalizedPortfolio(project); project.portfolio.included = true;
    persist(); render(); $("#pickerDialog").close(); openEditor(id);
  }

  function setValue(id, value){ $(id).value = value ?? ""; }
  function openEditor(id){
    const project = data.find(item => item.id === id); if(!project) return;
    if(!project.portfolio?.included){ project.portfolio = defaultPortfolio(project); persist(); }
    const p = normalizedPortfolio(project); editingProjectId = id;
    pendingMedia = clone(p.media || {cover:null,images:[]}); pendingMedia.images ||= [];
    $("#projectId").value = id; $("#editorTitle").textContent = `${project.name} · 作品编辑`;
    setValue("#pfTitle", p.title); setValue("#pfCategory", p.category); setValue("#pfHeadline", p.headline); setValue("#pfLaunchDate", p.launchDate); setValue("#pfDisplayState", p.displayState); setValue("#pfDemo", p.links.demo);
    setValue("#pfProblem", p.idea.problem); setValue("#pfInspiration", p.idea.inspiration); setValue("#pfTargetUsers", p.idea.targetUsers); setValue("#pfValue", p.idea.value); setValue("#pfBuildPath", p.buildPath);
    setValue("#pfVideo", p.media.videoUrl); setValue("#pfUserCount", p.users.actualCount); setValue("#pfScenarios", p.users.scenarios); setValue("#pfFeedback", p.users.feedback); setValue("#pfMetrics", p.users.metrics);
    setValue("#pfResults", p.outcomes.results); setValue("#pfLessons", p.outcomes.lessons); setValue("#pfNextVersion", p.outcomes.nextVersion); setValue("#pfRepo", p.links.repo); setValue("#pfArticle", p.links.article); setValue("#pfPromoTitle", p.promotion.title); setValue("#pfPromoCopy", p.promotion.copy);
    renderMediaPreview(); $("#editorDialog").showModal(); $(".editor-sections").scrollTop = 0;
  }

  function formPortfolio(project){
    return {
      ...normalizedPortfolio(project), included:true,
      title:$("#pfTitle").value.trim(), category:$("#pfCategory").value.trim(), headline:$("#pfHeadline").value.trim(), launchDate:$("#pfLaunchDate").value, displayState:$("#pfDisplayState").value,
      idea:{problem:$("#pfProblem").value.trim(), inspiration:$("#pfInspiration").value.trim(), targetUsers:$("#pfTargetUsers").value.trim(), value:$("#pfValue").value.trim()},
      buildPath:$("#pfBuildPath").value.trim(), media:{...pendingMedia, videoUrl:$("#pfVideo").value.trim()},
      users:{actualCount:$("#pfUserCount").value, scenarios:$("#pfScenarios").value.trim(), feedback:$("#pfFeedback").value.trim(), metrics:$("#pfMetrics").value.trim()},
      outcomes:{results:$("#pfResults").value.trim(), lessons:$("#pfLessons").value.trim(), nextVersion:$("#pfNextVersion").value.trim()},
      links:{demo:$("#pfDemo").value.trim(), repo:$("#pfRepo").value.trim(), article:$("#pfArticle").value.trim()},
      promotion:{title:$("#pfPromoTitle").value.trim(), copy:$("#pfPromoCopy").value.trim()}, updatedAt:new Date().toISOString()
    };
  }

  function saveEditor(event){
    event.preventDefault(); const project = data.find(item => item.id === editingProjectId); if(!project) return;
    const previous = project.portfolio;
    project.portfolio = formPortfolio(project);
    try { persist(); }
    catch(error){ project.portfolio = previous; alert(error.message); return; }
    $("#editorDialog").close(); render(); toast("作品资料已保存"); showDetail(project.id);
  }

  function imageData(file, maxWidth, maxChars){
    return new Promise((resolve, reject) => {
      if(!file?.type?.startsWith("image/")) return reject(new Error("请选择图片文件"));
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("图片读取失败"));
      reader.onload = () => {
        const image = new Image();
        image.onerror = () => reject(new Error("无法识别图片"));
        image.onload = () => {
          const scale = Math.min(1, maxWidth / image.width);
          const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
          canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
          let quality = .82, dataUrl = canvas.toDataURL("image/webp", quality);
          while(dataUrl.length > maxChars && quality > .35){ quality -= .1; dataUrl = canvas.toDataURL("image/webp", quality); }
          resolve({id:uid("image"), name:file.name || `粘贴图片-${today()}`, dataUrl, width:canvas.width, height:canvas.height});
        };
        image.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function addImages(files, target=activeImageTarget){
    const images = [...files].filter(file => file.type.startsWith("image/")); if(!images.length) return;
    try {
      if(target === "cover") pendingMedia.cover = await imageData(images[0], 1400, 230000);
      else {
        const room = MAX_GALLERY - pendingMedia.images.length;
        if(room <= 0) return toast(`宣传图片最多 ${MAX_GALLERY} 张`);
        for(const file of images.slice(0, room)) pendingMedia.images.push(await imageData(file, 1100, 165000));
      }
      renderMediaPreview(); toast(target === "cover" ? "封面已加入，保存作品后生效" : "图片已加入，保存作品后生效");
    } catch(error){ alert(error.message); }
  }

  function renderMediaPreview(){
    $("#coverPreview").innerHTML = pendingMedia.cover ? `<div class="image-tile"><img src="${esc(pendingMedia.cover.dataUrl)}" alt="封面预览"/><button class="image-remove" type="button" data-remove-cover>×</button></div>` : "";
    $("#galleryPreview").innerHTML = pendingMedia.images.map((image,index) => `<div class="image-tile"><img src="${esc(image.dataUrl)}" alt="宣传图 ${index+1}"/><button class="image-remove" type="button" data-remove-gallery="${index}">×</button></div>`).join("");
  }

  function safeUrl(value){
    try { const url = new URL(value); return ["http:","https:"].includes(url.protocol) ? url.href : ""; } catch(error){ return ""; }
  }
  function videoEmbed(value){
    const url = safeUrl(value); if(!url) return "";
    try {
      const parsed = new URL(url);
      if(parsed.hostname.includes("youtube.com")){ const id = parsed.searchParams.get("v"); if(id) return `<iframe class="video-frame" src="https://www.youtube.com/embed/${esc(id)}" allowfullscreen></iframe>`; }
      if(parsed.hostname === "youtu.be") return `<iframe class="video-frame" src="https://www.youtube.com/embed/${esc(parsed.pathname.slice(1))}" allowfullscreen></iframe>`;
      if(/\.mp4($|\?)/i.test(url)) return `<video class="video-frame" src="${esc(url)}" controls></video>`;
      return `<a class="link-chip" href="${esc(url)}" target="_blank" rel="noopener">打开作品视频 ↗</a>`;
    } catch(error){ return ""; }
  }

  function section(number, title, content){ return `<section class="case-section"><div class="case-label"><span>${number}</span><h2>${title}</h2></div><div class="case-content">${content}</div></section>`; }
  function narrative(title, value){ return `<article class="narrative-card"><h3>${title}</h3><p class="${value ? "" : "placeholder-copy"}">${esc(text(value))}</p></article>`; }
  function showDetail(id, push=true){
    const project = data.find(item => item.id === id && item.portfolio?.included); if(!project) return;
    const p = normalizedPortfolio(project); const cover = p.media.cover?.dataUrl;
    $("#archiveIndex").hidden = true; $(".archive-hero").hidden = true; $("#caseDetail").hidden = false;
    const buildSteps = String(p.buildPath || "").split(/\n+/).map(item => item.trim()).filter(Boolean);
    const media = [p.media.cover, ...(p.media.images || [])].filter(item => item?.dataUrl);
    const links = [["体验作品",p.links.demo],["代码仓库",p.links.repo],["相关文章",p.links.article]].filter(([,url]) => safeUrl(url));
    $("#caseDetail").innerHTML = `<button class="detail-back" data-back-archive>← 返回作品目录</button>
      <section class="detail-hero">${cover ? `<img src="${esc(cover)}" alt="${esc(p.title)}封面"/>` : ""}<div class="detail-hero-content"><div class="eyebrow">${esc(p.category)} · ${esc(p.launchDate || "日期待补")}</div><h1>${esc(p.title)}</h1><p>${esc(text(p.headline,"一句话说明待补充"))}</p><div class="detail-actions"><button class="primary" data-edit-work="${esc(id)}">编辑案例</button>${links[0] ? `<a class="secondary" href="${esc(links[0][1])}" target="_blank" rel="noopener">访问作品 ↗</a>` : ""}</div></div></section>
      ${section("01","想法与价值",`<div class="idea-grid">${narrative("最初的问题",p.idea.problem)}${narrative("灵感来源",p.idea.inspiration)}${narrative("希望帮助谁",p.idea.targetUsers)}${narrative("核心价值",p.idea.value)}</div>`)}
      ${section("02","搭建链路",buildSteps.length ? `<div class="build-track">${buildSteps.map((step,index) => `<div class="build-step"><b>${String(index+1).padStart(2,"0")}</b><p>${esc(step)}</p></div>`).join("")}</div>` : `<p class="placeholder-copy">搭建步骤待补充</p>`)}
      ${media.length ? section("03","视觉记录",`<div class="media-wall">${media.map((item,index) => `<img src="${esc(item.dataUrl)}" alt="${esc(p.title)} 图片 ${index+1}"/>`).join("")}</div>`) : ""}
      ${p.media.videoUrl ? section("04","作品视频",videoEmbed(p.media.videoUrl) || `<p class="placeholder-copy">视频链接暂时无法识别</p>`) : ""}
      ${section("05","用户与验证",`<div class="idea-grid">${narrative("真实用户",p.users.actualCount ? `${p.users.actualCount} 位` : "")}${narrative("使用场景",p.users.scenarios)}${narrative("用户反馈",p.users.feedback)}${narrative("关键数据",p.users.metrics)}</div>`)}
      ${section("06","结果与复盘",`<div class="outcome-grid">${narrative("实现结果",p.outcomes.results)}${narrative("经验与教训",p.outcomes.lessons)}${narrative("下一版本",p.outcomes.nextVersion)}${narrative("项目版本记录",project.versions?.length ? `已经沉淀 ${project.versions.length} 次版本更新` : "")}</div>`)}
      ${section("07","分享与传播",`${p.promotion.title || p.promotion.copy ? `<div class="promo-quote"><h3>${esc(text(p.promotion.title,"作品宣传标题"))}</h3><p>${esc(text(p.promotion.copy))}</p></div>` : `<p class="placeholder-copy">宣传文案待补充</p>`}${links.length ? `<div class="link-list" style="margin-top:20px">${links.map(([name,url]) => `<a class="link-chip" href="${esc(url)}" target="_blank" rel="noopener">${name} ↗</a>`).join("")}</div>` : ""}`)}
    `;
    if(push) history.pushState({work:id}, "", `#work=${encodeURIComponent(id)}`);
    scrollTo({top:0,behavior:"smooth"});
  }

  function showArchive(push=true){
    $("#archiveIndex").hidden = false; $(".archive-hero").hidden = false; $("#caseDetail").hidden = true;
    if(push) history.pushState({}, "", location.pathname);
    scrollTo({top:0,behavior:"smooth"});
  }

  function getAIConfig(){ const config = readJSON(AI_KEY,null); return config?.endpoint && config?.model && config?.apiKey ? config : null; }
  function completionUrl(endpoint){ const clean = endpoint.trim().replace(/\/+$/,""); return /\/chat\/completions$/i.test(clean) ? clean : `${clean}/chat/completions`; }
  function isDeepSeekV4(config){ try { const host = new URL(config.endpoint).hostname.toLowerCase(); return (host === "api.deepseek.com" || host.endsWith(".deepseek.com")) && /^deepseek-v4-/i.test(config.model); } catch(error){ return false; } }
  async function callAI(system, user){
    const config = getAIConfig(); if(!config) throw new Error("请先回到项目看板配置 AI 模型");
    const body = {model:config.model,temperature:.2,max_tokens:1800,stream:false,messages:[{role:"system",content:system},{role:"user",content:user}]};
    if(isDeepSeekV4(config)) body.thinking = {type:"disabled"};
    let response;
    try { response = await fetch(completionUrl(config.endpoint),{method:"POST",headers:{Authorization:`Bearer ${config.apiKey}`,"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify(body)}); }
    catch(error){ throw new Error("浏览器没有收到模型响应，请检查网络或模型服务是否允许网页跨域调用"); }
    const raw = await response.text(); if(!response.ok) throw new Error(`模型请求失败（${response.status}）：${raw.slice(0,160)}`);
    const payload = JSON.parse(raw); const content = payload?.choices?.[0]?.message?.content; if(!content) throw new Error("模型没有返回内容"); return content;
  }
  function parseJSON(textValue){ const cleaned = textValue.replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/i,"").trim(); const start=cleaned.indexOf("{"); const end=cleaned.lastIndexOf("}"); return JSON.parse(start>=0 && end>start ? cleaned.slice(start,end+1) : cleaned); }
  function fillEmpty(id, value){ if(value && !$(id).value.trim()) $(id).value = value; }
  async function generateDraft(){
    const project = data.find(item => item.id === editingProjectId); if(!project) return;
    const button = $("#aiDraftBtn"); const original = button.textContent; button.disabled=true; button.textContent="正在整理…";
    try {
      const compactProject = {name:project.name,purpose:project.purpose,analysis:project.analysis,nextAction:project.nextAction,nature:project.nature,difficulty:project.difficulty,versions:(project.versions||[]).map(item=>({date:item.date,description:item.description}))};
      const result = parseJSON(await callAI("你是作品集案例编辑。根据真实材料整理清楚、有具体感的中文案例草稿。不得编造用户数、指标、融资、营收或未经提供的事实；缺失信息使用空字符串。只输出有效 JSON。",`请整理这个项目：${JSON.stringify(compactProject)}\n返回字段：headline, problem, inspiration, targetUsers, value, buildPath（每步一行）, results, lessons, nextVersion, promoTitle, promoCopy。`));
      fillEmpty("#pfHeadline",result.headline); fillEmpty("#pfProblem",result.problem); fillEmpty("#pfInspiration",result.inspiration); fillEmpty("#pfTargetUsers",result.targetUsers); fillEmpty("#pfValue",result.value); fillEmpty("#pfBuildPath",result.buildPath); fillEmpty("#pfResults",result.results); fillEmpty("#pfLessons",result.lessons); fillEmpty("#pfNextVersion",result.nextVersion); fillEmpty("#pfPromoTitle",result.promoTitle); fillEmpty("#pfPromoCopy",result.promoCopy); toast("AI 草稿已填入空白字段，请检查后保存");
    } catch(error){ alert(error.message); }
    finally { button.disabled=false; button.textContent=original; }
  }

  document.addEventListener("click", event => {
    const close = event.target.closest("[data-close-dialog]"); if(close){ close.closest("dialog").close(); return; }
    if(event.target.closest("[data-open-picker]") || event.target.closest("#addWorkBtn")){ openPicker(); return; }
    const include = event.target.closest("[data-include-work]"); if(include){ includeProject(include.dataset.includeWork); return; }
    const edit = event.target.closest("[data-edit-work]"); if(edit){ openEditor(edit.dataset.editWork); return; }
    const view = event.target.closest("[data-view-work]"); if(view){ showDetail(view.dataset.viewWork); return; }
    if(event.target.closest("[data-back-archive]")){ showArchive(); return; }
    const choose = event.target.closest("[data-choose-image]"); if(choose){ activeImageTarget=choose.dataset.chooseImage; $(activeImageTarget === "cover" ? "#coverInput" : "#galleryInput").click(); return; }
    const zone = event.target.closest("[data-image-target]"); if(zone){ activeImageTarget=zone.dataset.imageTarget; $$(".paste-zone").forEach(item=>item.classList.toggle("active",item===zone)); }
    if(event.target.closest("[data-remove-cover]")){ pendingMedia.cover=null; renderMediaPreview(); return; }
    const remove = event.target.closest("[data-remove-gallery]"); if(remove){ pendingMedia.images.splice(Number(remove.dataset.removeGallery),1); renderMediaPreview(); }
  });
  $("#portfolioForm").addEventListener("submit", saveEditor);
  $("#workSearch").addEventListener("input",renderWorks); $("#stateFilter").addEventListener("change",renderWorks); $("#categoryFilter").addEventListener("change",renderWorks); $("#pickerSearch").addEventListener("input",renderPicker);
  $("#coverInput").addEventListener("change",event=>addImages(event.target.files,"cover")); $("#galleryInput").addEventListener("change",event=>addImages(event.target.files,"gallery"));
  $("#editorDialog").addEventListener("paste",event=>{ const files=[...event.clipboardData.items].filter(item=>item.type.startsWith("image/")).map(item=>item.getAsFile()).filter(Boolean); if(files.length){ event.preventDefault(); addImages(files,activeImageTarget); } });
  $("#aiDraftBtn").addEventListener("click",generateDraft); $("#syncBtn").addEventListener("click",async()=>{ await pullCloud(); toast("已读取最新云端资料"); });
  window.addEventListener("popstate",()=>{ const match=location.hash.match(/^#work=(.+)$/); match ? showDetail(decodeURIComponent(match[1]),false) : showArchive(false); });

  async function init(){
    render(); await pullCloud();
    const params = new URLSearchParams(location.search); const projectId = params.get("project");
    if(projectId){ const project=data.find(item=>item.id===projectId); if(project){ if(!project.portfolio?.included){ project.portfolio=defaultPortfolio(project); persist(); render(); } history.replaceState({},"",location.pathname); params.get("edit")==="1" ? openEditor(projectId) : showDetail(projectId,false); } }
    else { const match=location.hash.match(/^#work=(.+)$/); if(match) showDetail(decodeURIComponent(match[1]),false); }
  }
  init();
})();
