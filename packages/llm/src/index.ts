/**
 * @reader/llm：LLM 网关的实现。只有这个包依赖 AI SDK（ai、@ai-sdk/openai-compatible）。
 * 界面、CLI 只调 reader.llm（@reader/core 的 LlmService）；这里提供 provider 注册和传输层。
 */
export {
  type BuiltinProviderOptions,
  PROVIDER_IDS,
  deepseekProvider,
  openAiCompatibleProvider,
  registerBuiltinLlmProviders,
  vercelGatewayProvider,
} from "./providers.js";
export {
  BRIDGE_HEADER,
  BRIDGE_PLACEHOLDER_KEY,
  BRIDGE_PREFIX,
  type FetchFn,
  type LlmTransport,
  bridgePath,
  createBridgeTransport,
  directTransport,
  networkGuardTransport,
} from "./transport.js";
export { type LlmClientParts, type SdkLanguageModel, createLlmClient } from "./client.js";
export { type CallPlan, estimateTokens, planCall } from "./plan.js";
export { imageCaption, toModelMessages } from "./messages.js";
export { toLlmErrorInfo } from "./errors.js";
export { fromGatewayModel, fromOpenAiModel, modelListEntries } from "./capabilities.js";
export * from "./defaults.js";
export {
  MemoryRecordingStore,
  RECORDING_KEY_ORDER,
  type Recording,
  type RecordingMode,
  type RecordingStore,
  type RecordReplayOptions,
  ReplayMissError,
  promptHash,
  recordReplayMiddleware,
  recordingModeFromEnv,
} from "./record-replay.js";
