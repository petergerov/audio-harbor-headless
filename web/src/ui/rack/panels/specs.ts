import type { PanelSpec } from './panelSpec';

/**
 * Pages for the plugins Audio Harbor ships (LSP Plugins, CLAP). A plugin without an entry gets
 * the generic parameter list; one with an entry gets its page, and the list a tap away.
 */
export const PANELS: Record<string, PanelSpec> = {
  'in.lsp-plug.graph_equalizer_x16_stereo': {
    sections: [
      { kind: 'faders', match: /^Band gain /, range: 15 },
      { kind: 'knobs', params: [['Input gain', 'Input'], ['Output gain', 'Output']] },
      { kind: 'rows', params: [['Equalizer mode', 'Mode'], ['Filter slope', 'Slope']] },
    ],
  },
  'in.lsp-plug.para_equalizer_x16_stereo': {
    sections: [
      {
        kind: 'eqCurve',
        first: 0,
        count: 16,
        bands: {
          type: 'Filter type #',
          freq: 'Frequency #',
          gain: 'Gain #',
          q: 'Quality factor #',
          width: 'Filter Width #',
          slope: 'Filter slope #',
        },
      },
      { kind: 'knobs', params: [['Input gain', 'Input'], ['Output gain', 'Output']] },
      { kind: 'rows', params: [['Equalizer mode', 'Mode']] },
    ],
  },
  'in.lsp-plug.mb_compressor_stereo': {
    sections: [
      { kind: 'meter' },
      {
        kind: 'bandTabs',
        first: 1,
        count: 8,
        enable: 'Compression band enable #',
        alwaysOn: [1],
        knobs: [
          ['Attack threshold #', 'Threshold'],
          ['Ratio #', 'Ratio'],
          ['Attack time #', 'Attack'],
          ['Release time #', 'Release'],
          ['Knee #', 'Knee'],
          ['Makeup gain #', 'Makeup'],
        ],
        rows: [
          ['Split frequency #', 'From'],
          ['Compressor enable #', 'Compress'],
        ],
      },
      { kind: 'knobs', title: 'Overall', params: [['Input gain', 'Input'], ['Output gain', 'Output'], ['Dry/Wet balance', 'Mix']] },
      { kind: 'rows', params: [['Compressor mode', 'Mode']] },
    ],
  },
  'in.lsp-plug.limiter_stereo': {
    sections: [
      { kind: 'meter' },
      {
        kind: 'knobs',
        params: [
          ['Threshold', 'Threshold'],
          ['Input gain', 'Input'],
          ['Output gain', 'Ceiling'],
          ['Lookahead', 'Lookahead'],
          ['Attack time', 'Attack'],
          ['Release time', 'Release'],
        ],
      },
      {
        kind: 'rows',
        params: [
          ['Operating mode', 'Mode'],
          ['Oversampling', 'Oversampling'],
          ['Dithering', 'Dither'],
          ['Automatic level regulation', 'Auto level'],
        ],
      },
    ],
  },
  'in.lsp-plug.loud_comp_stereo': {
    sections: [
      {
        kind: 'note',
        text: 'Quiet listening loses bass and treble to the ear. Set Volume to how loud you listen; the curve gives back what the ear misses.',
      },
      { kind: 'knobs', params: [['Output volume', 'Volume'], ['Input gain', 'Input']] },
      { kind: 'rows', params: [['Loudness contour standard', 'Curve'], ['Processing mode', 'Mode'], ['Hard-clipping enable', 'Clip guard']] },
    ],
  },
};
