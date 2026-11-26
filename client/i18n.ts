import { defineTranslations } from "@getpaseo/plugin/client";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

/** Runtime translations for the plugin's own UI. English is required; other languages fall back to it. */
export const messages = defineTranslations({ resources: { en, "zh-CN": zhCN } });
