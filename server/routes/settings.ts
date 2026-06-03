import { Router } from "express";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const settingsRouter = Router();

const CONFIG_DIR = join(homedir(), ".paper");
const CONFIG_PATH = join(CONFIG_DIR, "config.yaml");

type PaperSettings = {
  provider: string;
  apiKey: string;
  imageProvider: string;
  imageApiKey: string;
  imageBaseUrl: string;
  imageModel: string;
  model: string;
  baseUrl: string;
};

type ModelOption = {
  id: string;
  ownedBy?: string;
  object?: string;
};

const DEFAULT_SETTINGS: PaperSettings = {
  provider: "scxai",
  apiKey: "",
  imageProvider: "scxai",
  imageApiKey: "",
  imageBaseUrl: "https://api.scxai.top",
  imageModel: "gpt-image-1",
  model: "claude-opus-4-6",
  baseUrl: "https://api.scxai.top",
};

const LLM_TEST_TIMEOUT_MS = 15000;

function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
}

function readConfig(): Record<string, unknown> {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return parseYaml(readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readSettings(): PaperSettings {
  const config = readConfig();
  const llm = (config.llm as Record<string, unknown> | undefined) ?? {};
  const storedProvider = String(llm.provider ?? DEFAULT_SETTINGS.provider);
  const provider = storedProvider === "deepseek" ? DEFAULT_SETTINGS.provider : storedProvider;
  const envKey = `PAPER_${provider.toUpperCase()}_API_KEY`;
  const storedBaseUrl = String(llm.baseUrl ?? "");
  const storedModel = String(llm.model ?? "");
  const storedImageBaseUrl = String(llm.imageBaseUrl ?? "");
  return {
    provider,
    apiKey: String(process.env[envKey] ?? llm.apiKey ?? ""),
    imageProvider: String(llm.imageProvider ?? DEFAULT_SETTINGS.imageProvider),
    imageApiKey: String(llm.imageApiKey ?? ""),
    imageBaseUrl: storedImageBaseUrl || DEFAULT_SETTINGS.imageBaseUrl,
    imageModel: String(llm.imageModel ?? DEFAULT_SETTINGS.imageModel),
    model: !storedModel || storedModel.startsWith("deepseek-") ? DEFAULT_SETTINGS.model : storedModel,
    baseUrl: !storedBaseUrl || storedBaseUrl === "https://api.deepseek.com" ? DEFAULT_SETTINGS.baseUrl : storedBaseUrl,
  };
}

function isAnthropicModel(model: string) {
  return /claude/i.test(model);
}

function extractModelOptions(data: any): ModelOption[] {
  const rawModels = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  const seen = new Set<string>();
  return rawModels
    .map((item: any) => ({
      id: String(item?.id ?? item?.name ?? item ?? "").trim(),
      ownedBy: item?.owned_by ? String(item.owned_by) : item?.ownedBy ? String(item.ownedBy) : undefined,
      object: item?.object ? String(item.object) : undefined,
    }))
    .filter((item: ModelOption) => {
      if (!item.id || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .sort((a: ModelOption, b: ModelOption) => a.id.localeCompare(b.id));
}

function isTextModelCandidate(model: ModelOption) {
  const id = model.id.toLowerCase();
  const nonTextPatterns = [
    /^gpt-image\b/,
    /\bimage\b/,
    /\bdall[-_]?e\b/,
    /\bflux\b/,
    /\bsdxl\b/,
    /\bstable[-_ ]?diffusion\b/,
    /\bmidjourney\b/,
    /\bwhisper\b/,
    /\btts\b/,
    /\baudio\b/,
    /\bspeech\b/,
    /\btranscrib/,
    /\bembedding\b/,
    /^text-embedding\b/,
    /\brerank\b/,
    /\bmoderation\b/,
    /^omni-moderation\b/,
    /\brealtime\b/,
  ];
  return !nonTextPatterns.some((pattern) => pattern.test(id));
}

function parseProviderError(text: string) {
  let message = text.slice(0, 220);
  try {
    const data = JSON.parse(text) as any;
    message = data?.error?.message || data?.message || message;
  } catch {
    // Keep the raw response snippet.
  }
  if (/invalid token/i.test(message)) {
    return "API Key 无效或已过期，请到 SCXAI 重新复制 Key 后再测试。";
  }
  if (/standard Claude Code client|standard Claude/i.test(message)) {
    return "该模型属于 Claude Code/CC 客户端分组，SCXAI 拒绝普通 API 客户端调用。请在 SCXAI 选择可用于普通 API 的模型，或让服务商开通该模型的 API 调用权限。";
  }
  return message;
}

async function testTextModel(settings: PaperSettings, model: string) {
  const selectedModel = model.trim();
  if (!selectedModel) return { ok: false, message: "请先选择或填写模型 ID。" };

  const baseUrl = settings.baseUrl.replace(/\/$/, "");
  const anthropic = isAnthropicModel(selectedModel);
  const response = await fetch(`${baseUrl}${anthropic ? "/v1/messages" : "/v1/chat/completions"}`, anthropic
    ? {
        method: "POST",
        signal: AbortSignal.timeout(LLM_TEST_TIMEOUT_MS),
        headers: {
          "Content-Type": "application/json",
          "x-api-key": settings.apiKey,
          "anthropic-version": "2023-06-01",
          Authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify({
          model: selectedModel,
          messages: [{ role: "user", content: "请回复：Paper-agent connected" }],
          max_tokens: 32,
          temperature: 0,
        }),
      }
    : {
        method: "POST",
        signal: AbortSignal.timeout(LLM_TEST_TIMEOUT_MS),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify({
          model: selectedModel,
          messages: [{ role: "user", content: "请回复：Paper-agent connected" }],
          max_tokens: 32,
          temperature: 0,
        }),
      });
  if (!response.ok) {
    const text = await response.text();
    return { ok: false, message: parseProviderError(text) };
  }
  return { ok: true, message: `连接成功：${selectedModel}`, model: selectedModel };
}

settingsRouter.get("/", (_req, res) => {
  const settings = readSettings();
  res.json({
    settings: {
      ...settings,
      hasApiKey: Boolean(settings.apiKey),
      hasImageApiKey: Boolean(settings.imageApiKey),
      apiKey: settings.apiKey ? `****${settings.apiKey.slice(-4)}` : "",
      imageApiKey: settings.imageApiKey ? `****${settings.imageApiKey.slice(-4)}` : "",
    },
  });
});

settingsRouter.get("/models", async (_req, res) => {
  const settings = readSettings();
  if (!settings.apiKey) {
    res.json({ ok: false, models: [], message: "未配置 API Key，请先填写并保存。" });
    return;
  }

  try {
    const baseUrl = settings.baseUrl.replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/v1/models`, {
      method: "GET",
      signal: AbortSignal.timeout(LLM_TEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
      },
    });
    if (!response.ok) {
      const text = await response.text();
      res.json({ ok: false, models: [], message: parseProviderError(text) });
      return;
    }
    const data = await response.json();
    const allModels = extractModelOptions(data);
    const models = allModels.filter(isTextModelCandidate);
    const hiddenCount = allModels.length - models.length;
    res.json({
      ok: true,
      models,
      currentModel: settings.model,
      message: models.length
        ? `已拉取 ${allModels.length} 个模型 ID，已隐藏 ${hiddenCount} 个图像/音频/向量等非文本模型，当前显示 ${models.length} 个文本候选。是否支持 Paper-agent 文本生成仍请用“测试连接”确认。`
        : allModels.length
          ? `已拉取 ${allModels.length} 个模型 ID，但过滤后没有发现文本生成候选。你仍可手动输入模型 ID 后测试。`
          : "模型接口可访问，但没有返回模型列表。",
    });
  } catch (error: any) {
    const message = /timeout|aborted/i.test(error.message ?? String(error))
      ? "模型列表拉取超时，请检查 SCXAI Base URL、API Key 或稍后重试。"
      : error.message ?? String(error);
    res.json({ ok: false, models: [], message });
  }
});

settingsRouter.put("/", (req, res) => {
  const incoming = req.body?.settings ?? {};
  const current = readConfig();
  const currentLlm = (current.llm as Record<string, unknown> | undefined) ?? {};
  const next: PaperSettings = {
    provider: DEFAULT_SETTINGS.provider,
    apiKey: String(incoming.apiKey || currentLlm.apiKey || ""),
    imageProvider: String(incoming.imageProvider || currentLlm.imageProvider || DEFAULT_SETTINGS.imageProvider),
    imageApiKey: String(incoming.imageApiKey || currentLlm.imageApiKey || ""),
    imageBaseUrl: String(incoming.imageBaseUrl || currentLlm.imageBaseUrl || DEFAULT_SETTINGS.imageBaseUrl),
    imageModel: String(incoming.imageModel || currentLlm.imageModel || DEFAULT_SETTINGS.imageModel),
    model: String(incoming.model ?? currentLlm.model ?? DEFAULT_SETTINGS.model),
    baseUrl: DEFAULT_SETTINGS.baseUrl,
  };

  ensureConfigDir();
  writeFileSync(CONFIG_PATH, stringifyYaml({ ...current, llm: next }), "utf-8");
  res.json({
    success: true,
    settings: {
      ...next,
      apiKey: next.apiKey ? `****${next.apiKey.slice(-4)}` : "",
      imageApiKey: next.imageApiKey ? `****${next.imageApiKey.slice(-4)}` : "",
    },
  });
});

settingsRouter.post("/test", async (_req, res) => {
  const settings = readSettings();
  if (!settings.apiKey) {
    res.json({ ok: false, message: "未配置 API Key，请先填写并保存。" });
    return;
  }

  try {
    res.json(await testTextModel(settings, settings.model));
  } catch (error: any) {
    const message = /timeout|aborted/i.test(error.message ?? String(error))
      ? "外部 API 测试超时，请检查当前模型是否可用于普通 API 调用，或切换为 SCXAI 已开通的模型。"
      : error.message ?? String(error);
    res.json({ ok: false, message });
  }
});

settingsRouter.post("/test-model", async (req, res) => {
  const settings = readSettings();
  if (!settings.apiKey) {
    res.json({ ok: false, message: "未配置 API Key，请先填写并保存。" });
    return;
  }

  try {
    const model = String(req.body?.model || settings.model || "").trim();
    res.json(await testTextModel(settings, model));
  } catch (error: any) {
    const message = /timeout|aborted/i.test(error.message ?? String(error))
      ? "外部 API 测试超时，请检查该模型是否可用于普通 API 调用，或换一个模型再测。"
      : error.message ?? String(error);
    res.json({ ok: false, message });
  }
});

settingsRouter.post("/test-image", async (_req, res) => {
  const settings = readSettings();
  if (!settings.imageApiKey) {
    res.json({
      ok: true,
      mode: "local",
      message: "当前未配置外部图像 API Key，将使用 Paper-agent 内置本地图表生成器。",
    });
    return;
  }

  try {
    const baseUrl = (settings.imageBaseUrl || DEFAULT_SETTINGS.imageBaseUrl).replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/v1/models`, {
      method: "GET",
      signal: AbortSignal.timeout(8000),
      headers: {
        Authorization: `Bearer ${settings.imageApiKey}`,
      },
    });
    if (!response.ok) {
      const text = await response.text();
      res.json({ ok: false, mode: "external", message: parseProviderError(text) });
      return;
    }
    res.json({
      ok: true,
      mode: "external",
      message: `外部图像服务连接成功：${settings.imageProvider || "custom"} / ${settings.imageModel || "未指定模型"}`,
    });
  } catch (error: any) {
    const message = /abort|timeout/i.test(error.message ?? "")
      ? "外部图像服务连接超时。当前已配置图像 API Key，因此系统会尝试外部图像服务；如需使用本地生成器，请清空图像 API Key 后保存。请确认图像服务 Base URL 可访问。"
      : error.message ?? String(error);
    res.json({
      ok: false,
      mode: "external",
      message,
    });
  }
});

export function getRuntimeSettings(): PaperSettings {
  return readSettings();
}
