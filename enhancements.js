(() => {
  const AI_CONFIG_KEY = "ai_project_portfolio_ai_config_v1";
  const STATUSES = ["已做成", "正在做", "还没开始"];
  const MAX_IMAGES_PER_VERSION = 3;
  const MAX_LOCAL_JSON_CHARS = 3_800_000;
  const baseRender = render;
  const baseOpenForm = openForm;
  const baseSortList = sortList;
  let difficultyTouched = false;
  let difficultyTimer = null;
  let adviceProjectId = "";
  let versionProjectId = "";
  let editingVersionId = "";
  let pendingVersionImages = [];
  let lightboxImages = [];
  let lightboxImageIndex = 0;
  let draggedProjectId = "";

  function clamp(value, min, max){
    return Math.min(max, Math.max(min, value));
  }

  function uid(prefix="item"){
    return globalThis.crypto?.randomUUID?.() || `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
  }

  function getAIConfig(){
    try {
      const config = JSON.parse(localStorage.getItem(AI_CONFIG_KEY));
      return config?.endpoint && config?.model && config?.apiKey ? config : null;
    } catch(error) {
      return null;
    }
  }

  function estimateDifficulty(project){
    const text = [project.name, project.purpose, project.analysis, project.nextAction].filter(Boolean).join(" ");
    if(!text.trim()) return 0;
    let level = 1;
    const complexTerms = ["自动", "系统", "平台", "模型", "智能体", "工作流", "数据库", "API", "MCP", "爬取", "实时", "跨设备", "部署", "3D", "硬件", "视频", "识别", "训练", "多用户", "支付", "地图"];
    const simpleTerms = ["整理", "总结", "清单", "记录", "推荐", "分析", "写", "生成文档", "查询"];
    level += Math.min(5, complexTerms.filter(term => text.toLowerCase().includes(term.toLowerCase())).length);
    level -= Math.min(2, simpleTerms.filter(term => text.includes(term)).length);
    if(project.feasibility === "中") level += 1;
    if(project.feasibility === "低") level += 2;
    if(project.nature === "持续迭代") level += 1;
    if(text.length > 180) level += 1;
    if(/安全|隐私|权限|合规|风控/.test(text)) level += 1;
    return clamp(Math.round(level), 0, 10);
  }

  function normalizeProjects(){
    data.forEach(project => {
      if(!Number.isInteger(Number(project.difficulty)) || Number(project.difficulty) < 0 || Number(project.difficulty) > 10){
        project.difficulty = estimateDifficulty(project);
      } else {
        project.difficulty = Number(project.difficulty);
      }
      if(!Array.isArray(project.versions)) project.versions = [];
      if(!project.aiAdvice || typeof project.aiAdvice !== "object") project.aiAdvice = null;
    });
    STATUSES.forEach(status => {
      const projects = data.filter(project => project.status === status);
      const ordered = projects.every(project => project.order !== null && project.order !== "" && Number.isFinite(Number(project.order)));
      if(!ordered){
        projects.forEach((project, index) => { project.order = (index + 1) * 100; });
      }
    });
  }

  function difficultyBand(level){
    if(level <= 3) return "easy";
    if(level <= 7) return "medium";
    return "hard";
  }

  function hasAnyFilter(){
    const globalFiltered = ["q", "natureFilter", "feasFilter", "resultFilter"].some(id => $("#" + id)?.value);
    const columnFiltered = Object.values(columnFilters).some(filter => filter.nature || filter.result);
    return globalFiltered || columnFiltered;
  }

  function canManualReorder(){
    return $("#sortMode")?.value === "manual" && !hasAnyFilter();
  }

  function versionPeekHTML(project){
    const versions = Array.isArray(project.versions) ? project.versions : [];
    if(!versions.length) return "";
    const latest = [...versions].sort((a,b) => String(b.date || "").localeCompare(String(a.date || "")) || String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0];
    const image = latest?.images?.[0]?.dataUrl;
    return `<div class="version-peek">${image ? `<img src="${esc(image)}" alt="版本缩略图" />` : ""}<span>${esc(latest?.date || "")}${latest?.description ? ` · ${esc(String(latest.description).slice(0,42))}` : ""}<br>共 ${versions.length} 个版本</span></div>`;
  }

  function enhancedCardHTML(project){
    const level = Number(project.difficulty) || 0;
    const reorderEnabled = canManualReorder();
    return `
    <article class="card" draggable="${reorderEnabled}" data-project-id="${esc(project.id)}" data-status="${esc(project.status)}">
      <div class="card-topline">
        <button class="drag-handle" type="button" title="上下拖动调整顺序" aria-label="拖动 ${esc(project.name)}" ${reorderEnabled ? "" : "disabled"}>⋮⋮</button>
        <div class="card-heading"><div class="code">${esc(project.id)} · 更新 ${esc(project.updatedAt || "")}</div><h4>${esc(project.name)}</h4></div>
        <span class="difficulty-badge" data-band="${difficultyBand(level)}" title="${esc(project.difficultyReason || "项目实现难度")}">LV${level}</span>
      </div>
      ${project.difficultyReason ? `<div class="difficulty-reason">${esc(project.difficultyReason)}</div>` : ""}
      <div class="badges">
        <span class="badge">${esc(project.result)}</span>
        <span class="badge nature">${esc(project.nature)}</span>
        <span class="badge ${badgeClass(project.feasibility)}">可行性 ${esc(project.feasibility)}</span>
      </div>
      <div class="meta">
        <b>目的</b><div>${esc(project.purpose) || "—"}</div>
        <b>分析</b><div>${esc(project.analysis) || "—"}</div>
      </div>
      <div class="next"><strong>下一步：</strong>${esc(project.nextAction) || "尚未填写"}</div>
      ${versionPeekHTML(project)}
      <div class="foot">
        <div><div class="review">${esc(project.reviewCycle || "")}${project.nextReview ? " · " + esc(project.nextReview) : ""}</div><div class="drag-note">↕ 手动顺序 ${Math.round(Number(project.order || 0) / 100)}</div></div>
        <div class="card-actions">
          <button class="mini icon-mini" type="button" data-move="up" data-project="${esc(project.id)}" title="上移" ${reorderEnabled ? "" : "disabled"}>↑</button>
          <button class="mini icon-mini" type="button" data-move="down" data-project="${esc(project.id)}" title="下移" ${reorderEnabled ? "" : "disabled"}>↓</button>
          <button class="mini ai-mini" type="button" data-advice="${esc(project.id)}">✦ 步骤建议</button>
          <button class="mini" type="button" data-versions="${esc(project.id)}">版本 ${project.versions.length || ""}</button>
          ${project.status === "已做成" ? `<button class="mini portfolio-mini" type="button" data-portfolio="${esc(project.id)}">${project.portfolio?.included ? "查看作品" : "收录作品"}</button>` : ""}
          <button class="mini" type="button" data-edit="${esc(project.id)}">编辑</button>
          ${project.status !== "已做成" ? `<button class="mini" type="button" data-done="${esc(project.id)}">完成</button>` : ""}
          <button class="mini" type="button" data-del="${esc(project.id)}">删除</button>
        </div>
      </div>
    </article>`;
  }

  function enhancedSortList(items){
    if($("#sortMode")?.value !== "manual") return baseSortList(items);
    const statusRank = {"已做成":0, "正在做":1, "还没开始":2};
    return [...items].sort((a,b) => (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9) || Number(a.order || 0) - Number(b.order || 0) || String(a.id).localeCompare(String(b.id)));
  }

  function updateAIStatus(){
    const configured = Boolean(getAIConfig());
    const label = $("#aiSettingsLabel");
    if(label) label.textContent = configured ? "AI 已配置" : "配置 AI 模型";
    $("#aiSettingsBtn")?.classList.toggle("configured", configured);
  }

  function updateDragState(){
    const enabled = canManualReorder();
    document.querySelectorAll(".card[data-project-id]").forEach(card => card.setAttribute("draggable", enabled ? "true" : "false"));
    document.querySelectorAll(".drag-handle,[data-move]").forEach(control => control.disabled = !enabled);
    const summary = $("#summaryText");
    if(summary && !enabled) summary.textContent += "；清除筛选并选择“手动顺序”后可拖动";
  }

  function enhancedRender(){
    normalizeProjects();
    baseRender();
    updateAIStatus();
    updateDragState();
  }

  function enhancedOpenForm(id=""){
    normalizeProjects();
    baseOpenForm(id);
    const project = data.find(item => item.id === id);
    const level = project ? Number(project.difficulty) : estimateDifficulty({name:"", feasibility:$("#ffeas").value, nature:$("#fnature").value});
    $("#fdifficulty").value = String(clamp(level || 0, 0, 10));
    $("#difficultyHint").textContent = project?.difficultyReason || "保存新项目后会自动评估；未配置 AI 时使用本地规则初评。";
    difficultyTouched = false;
  }

  cardHTML = enhancedCardHTML;
  sortList = enhancedSortList;
  render = enhancedRender;
  openForm = enhancedOpenForm;

  function showToast(message, isError=false){
    let stack = document.querySelector(".toast-stack");
    if(!stack){
      stack = document.createElement("div");
      stack.className = "toast-stack";
      document.body.appendChild(stack);
    }
    const toast = document.createElement("div");
    toast.className = `app-toast${isError ? " error" : ""}`;
    toast.textContent = message;
    stack.appendChild(toast);
    setTimeout(() => toast.remove(), 4200);
  }

  function completionUrl(endpoint){
    const clean = endpoint.trim().replace(/\/+$/, "");
    return /\/chat\/completions$/i.test(clean) ? clean : `${clean}/chat/completions`;
  }

  function isDeepSeekV4(config){
    try {
      const host = new URL(config.endpoint).hostname.toLowerCase();
      return (host === "api.deepseek.com" || host.endsWith(".deepseek.com")) && /^deepseek-v4-/i.test(config.model);
    } catch(error) {
      return false;
    }
  }

  async function callAI(systemPrompt, userPrompt){
    const config = getAIConfig();
    if(!config) throw new Error("请先配置 AI 模型");
    const requestBody = {
      model:config.model,
      temperature:0.2,
      max_tokens:1800,
      stream:false,
      messages:[{role:"system", content:systemPrompt}, {role:"user", content:userPrompt}]
    };
    // DeepSeek V4 defaults to thinking mode. These dashboard actions need short,
    // deterministic responses; disabling thinking also avoids long browser requests
    // being interrupted by a VPN/proxy before the first response arrives.
    if(isDeepSeekV4(config)) requestBody.thinking = {type:"disabled"};
    let response;
    try {
      response = await fetch(completionUrl(config.endpoint), {
        method:"POST",
        headers:{"Authorization":`Bearer ${config.apiKey}`, "Content-Type":"application/json", "Accept":"application/json"},
        body:JSON.stringify(requestBody)
      });
    } catch(error) {
      const hint = isDeepSeekV4(config)
        ? "DeepSeek V4 请求已使用非思考模式；请稍后重试，并确认 VPN 没有中途切换。"
        : "请检查网络、API 地址，或确认该服务允许浏览器跨域调用。";
      throw new Error(`浏览器未收到模型响应。${hint}`);
    }
    const raw = await response.text();
    if(!response.ok) throw new Error(`模型请求失败（${response.status}）：${raw.slice(0,180)}`);
    let payload;
    try { payload = JSON.parse(raw); } catch(error) { throw new Error("模型返回了无法识别的数据"); }
    const content = payload?.choices?.[0]?.message?.content;
    if(!content) throw new Error("模型没有返回内容");
    return content.trim();
  }

  function parseAIJson(text){
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    try { return JSON.parse(cleaned); } catch(error) {
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if(start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
      throw new Error("AI 返回格式不正确，请重试");
    }
  }

  function projectForPrompt(project){
    return {
      id:project.id,
      name:project.name,
      purpose:project.purpose,
      analysis:project.analysis,
      nextAction:project.nextAction,
      feasibility:project.feasibility,
      nature:project.nature,
      difficulty:Number(project.difficulty) || 0
    };
  }

  async function evaluateProjectDifficulty(project, {silent=false}={}){
    const system = "你是 AI 项目工程难度评估器。依据实现范围、数据依赖、外部 API、自动化程度、安全风险、跨端与维护成本，在 LV0-LV10 之间评级。LV0 是无需技术的提示词任务，LV10 是需要大型团队和长期研发的复杂系统。只返回 JSON。";
    const content = await callAI(system, `评估这个项目：${JSON.stringify(projectForPrompt(project))}\n只返回：{\"difficulty\":0到10的整数,\"reason\":\"不超过45字的中文理由\"}`);
    const result = parseAIJson(content);
    const level = clamp(Math.round(Number(result.difficulty)), 0, 10);
    if(!Number.isFinite(level)) throw new Error("AI 没有给出有效难度");
    project.difficulty = level;
    project.difficultyReason = String(result.reason || "AI 综合项目范围与依赖评估").slice(0,90);
    project.updatedAt = today();
    save();
    render();
    if(!silent) showToast(`${project.name} 已评为 LV${level}`);
    return {level, reason:project.difficultyReason};
  }

  async function evaluateFormDifficulty(){
    const project = {
      id:$("#fid").value || "NEW",
      name:$("#fname").value.trim(),
      purpose:$("#fpurpose").value.trim(),
      analysis:$("#fanalysis").value.trim(),
      nextAction:$("#fnext").value.trim(),
      feasibility:$("#ffeas").value,
      nature:$("#fnature").value
    };
    if(!project.name){ showToast("请先填写项目名称", true); return; }
    const button = $("#estimateDifficultyBtn");
    if(!getAIConfig()){
      const level = estimateDifficulty(project);
      $("#fdifficulty").value = String(level);
      $("#difficultyHint").textContent = `本地规则初评为 LV${level}；配置 AI 后可获得更准确评估。`;
      difficultyTouched = true;
      openAISettings("配置后可使用模型评估难度。");
      return;
    }
    button.disabled = true;
    button.textContent = "评估中…";
    try {
      const system = "你是 AI 项目工程难度评估器。依据实现范围、外部依赖、自动化、安全风险和维护成本，在 LV0-LV10 之间评级。只返回 JSON。";
      const content = await callAI(system, `项目：${JSON.stringify(project)}\n只返回：{\"difficulty\":0到10的整数,\"reason\":\"不超过45字的中文理由\"}`);
      const result = parseAIJson(content);
      const level = clamp(Math.round(Number(result.difficulty)), 0, 10);
      $("#fdifficulty").value = String(level);
      $("#difficultyHint").textContent = String(result.reason || `AI 评估为 LV${level}`);
      difficultyTouched = true;
    } catch(error) {
      showToast(error.message, true);
    } finally {
      button.disabled = false;
      button.textContent = "✦ AI 评估";
    }
  }

  function reorderStatus(status, orderedIds){
    const statusProjects = data.filter(project => project.status === status);
    const map = new Map(statusProjects.map(project => [project.id, project]));
    const validIds = [...new Set(orderedIds.filter(id => map.has(id)))];
    statusProjects.forEach(project => { if(!validIds.includes(project.id)) validIds.push(project.id); });
    validIds.forEach((id,index) => { map.get(id).order = (index + 1) * 100; });
  }

  function moveProject(id, direction){
    const project = data.find(item => item.id === id);
    if(!project || !canManualReorder()) return;
    const siblings = data.filter(item => item.status === project.status).sort((a,b) => Number(a.order) - Number(b.order));
    const index = siblings.findIndex(item => item.id === id);
    const nextIndex = direction === "up" ? index - 1 : index + 1;
    if(index < 0 || nextIndex < 0 || nextIndex >= siblings.length) return;
    [siblings[index], siblings[nextIndex]] = [siblings[nextIndex], siblings[index]];
    reorderStatus(project.status, siblings.map(item => item.id));
    save();
    render();
  }

  async function aiSortPending(){
    const candidates = data.filter(project => project.status === "还没开始");
    if(candidates.length < 2){ showToast("待办项目不足 2 个，无需排序"); return; }
    if(!getAIConfig()){
      openAISettings("请先配置模型，再进行 AI 一键排序。");
      return;
    }
    const button = $("#aiSortBtn");
    button.disabled = true;
    button.textContent = "AI 正在排序…";
    try {
      const input = candidates.map(projectForPrompt);
      const system = "你是个人 AI 项目组合的优先级教练。排序目标是：优先产生可验证价值、优先可快速启动、兼顾能力成长和前置依赖，避免只按难度或可行性机械排序。只返回 JSON。";
      const content = await callAI(system, `请为以下待办项目排列执行顺序：${JSON.stringify(input)}\n必须包含所有 id 且不重复。只返回：{\"orderedIds\":[\"id1\",\"id2\"],\"reason\":\"不超过80字的总体排序逻辑\"}`);
      const result = parseAIJson(content);
      if(!Array.isArray(result.orderedIds)) throw new Error("AI 未返回项目顺序");
      reorderStatus("还没开始", result.orderedIds.map(String));
      $("#sortMode").value = "manual";
      save();
      render();
      showToast(`AI 排序完成：${result.reason || "已按价值、启动成本和依赖调整"}`);
    } catch(error) {
      showToast(error.message, true);
    } finally {
      button.disabled = false;
      button.textContent = "✦ AI 排序";
    }
  }

  function openAISettings(message=""){
    const config = getAIConfig() || {endpoint:"https://api.deepseek.com/v1", model:"deepseek-chat", apiKey:""};
    $("#aiEndpoint").value = config.endpoint;
    $("#aiModel").value = config.model;
    $("#aiApiKey").value = config.apiKey;
    $("#aiSettingsMessage").textContent = message;
    $("#aiSettingsMessage").classList.remove("error");
    $("#aiSettingsDlg").showModal();
  }

  function readAIForm(){
    const endpoint = $("#aiEndpoint").value.trim().replace(/\/+$/, "");
    const model = $("#aiModel").value.trim();
    const apiKey = $("#aiApiKey").value.trim();
    try { new URL(endpoint); } catch(error) { throw new Error("请填写正确的 API 地址"); }
    if(!model || !apiKey) throw new Error("请完整填写模型名称和 API Key");
    return {endpoint, model, apiKey};
  }

  async function testAIConnection(){
    const previous = localStorage.getItem(AI_CONFIG_KEY);
    const message = $("#aiSettingsMessage");
    try {
      localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(readAIForm()));
      message.textContent = "正在测试连接…";
      message.classList.remove("error");
      const reply = await callAI("你是连接测试助手。", "只回复 OK");
      message.textContent = `连接成功：${reply.slice(0,40)}`;
      updateAIStatus();
    } catch(error) {
      if(previous) localStorage.setItem(AI_CONFIG_KEY, previous); else localStorage.removeItem(AI_CONFIG_KEY);
      message.textContent = error.message;
      message.classList.add("error");
    }
  }

  function renderAdvice(project, loading=false){
    $("#adviceProject").textContent = `LV${project.difficulty} · ${project.name}`;
    const content = $("#adviceContent");
    content.classList.toggle("loading", loading);
    content.textContent = loading ? "正在把项目拆成可执行步骤" : (project.aiAdvice?.text || "还没有生成建议。点击“重新生成”即可调用 AI。 ");
  }

  function openAdvice(id){
    const project = data.find(item => item.id === id);
    if(!project) return;
    adviceProjectId = id;
    $("#adviceTitle").textContent = "操作步骤建议";
    renderAdvice(project);
    $("#adviceDlg").showModal();
    if(!project.aiAdvice && getAIConfig()) generateAdvice();
    if(!getAIConfig()) showToast("配置 AI 模型后即可生成专属步骤建议");
  }

  async function generateAdvice(){
    const project = data.find(item => item.id === adviceProjectId);
    if(!project) return;
    if(!getAIConfig()){
      openAISettings("请先配置模型，再生成操作步骤建议。");
      return;
    }
    const button = $("#refreshAdviceBtn");
    button.disabled = true;
    renderAdvice(project, true);
    try {
      const system = "你是务实的 AI 项目执行教练。把模糊想法拆成能立即开始、可检查、风险透明的中文步骤。不要空话，不要承诺无法验证的结果。";
      const prompt = `项目资料：${JSON.stringify(projectForPrompt(project))}\n请给出：1）最小可行版本目标；2）6-9 个编号操作步骤；3）需要准备的工具或资料；4）最容易卡住的两点与应对；5）完成标准。使用清晰的纯文本。`;
      const text = await callAI(system, prompt);
      project.aiAdvice = {text, generatedAt:new Date().toISOString()};
      save();
      renderAdvice(project);
      showToast("步骤建议已生成并保存");
    } catch(error) {
      renderAdvice(project);
      showToast(error.message, true);
    } finally {
      button.disabled = false;
    }
  }

  function renderPendingImages(){
    $("#versionImagePreview").innerHTML = pendingVersionImages.map((image, index) => `<div class="pending-image"><img src="${esc(image.dataUrl)}" alt="${esc(image.name)}" title="${esc(image.name)}" /><button type="button" data-remove-pending-image="${index}" aria-label="移除 ${esc(image.name || "图片")}">×</button></div>`).join("");
  }

  async function addPendingVersionImages(files, {replace=false}={}){
    const imageFiles = [...files].filter(file => file?.type?.startsWith("image/"));
    if(!imageFiles.length) return 0;
    if(replace) pendingVersionImages = [];
    const room = MAX_IMAGES_PER_VERSION - pendingVersionImages.length;
    if(room <= 0) throw new Error(`每条版本记录最多添加 ${MAX_IMAGES_PER_VERSION} 张图片`);
    const accepted = imageFiles.slice(0, room);
    $("#versionImagePreview").innerHTML = pendingVersionImages.length
      ? `${pendingVersionImages.map(image => `<img src="${esc(image.dataUrl)}" alt="${esc(image.name)}" title="${esc(image.name)}" />`).join("")}<span>正在压缩新图片…</span>`
      : "正在压缩图片…";
    for(const file of accepted) pendingVersionImages.push(await imageFromFile(file));
    renderPendingImages();
    if(imageFiles.length > accepted.length) showToast(`已添加 ${accepted.length} 张；每条版本记录最多 ${MAX_IMAGES_PER_VERSION} 张`, true);
    return accepted.length;
  }

  async function imageFromFile(file){
    if(!file.type.startsWith("image/")) throw new Error(`${file.name} 不是图片`);
    if(file.size > 12 * 1024 * 1024) throw new Error(`${file.name} 超过 12MB`);
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 960 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    let quality = .78;
    let dataUrl = canvas.toDataURL("image/webp", quality);
    while(dataUrl.length > 240_000 && quality > .42){
      quality -= .08;
      dataUrl = canvas.toDataURL("image/webp", quality);
    }
    return {name:file.name, dataUrl, width:canvas.width, height:canvas.height};
  }

  function renderVersions(project){
    const versions = [...(project.versions || [])].sort((a,b) => String(b.date || "").localeCompare(String(a.date || "")) || String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    $("#versionTimeline").innerHTML = versions.length ? versions.map(version => `
      <article class="version-entry" data-version-entry="${esc(version.id)}">
        <div class="version-actions"><button class="edit-version" type="button" data-edit-version="${esc(version.id)}" title="编辑这条版本记录">编辑</button><button class="delete-version" type="button" data-delete-version="${esc(version.id)}" title="删除这条版本记录">删除</button></div>
        <div class="version-date">${esc(version.date || "未标日期")}</div>
        <div>
          <div class="version-text">${esc(version.description || "仅记录图片")}</div>
          ${version.images?.length ? `<div class="version-gallery">${version.images.map((image, imageIndex) => `<button type="button" data-view-version-image="${esc(version.id)}" data-image-index="${imageIndex}" aria-label="查看大图：${esc(image.name || `版本图片 ${imageIndex + 1}`)}"><img src="${esc(image.dataUrl)}" alt="${esc(image.name || "版本图片")}" /></button>`).join("")}</div>` : ""}
        </div>
      </article>`).join("") : `<div class="version-empty">还没有版本记录。把每一次小进展留下来，它会慢慢长成项目的生长年轮。</div>`;
  }

  function resetVersionComposer(){
    editingVersionId = "";
    pendingVersionImages = [];
    $("#versionDate").value = today();
    $("#versionDescription").value = "";
    $("#versionImages").value = "";
    $("#versionComposerMode").textContent = "新增记录";
    $("#versionComposerTitle").textContent = "记录一个新版本";
    $("#saveVersionBtn").textContent = "保存版本记录";
    $("#cancelVersionEdit").hidden = true;
    renderPendingImages();
  }

  function editVersion(id){
    const project = data.find(item => item.id === versionProjectId);
    const version = project?.versions?.find(item => item.id === id);
    if(!version) return;
    editingVersionId = id;
    pendingVersionImages = (version.images || []).map(image => ({...image}));
    $("#versionDate").value = version.date || today();
    $("#versionDescription").value = version.description || "";
    $("#versionImages").value = "";
    $("#versionComposerMode").textContent = "编辑记录";
    $("#versionComposerTitle").textContent = version.date ? `正在编辑 ${version.date}` : "正在编辑未标日期版本";
    $("#saveVersionBtn").textContent = "保存修改";
    $("#cancelVersionEdit").hidden = false;
    renderPendingImages();
    $(".version-composer").scrollIntoView({behavior:"smooth", block:"start"});
    $("#versionDescription").focus();
  }

  function renderVersionLightbox(){
    const image = lightboxImages[lightboxImageIndex];
    if(!image) return;
    $("#lightboxImage").src = image.dataUrl;
    $("#lightboxImage").alt = image.name || "版本图片大图";
    $("#lightboxCaption").textContent = image.name || "版本图片";
    $("#lightboxCounter").textContent = `${lightboxImageIndex + 1} / ${lightboxImages.length}`;
    $("#lightboxPrev").disabled = lightboxImages.length < 2;
    $("#lightboxNext").disabled = lightboxImages.length < 2;
  }

  function openVersionLightbox(versionId, imageIndex){
    const project = data.find(item => item.id === versionProjectId);
    const version = project?.versions?.find(item => item.id === versionId);
    lightboxImages = (version?.images || []).map(image => ({...image}));
    if(!lightboxImages.length) return;
    lightboxImageIndex = Math.max(0, Math.min(Number(imageIndex) || 0, lightboxImages.length - 1));
    renderVersionLightbox();
    if(!$("#versionLightboxDlg").open) $("#versionLightboxDlg").showModal();
  }

  function shiftVersionLightbox(direction){
    if(lightboxImages.length < 2) return;
    lightboxImageIndex = (lightboxImageIndex + direction + lightboxImages.length) % lightboxImages.length;
    renderVersionLightbox();
  }

  function openVersions(id){
    const project = data.find(item => item.id === id);
    if(!project) return;
    versionProjectId = id;
    $("#versionsTitle").textContent = `${project.name} · 版本记录`;
    resetVersionComposer();
    renderVersions(project);
    $("#versionsDlg").showModal();
  }

  async function saveVersion(){
    const project = data.find(item => item.id === versionProjectId);
    if(!project) return;
    const description = $("#versionDescription").value.trim();
    if(!description && !pendingVersionImages.length){ showToast("请填写版本说明或上传图片", true); return; }
    const existing = editingVersionId ? project.versions.find(item => item.id === editingVersionId) : null;
    const version = {
      id:existing?.id || uid("version"),
      date:$("#versionDate").value || today(),
      description,
      images:pendingVersionImages,
      createdAt:existing?.createdAt || new Date().toISOString(),
      updatedAt:new Date().toISOString()
    };
    const before = [...project.versions];
    project.versions = existing
      ? project.versions.map(item => item.id === existing.id ? version : item)
      : [version, ...project.versions];
    if(JSON.stringify(data).length > MAX_LOCAL_JSON_CHARS){
      project.versions = before;
      showToast("图片累计容量已接近浏览器上限。请减少图片或先导出 JSON 备份。", true);
      return;
    }
    project.updatedAt = today();
    save();
    render();
    renderVersions(project);
    resetVersionComposer();
    showToast(existing ? "版本记录已更新并同步" : "版本记录已保存并同步");
  }

  function bindDragAndDrop(){
    document.querySelector(".kanban")?.addEventListener("dragstart", event => {
      const card = event.target.closest(".card[data-project-id]");
      if(!card || !canManualReorder()) return event.preventDefault();
      draggedProjectId = card.dataset.projectId;
      card.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", draggedProjectId);
    });
    document.querySelector(".kanban")?.addEventListener("dragover", event => {
      const target = event.target.closest(".card[data-project-id]");
      const source = data.find(item => item.id === draggedProjectId);
      if(!target || !source || target.dataset.status !== source.status || target.dataset.projectId === draggedProjectId) return;
      event.preventDefault();
      document.querySelectorAll(".card.drop-before,.card.drop-after").forEach(card => card.classList.remove("drop-before", "drop-after"));
      const rect = target.getBoundingClientRect();
      target.classList.add(event.clientY < rect.top + rect.height / 2 ? "drop-before" : "drop-after");
    });
    document.querySelector(".kanban")?.addEventListener("drop", event => {
      const target = event.target.closest(".card[data-project-id]");
      const source = data.find(item => item.id === draggedProjectId);
      if(!target || !source || target.dataset.status !== source.status) return;
      event.preventDefault();
      const siblings = data.filter(item => item.status === source.status).sort((a,b) => Number(a.order) - Number(b.order));
      const from = siblings.findIndex(item => item.id === source.id);
      let to = siblings.findIndex(item => item.id === target.dataset.projectId);
      const rect = target.getBoundingClientRect();
      const after = event.clientY >= rect.top + rect.height / 2;
      const [moved] = siblings.splice(from, 1);
      if(from < to) to -= 1;
      siblings.splice(to + (after ? 1 : 0), 0, moved);
      reorderStatus(source.status, siblings.map(item => item.id));
      save();
      render();
    });
    document.querySelector(".kanban")?.addEventListener("dragend", () => {
      draggedProjectId = "";
      document.querySelectorAll(".card.dragging,.card.drop-before,.card.drop-after").forEach(card => card.classList.remove("dragging", "drop-before", "drop-after"));
    });
  }

  globalThis.ProjectEnhancements = {
    estimateDifficulty,
    difficultyReasonForSave: previous => difficultyTouched ? $("#difficultyHint").textContent.trim() : (previous?.difficultyReason || ""),
    afterProjectSaved: async (id, {isNew=false}={}) => {
      const project = data.find(item => item.id === id);
      if(!project) return;
      if(!project.difficultyReason && !difficultyTouched){
        project.difficulty = estimateDifficulty(project);
        project.difficultyReason = "本地规则初评；可点击 AI 评估获得更精细等级";
        save();
        render();
      }
      if(isNew && getAIConfig()){
        showToast("项目已保存，AI 正在后台评估难度…");
        try { await evaluateProjectDifficulty(project, {silent:true}); showToast(`${project.name} 难度已自动更新为 LV${project.difficulty}`); }
        catch(error){ showToast(`项目已保存，但 AI 难度评估失败：${error.message}`, true); }
      }
    }
  };

  $("#aiSettingsBtn").addEventListener("click", () => openAISettings());
  $("#closeAiSettingsDlg").addEventListener("click", () => $("#aiSettingsDlg").close());
  $("#aiSettingsForm").addEventListener("submit", event => {
    event.preventDefault();
    try {
      localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(readAIForm()));
      updateAIStatus();
      $("#aiSettingsDlg").close();
      showToast("AI 模型配置已保存");
    } catch(error) {
      $("#aiSettingsMessage").textContent = error.message;
      $("#aiSettingsMessage").classList.add("error");
    }
  });
  $("#testAiBtn").addEventListener("click", testAIConnection);
  $("#disconnectAi").addEventListener("click", () => {
    localStorage.removeItem(AI_CONFIG_KEY);
    updateAIStatus();
    $("#aiSettingsDlg").close();
    showToast("AI 配置已从当前浏览器清除");
  });
  $("#estimateDifficultyBtn").addEventListener("click", evaluateFormDifficulty);
  $("#fdifficulty").addEventListener("change", () => {
    difficultyTouched = true;
    $("#difficultyHint").textContent = "手动设置；可随时点击 AI 评估重新计算。";
  });
  ["fname", "fpurpose", "fanalysis", "fnext", "ffeas", "fnature"].forEach(id => {
    $("#" + id).addEventListener(id === "ffeas" || id === "fnature" ? "change" : "input", () => {
      if(difficultyTouched) return;
      clearTimeout(difficultyTimer);
      difficultyTimer = setTimeout(() => {
        const level = estimateDifficulty({
          name:$("#fname").value,
          purpose:$("#fpurpose").value,
          analysis:$("#fanalysis").value,
          nextAction:$("#fnext").value,
          feasibility:$("#ffeas").value,
          nature:$("#fnature").value
        });
        $("#fdifficulty").value = String(level);
        $("#difficultyHint").textContent = `本地实时初评 LV${level}；保存后可由 AI 自动复评。`;
      }, 260);
    });
  });

  $("#aiSortBtn").addEventListener("click", aiSortPending);
  $("#closeAdviceDlg").addEventListener("click", () => $("#adviceDlg").close());
  $("#refreshAdviceBtn").addEventListener("click", generateAdvice);
  $("#copyAdviceBtn").addEventListener("click", async () => {
    const text = $("#adviceContent").textContent;
    try { await navigator.clipboard.writeText(text); showToast("建议已复制"); }
    catch(error){ showToast("复制失败，请手动选择文本", true); }
  });
  $("#closeVersionsDlg").addEventListener("click", () => $("#versionsDlg").close());
  $("#cancelVersionEdit").addEventListener("click", resetVersionComposer);
  $("#versionImages").addEventListener("change", async event => {
    const files = [...event.target.files].slice(0, MAX_IMAGES_PER_VERSION);
    try {
      await addPendingVersionImages(files, {replace:true});
    } catch(error) {
      pendingVersionImages = [];
      renderPendingImages();
      showToast(error.message, true);
    }
  });
  $("#versionsDlg").addEventListener("paste", async event => {
    const clipboard = event.clipboardData;
    if(!clipboard) return;
    const itemFiles = [...(clipboard.items || [])]
      .filter(item => item.type?.startsWith("image/"))
      .map(item => item.getAsFile())
      .filter(Boolean);
    const files = itemFiles.length ? itemFiles : [...(clipboard.files || [])].filter(file => file.type?.startsWith("image/"));
    if(!files.length) return;
    event.preventDefault();
    try {
      const added = await addPendingVersionImages(files);
      if(added) showToast(`已从剪贴板粘贴 ${added} 张图片`);
    } catch(error) {
      renderPendingImages();
      showToast(error.message, true);
    }
  });
  $("#saveVersionBtn").addEventListener("click", saveVersion);
  $("#versionImagePreview").addEventListener("click", event => {
    const button = event.target.closest("[data-remove-pending-image]");
    if(!button) return;
    pendingVersionImages.splice(Number(button.dataset.removePendingImage), 1);
    renderPendingImages();
  });
  $("#versionTimeline").addEventListener("click", event => {
    const imageButton = event.target.closest("[data-view-version-image]");
    if(imageButton){ openVersionLightbox(imageButton.dataset.viewVersionImage, imageButton.dataset.imageIndex); return; }
    const editButton = event.target.closest("[data-edit-version]");
    if(editButton){ editVersion(editButton.dataset.editVersion); return; }
    const button = event.target.closest("[data-delete-version]");
    if(!button || !confirm("确定删除这条版本记录吗？")) return;
    const project = data.find(item => item.id === versionProjectId);
    project.versions = project.versions.filter(version => version.id !== button.dataset.deleteVersion);
    if(editingVersionId === button.dataset.deleteVersion) resetVersionComposer();
    save();
    render();
    renderVersions(project);
  });
  $("#closeVersionLightbox").addEventListener("click", () => $("#versionLightboxDlg").close());
  $("#lightboxPrev").addEventListener("click", () => shiftVersionLightbox(-1));
  $("#lightboxNext").addEventListener("click", () => shiftVersionLightbox(1));
  $("#versionLightboxDlg").addEventListener("click", event => {
    if(event.target === $("#versionLightboxDlg")) $("#versionLightboxDlg").close();
  });
  $("#versionLightboxDlg").addEventListener("keydown", event => {
    if(event.key === "ArrowLeft") shiftVersionLightbox(-1);
    if(event.key === "ArrowRight") shiftVersionLightbox(1);
  });

  document.body.addEventListener("click", event => {
    const advice = event.target.closest("[data-advice]");
    if(advice){ openAdvice(advice.dataset.advice); return; }
    const versions = event.target.closest("[data-versions]");
    if(versions){ openVersions(versions.dataset.versions); return; }
    const portfolio = event.target.closest("[data-portfolio]");
    if(portfolio){ location.href = `./portfolio.html?project=${encodeURIComponent(portfolio.dataset.portfolio)}&edit=1`; return; }
    const move = event.target.closest("[data-move]");
    if(move){ moveProject(move.dataset.project, move.dataset.move); return; }
  });
  ["q", "natureFilter", "feasFilter", "resultFilter", "sortMode"].forEach(id => $("#" + id).addEventListener(id === "q" ? "input" : "change", updateDragState));
  document.querySelectorAll(".filter-chip").forEach(chip => chip.addEventListener("click", () => setTimeout(updateDragState)));
  $("#clearBtn").addEventListener("click", () => setTimeout(() => { $("#sortMode").value = "manual"; render(); }));
  bindDragAndDrop();
  render();
})();
