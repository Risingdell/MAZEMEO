import type { BiomeId, EdgeKind, ToolKind } from '@mazemeo/maze-core';

/** UI colours for the debug overlay, legend and markers. */

/** Representative ground colour per biome (region legend swatches). */
export const GROUND: Record<BiomeId, number> = {
  bamboo: 0x5f6e38,
  maple: 0x6e4a2c,
  shrine: 0x4b5a38,
  marsh: 0x4d5948,
  summit: 0x837d74,
};

export const EDGE_COLORS: Record<EdgeKind, number> = {
  path: 0xf4ead0,
  climb: 0xffa23a,
  grapple: 0x3fd4ff,
};

export const TOOL_COLORS: Record<ToolKind, number> = {
  smoke_bomb: 0xe8e8e8,
  snare_trap: 0xd8b13a,
  grapple_charge: 0x3fd4ff,
  scout_kite: 0xff5fd0,
};

export const TOOL_LABELS: Record<ToolKind, string> = {
  smoke_bomb: 'Smoke bomb',
  snare_trap: 'Snare trap',
  grapple_charge: 'Grapple charge',
  scout_kite: 'Scout kite',
};

/** 8 distinguishable player colours. */
export const SPAWN_COLORS = [0xff4d4d, 0xffa43a, 0xffe14d, 0x5fe36b, 0x3fd4ff, 0x5f7bff, 0xb55fff, 0xff5fc0];
