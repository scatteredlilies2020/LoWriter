import { AppError } from './shared.ts';
import type { Dialect } from './shared.ts';

export interface ProviderPreset {
  id: string; name: string; endpoint: string; dialect: Dialect;
  variants?: { id: string; name: string; endpoint: string }[];
  note?: string; models?: string[]; discovery?: boolean; regional?: boolean;
}
// Public metadata only. Endpoints are resolved again on the server, never trusted from a preset form.
// Source links and verification scope: docs/PROVIDERS.md.
export const providers: ProviderPreset[] = [
  { id: 'openai', name: 'OpenAI', endpoint: 'https://api.openai.com/v1', dialect: 'responses' },
  { id: 'gemini', name: 'Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta', dialect: 'gemini' },
  { id: 'glm', name: 'GLM · Z.AI', endpoint: 'https://api.z.ai/api/paas/v4', dialect: 'chat-completions', models: ['glm-5.3'], discovery: false, note: 'Z.AI general API billing. Subscription/coding-plan URLs are not interchangeable; use Custom for a different plan.' },
  { id: 'minimax', name: 'MiniMax', endpoint: 'https://api.minimax.io/anthropic/v1', dialect: 'anthropic', models: ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5'], discovery: false, note: 'International API; native Messages format preserves reasoning/tool blocks.' },
  { id: 'openrouter', name: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1', dialect: 'chat-completions' },
  { id: 'opencode', name: 'OpenCode · Zen', endpoint: 'https://opencode.ai/zen/v1', dialect: 'chat-completions', note: 'OpenCode is interpreted as Zen. Claude/Gemini/GPT models use their native protocols automatically; check the model provider’s data policy.' },
  { id: 'deepseek', name: 'DeepSeek', endpoint: 'https://api.deepseek.com', dialect: 'chat-completions' },
  { id: 'elevenlabs', name: 'ElevenLabs · Speech', endpoint: 'https://api.elevenlabs.io/v1', dialect: 'speech', note: 'Text-to-speech, not a writing/chat model. Saved separately; does not replace your writing connection.' },
  { id: 'dashscope', name: 'DashScope · Qwen', endpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', dialect: 'chat-completions', variants: [
    { id: 'singapore', name: 'Singapore / International', endpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
    { id: 'beijing', name: 'China / Beijing', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    { id: 'virginia', name: 'US / Virginia', endpoint: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1' },
  ], note: 'Choose the region that issued your API key. Workspace-specific URLs remain available through Custom.' },
  { id: 'ernie', name: 'Ernie · Baidu Qianfan', endpoint: 'https://qianfan.baidubce.com/v2', dialect: 'chat-completions', variants: [
    { id: 'china', name: 'China / Qianfan v2', endpoint: 'https://qianfan.baidubce.com/v2' },
    { id: 'international', name: 'International', endpoint: 'https://api.baiduqianfan.ai/v1' },
  ], note: 'Use a Qianfan API key, not the legacy OAuth access-key/secret-key pair.' },
  { id: 'nvidia', name: 'NVIDIA · Hosted NIM', endpoint: 'https://integrate.api.nvidia.com/v1', dialect: 'chat-completions', note: 'Hosted API catalog; self-hosted NIM can use Custom. Model availability and trial data policies vary.' },
  { id: 'mimo', name: 'Xiaomi MiMo', endpoint: 'https://api.xiaomimimo.com/v1', dialect: 'chat-completions', variants: [
    { id: 'api', name: 'Pay as you go', endpoint: 'https://api.xiaomimimo.com/v1' },
    { id: 'china', name: 'Token Plan / China', endpoint: 'https://token-plan-cn.xiaomimimo.com/v1' },
    { id: 'singapore', name: 'Token Plan / Singapore', endpoint: 'https://token-plan-sgp.xiaomimimo.com/v1' },
    { id: 'europe', name: 'Token Plan / Europe', endpoint: 'https://token-plan-ams.xiaomimimo.com/v1' },
  ] },
  { id: 'aws-claude', name: 'AWS-hosted Claude · Bedrock', endpoint: 'https://bedrock-runtime.us-east-1.amazonaws.com/anthropic/v1', dialect: 'anthropic', regional: true, discovery: false, note: 'Bedrock API key / bearer token, not an Anthropic key or AWS access-key ID. Choose your region and exact enabled model/inference-profile ID. IAM/SigV4 login is not implemented.' },
  { id: 'aws-mantle', name: 'AWS Bedrock Mantle', endpoint: 'https://bedrock-mantle.us-east-1.api.aws/v1', dialect: 'responses', regional: true, note: 'Bedrock API key; regional model access and IAM permissions still apply. Claude models use the Anthropic Messages route. IAM/SigV4 login is not implemented.' },
  { id: 'anthropic', name: 'Anthropic · Claude', endpoint: 'https://api.anthropic.com/v1', dialect: 'anthropic' },
  { id: 'xai', name: 'xAI · Grok', endpoint: 'https://api.x.ai/v1', dialect: 'responses' },
  { id: 'custom', name: 'Custom endpoint', endpoint: '', dialect: 'chat-completions', note: 'For a local model, private gateway, or another provider. Choose its protocol explicitly.' },
];
export const awsRegions = ['us-east-1', 'us-east-2', 'us-west-2', 'eu-west-1', 'eu-west-2', 'eu-central-1', 'eu-north-1', 'ap-south-1', 'ap-northeast-1', 'ap-northeast-2', 'ap-southeast-1', 'ap-southeast-2', 'ca-central-1', 'sa-east-1'];
export function preset(id: string): ProviderPreset { const p = providers.find(p => p.id === id); if (!p) throw new AppError('Unknown provider.'); return p; }
export function resolvePreset(id: string, variant?: string, region?: string, model = ''): { endpoint: string; dialect: Dialect; variant?: string; region?: string } {
  const p = preset(id); let endpoint = p.endpoint, dialect = p.dialect;
  if (p.variants) { const v = p.variants.find(v => v.id === (variant || p.variants![0].id)); if (!v) throw new AppError('Unknown provider region/plan.'); endpoint = v.endpoint; variant = v.id; }
  if (p.regional) { region ||= 'us-east-1'; if (!awsRegions.includes(region)) throw new AppError('Select a supported AWS region.'); endpoint = id === 'aws-claude' ? `https://bedrock-runtime.${region}.amazonaws.com/anthropic/v1` : `https://bedrock-mantle.${region}.api.aws/v1`; }
  if (id === 'opencode') { if (/^claude-/i.test(model)) dialect = 'anthropic'; else if (/^gemini-/i.test(model)) dialect = 'gemini'; else if (/^(gpt-|o[134](?:-|$))/i.test(model)) dialect = 'responses'; }
  if (id === 'aws-mantle' && /(?:^|\.)anthropic\./i.test(model)) { dialect = 'anthropic'; endpoint = endpoint.replace('/v1', '/anthropic/v1'); }
  return { endpoint, dialect, ...(p.variants ? { variant } : {}), ...(p.regional ? { region } : {}) };
}
