export { TapTempoEngine } from "./core/tap-tempo";
export { DEFAULT_OPTIONS } from "./core/types";
export type {
	EngineState,
	TapTempoOptions,
	TempoReading,
} from "./core/types";
export { createTapTempo } from "./adapters/callback";
export type { CreateTapTempoOptions, TapTempo } from "./adapters/callback";
