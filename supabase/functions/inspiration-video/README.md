# Qwen-Omni 视频分析函数

本函数负责三件事：验证现有云同步密钥、生成私密视频上传地址、调用 Qwen-Omni 深度分析视频。

部署前需要在 Supabase Edge Function Secrets 中配置：

- `DASHSCOPE_API_KEY`：阿里云百炼 API Key（必需）
- `QWEN_OMNI_MODEL`：默认为 `qwen3.5-omni-flash`
- `DASHSCOPE_BASE_URL`：默认为中国内地地址 `https://dashscope.aliyuncs.com/compatible-mode/v1`

如果 API Key 属于国际版，新加坡区可改为对应的国际版 DashScope OpenAI 兼容地址。

CLI 部署示例：

```bash
supabase functions deploy inspiration-video --project-ref eifpsbcjavsfndntctdu --no-verify-jwt
supabase secrets set DASHSCOPE_API_KEY=你的密钥 QWEN_OMNI_MODEL=qwen3.5-omni-flash --project-ref eifpsbcjavsfndntctdu
```

视频保存在自动创建的私有 Storage bucket `inspiration-videos` 中，网页端只保存对象路径，不保存视频内容或签名地址。
