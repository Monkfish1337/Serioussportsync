#!/usr/bin/env python3
"""Generate the bundled artwork for the seven `discovered-*` promotions.

These catalogs are produced from release listings, so there is no upstream
poster to fetch and every one of them fell back to the SSS banner — seven
identical rows on the home screen with nothing to tell them apart. The tiles
below are flat vector marks drawn from scratch: one silhouette per sport, one
accent colour, the same frame throughout so they read as a set.

Run from the repo root:  python3 scripts/make-discovered-art.py
Writes public/discovered-<sport>.png (1000x563, landscape).
"""

import os
import cairosvg

W, H = 1000, 563
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'public')

# id -> (label, accent, deep accent, glyph svg drawn in a 200x200 box at 0,0)
BALL = '''
  <circle cx="100" cy="100" r="92" fill="#ffffff"/>
  <path d="M100 20 L162 65 L138 138 L62 138 L38 65 Z" fill="{deep}"/>
  <path d="M100 20 L100 -6 M162 65 L188 56 M138 138 L154 162 M62 138 L46 162 M38 65 L12 56"
        stroke="{deep}" stroke-width="11" fill="none"/>
  <circle cx="100" cy="100" r="92" fill="none" stroke="{deep}" stroke-width="8"/>
'''

AMERICAN = '''
  <ellipse cx="100" cy="100" rx="94" ry="58" fill="#ffffff"/>
  <ellipse cx="100" cy="100" rx="94" ry="58" fill="none" stroke="{deep}" stroke-width="9"/>
  <path d="M52 100 H148" stroke="{deep}" stroke-width="9" stroke-linecap="round"/>
  <path d="M74 84 V116 M92 82 V118 M110 82 V118 M128 84 V116"
        stroke="{deep}" stroke-width="9" stroke-linecap="round"/>
'''

BASKET = '''
  <circle cx="100" cy="100" r="92" fill="#ffffff"/>
  <circle cx="100" cy="100" r="92" fill="none" stroke="{deep}" stroke-width="9"/>
  <path d="M8 100 H192 M100 8 V192" stroke="{deep}" stroke-width="9"/>
  <path d="M34 34 C78 78 78 122 34 166" stroke="{deep}" stroke-width="9" fill="none"/>
  <path d="M166 34 C122 78 122 122 166 166" stroke="{deep}" stroke-width="9" fill="none"/>
'''

BASEBALL = '''
  <circle cx="100" cy="100" r="92" fill="#ffffff"/>
  <circle cx="100" cy="100" r="92" fill="none" stroke="{deep}" stroke-width="9"/>
  <path d="M40 26 C74 74 74 126 40 174" stroke="{deep}" stroke-width="8" fill="none"/>
  <path d="M160 26 C126 74 126 126 160 174" stroke="{deep}" stroke-width="8" fill="none"/>
  <path d="M52 52 L66 44 M50 74 L65 68 M49 100 L64 100 M50 126 L65 132 M52 148 L66 156"
        stroke="{deep}" stroke-width="7" stroke-linecap="round"/>
  <path d="M148 52 L134 44 M150 74 L135 68 M151 100 L136 100 M150 126 L135 132 M148 148 L134 156"
        stroke="{deep}" stroke-width="7" stroke-linecap="round"/>
'''

HOCKEY = '''
  <path d="M22 18 L150 132" stroke="#ffffff" stroke-width="15" stroke-linecap="round"/>
  <path d="M150 132 L188 138" stroke="#ffffff" stroke-width="19" stroke-linecap="round"/>
  <path d="M178 18 L50 132" stroke="#ffffff" stroke-width="15" stroke-linecap="round"/>
  <path d="M50 132 L12 138" stroke="#ffffff" stroke-width="19" stroke-linecap="round"/>
  <ellipse cx="100" cy="164" rx="44" ry="17" fill="#ffffff"/>
  <rect x="56" y="140" width="88" height="24" fill="#ffffff"/>
  <ellipse cx="100" cy="140" rx="44" ry="17" fill="#ffffff"/>
  <ellipse cx="100" cy="140" rx="44" ry="17" fill="none" stroke="{deep}" stroke-width="7"/>
'''

RUGBY = '''
  <g transform="rotate(-28 100 100)">
    <ellipse cx="100" cy="100" rx="96" ry="52" fill="#ffffff"/>
    <ellipse cx="100" cy="100" rx="96" ry="52" fill="none" stroke="{deep}" stroke-width="9"/>
    <path d="M46 100 H154" stroke="{deep}" stroke-width="8"/>
    <path d="M62 100 L74 86 M62 100 L74 114 M88 86 V114 M112 86 V114 M138 100 L126 86 M138 100 L126 114"
          stroke="{deep}" stroke-width="8" stroke-linecap="round"/>
  </g>
'''

TROPHY = '''
  <path d="M62 18 H138 V78 A38 38 0 0 1 62 78 Z" fill="#ffffff"/>
  <path d="M62 30 H34 V52 A32 32 0 0 0 66 84" fill="none" stroke="#ffffff" stroke-width="12"/>
  <path d="M138 30 H166 V52 A32 32 0 0 1 134 84" fill="none" stroke="#ffffff" stroke-width="12"/>
  <path d="M100 116 V150" stroke="#ffffff" stroke-width="16" stroke-linecap="round"/>
  <path d="M56 176 H144 L134 150 H66 Z" fill="#ffffff"/>
  <path d="M100 40 L108 58 H126 L112 70 L118 88 L100 77 L82 88 L88 70 L74 58 H92 Z" fill="{deep}"/>
'''

SPORTS = [
    ('football',        'Football',          '#2fbf71', '#0f5132', BALL),
    ('americanfootball', 'American Football', '#e2703a', '#6b2410', AMERICAN),
    ('basketball',      'Basketball',        '#f0932b', '#7a3d05', BASKET),
    ('baseball',        'Baseball',          '#2f80ed', '#10375c', BASEBALL),
    ('hockey',          'Hockey',            '#56ccf2', '#0d3b52', HOCKEY),
    ('rugby',           'Rugby',             '#9b5de5', '#3d1c66', RUGBY),
    ('other',           'Other Sports',      '#8d99ae', '#2b2d42', TROPHY),
]

TEMPLATE = '''<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#11151c"/>
      <stop offset="55%" stop-color="#1b2230"/>
      <stop offset="100%" stop-color="{deep}"/>
    </linearGradient>
  </defs>
  <rect width="{w}" height="{h}" fill="url(#bg)"/>
  <rect x="0" y="0" width="{w}" height="8" fill="{accent}"/>
  <g opacity="0.10">
    <circle cx="880" cy="80" r="240" fill="{accent}"/>
  </g>
  <g transform="translate(84 {gy}) scale(1.25)">
    {glyph}
  </g>
  <text x="380" y="270" font-family="Poppins, DejaVu Sans, sans-serif" font-size="34"
        font-weight="600" fill="{accent}" letter-spacing="7">DISCOVERED</text>
  <text x="380" y="345" font-family="Poppins, DejaVu Sans, sans-serif" font-size="62"
        font-weight="700" fill="#ffffff" textLength="{label_len}" lengthAdjust="spacingAndGlyphs">{label}</text>
  <text x="380" y="392" font-family="Poppins, DejaVu Sans, sans-serif" font-size="24"
        fill="#93a1b5">Events found in release listings</text>
</svg>'''


def main():
    os.makedirs(OUT, exist_ok=True)
    for sport_id, label, accent, deep, glyph in SPORTS:
        svg = TEMPLATE.format(
            w=W, h=H, accent=accent, deep=deep, label=label,
            gy=(H - 250) // 2, glyph=glyph.format(deep=deep),
            label_len=min(len(label) * 34, 560),
        )
        path = os.path.join(OUT, 'discovered-' + sport_id + '.png')
        cairosvg.svg2png(bytestring=svg.encode('utf-8'), write_to=path,
                         output_width=W, output_height=H)
        print('wrote ' + path)


if __name__ == '__main__':
    main()
