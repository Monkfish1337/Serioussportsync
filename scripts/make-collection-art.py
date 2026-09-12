#!/usr/bin/env python3
"""Generate bundled artwork for the Big 3 and Unmatched collection folders.

The four original collection tiles (combat sports, wrestling, football,
motorsport) are photographic: matte-black subjects, an orange rim light, haze,
and a glowing geometric frame on a near-black ground. These two are drawn
rather than photographed, but they are drawn to sit in that set — same canvas,
same palette, same rim-light-from-behind and floor-glow construction — so a row
of collection tiles reads as one thing.

Run from the repo root:  python3 scripts/make-collection-art.py
Writes public/collection-big-3.png and public/collection-unmatched.png
(1672x941, matching the existing tiles exactly).
"""

import os
import cairosvg

W, H = 1672, 941
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'public')

# Sampled from the existing tiles rather than invented: the accent runs from a
# hot core to a deep ember, and the ground is not pure black.
ACCENT = '#ff6a1a'
ACCENT_HOT = '#ffa24d'
ACCENT_DEEP = '#7a2708'
INK = '#0a0806'
BODY = '#131110'
BODY_DARK = '#080706'

DEFS = f'''
  <radialGradient id="floorGlow" cx="50%" cy="88%" r="62%">
    <stop offset="0%" stop-color="{ACCENT}" stop-opacity=".55"/>
    <stop offset="45%" stop-color="{ACCENT_DEEP}" stop-opacity=".25"/>
    <stop offset="100%" stop-color="{INK}" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="hazeGlow" cx="50%" cy="46%" r="52%">
    <stop offset="0%" stop-color="{ACCENT}" stop-opacity=".34"/>
    <stop offset="60%" stop-color="{ACCENT_DEEP}" stop-opacity=".12"/>
    <stop offset="100%" stop-color="{INK}" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="vignette" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="{INK}" stop-opacity=".95"/>
    <stop offset="55%" stop-color="{INK}" stop-opacity=".2"/>
    <stop offset="100%" stop-color="{INK}" stop-opacity=".92"/>
  </linearGradient>
  <radialGradient id="bodyShade" cx="34%" cy="28%" r="82%">
    <stop offset="0%" stop-color="#2b2523"/>
    <stop offset="42%" stop-color="{BODY}"/>
    <stop offset="100%" stop-color="{BODY_DARK}"/>
  </radialGradient>
  <radialGradient id="bloom" cx="50%" cy="50%" r="50%">
    <stop offset="0%" stop-color="{ACCENT}" stop-opacity=".85"/>
    <stop offset="55%" stop-color="{ACCENT_DEEP}" stop-opacity=".35"/>
    <stop offset="100%" stop-color="{INK}" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="rim" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="{ACCENT_HOT}"/>
    <stop offset="55%" stop-color="{ACCENT}"/>
    <stop offset="100%" stop-color="{ACCENT_DEEP}"/>
  </linearGradient>
  <filter id="soft" x="-60%" y="-60%" width="220%" height="220%">
    <feGaussianBlur stdDeviation="34"/>
  </filter>
  <filter id="softer" x="-80%" y="-80%" width="260%" height="260%">
    <feGaussianBlur stdDeviation="54"/>
  </filter>
  <filter id="tight" x="-40%" y="-40%" width="180%" height="180%">
    <feGaussianBlur stdDeviation="7"/>
  </filter>
'''


def frame(cx, cy, r, sides=6, rotate=0):
    """The glowing polygon the existing tiles put behind their subject."""
    import math
    pts = []
    for i in range(sides):
        a = math.radians(rotate + i * 360 / sides)
        pts.append(f'{cx + r * math.cos(a):.1f},{cy + r * math.sin(a):.1f}')
    p = ' '.join(pts)
    return f'''
      <polygon points="{p}" fill="none" stroke="{ACCENT}" stroke-width="26"
               opacity=".5" filter="url(#soft)"/>
      <polygon points="{p}" fill="none" stroke="{ACCENT_HOT}" stroke-width="5" opacity=".85"/>
      <polygon points="{p}" fill="none" stroke="{ACCENT_DEEP}" stroke-width="46" opacity=".22"/>
    '''


def stage(body):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}"
     viewBox="0 0 {W} {H}">
  <defs>{DEFS}</defs>
  <rect width="{W}" height="{H}" fill="{INK}"/>
  <rect width="{W}" height="{H}" fill="url(#hazeGlow)"/>
  {body}
  <rect width="{W}" height="{H}" fill="url(#floorGlow)" opacity=".55"/>
  <rect width="{W}" height="{H}" fill="url(#vignette)"/>
</svg>'''


def american_football(cx, cy, scale=1.0):
    rx, ry = 250 * scale, 152 * scale
    return f'''
    <g transform="rotate(-18 {cx} {cy})">
      <ellipse cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}" fill="{ACCENT}"
               opacity=".55" filter="url(#soft)"/>
      <ellipse cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}" fill="url(#bodyShade)"
               stroke="url(#rim)" stroke-width="{7 * scale:.1f}"/>
      <path d="M{cx - rx * 0.62} {cy} Q {cx} {cy - ry * 0.30} {cx + rx * 0.62} {cy}"
            fill="none" stroke="{ACCENT_DEEP}" stroke-width="{5 * scale:.1f}" opacity=".8"/>
      <line x1="{cx - rx * 0.30}" y1="{cy}" x2="{cx + rx * 0.30}" y2="{cy}"
            stroke="{ACCENT_HOT}" stroke-width="{9 * scale:.1f}" opacity=".95"/>
      {''.join(f'<line x1="{cx - rx * 0.24 + i * rx * 0.16}" y1="{cy - ry * 0.16}" '
               f'x2="{cx - rx * 0.24 + i * rx * 0.16}" y2="{cy + ry * 0.16}" '
               f'stroke="{ACCENT_HOT}" stroke-width="{7 * scale:.1f}" opacity=".9"/>'
               for i in range(4))}
    </g>'''


def basketball(cx, cy, r):
    return f'''
    <g>
      <circle cx="{cx}" cy="{cy}" r="{r}" fill="{ACCENT}" opacity=".6" filter="url(#soft)"/>
      <circle cx="{cx}" cy="{cy}" r="{r}" fill="url(#bodyShade)"
              stroke="url(#rim)" stroke-width="8"/>
      <line x1="{cx - r}" y1="{cy}" x2="{cx + r}" y2="{cy}"
            stroke="{ACCENT}" stroke-width="6" opacity=".85"/>
      <line x1="{cx}" y1="{cy - r}" x2="{cx}" y2="{cy + r}"
            stroke="{ACCENT}" stroke-width="6" opacity=".85"/>
      <path d="M{cx - r * 0.72} {cy - r * 0.70} Q {cx} {cy} {cx - r * 0.72} {cy + r * 0.70}"
            fill="none" stroke="{ACCENT}" stroke-width="6" opacity=".7"/>
      <path d="M{cx + r * 0.72} {cy - r * 0.70} Q {cx} {cy} {cx + r * 0.72} {cy + r * 0.70}"
            fill="none" stroke="{ACCENT}" stroke-width="6" opacity=".7"/>
    </g>'''


def baseball(cx, cy, r):
    seam = f'''
      <path d="M{cx - r * 0.60} {cy - r * 0.76} Q {cx - r * 0.10} {cy} {cx - r * 0.60} {cy + r * 0.76}"
            fill="none" stroke="{ACCENT_HOT}" stroke-width="6" opacity=".9"/>
      <path d="M{cx + r * 0.60} {cy - r * 0.76} Q {cx + r * 0.10} {cy} {cx + r * 0.60} {cy + r * 0.76}"
            fill="none" stroke="{ACCENT_HOT}" stroke-width="6" opacity=".9"/>'''
    ticks = ''.join(
        f'<line x1="{cx - r * 0.66 + (i % 2) * 14}" y1="{cy - r * 0.62 + i * r * 0.20}" '
        f'x2="{cx - r * 0.40 + (i % 2) * 14}" y2="{cy - r * 0.56 + i * r * 0.20}" '
        f'stroke="{ACCENT_HOT}" stroke-width="5" opacity=".75"/>'
        f'<line x1="{cx + r * 0.40 - (i % 2) * 14}" y1="{cy - r * 0.62 + i * r * 0.20}" '
        f'x2="{cx + r * 0.66 - (i % 2) * 14}" y2="{cy - r * 0.56 + i * r * 0.20}" '
        f'stroke="{ACCENT_HOT}" stroke-width="5" opacity=".75"/>'
        for i in range(7))
    return f'''
    <g>
      <circle cx="{cx}" cy="{cy}" r="{r}" fill="{ACCENT}" opacity=".6" filter="url(#soft)"/>
      <circle cx="{cx}" cy="{cy}" r="{r}" fill="url(#bodyShade)"
              stroke="url(#rim)" stroke-width="8"/>
      {seam}{ticks}
    </g>'''


def question(cx, cy, scale):
    """Drawn as paths, not text: no font to depend on at build time."""
    s = scale
    return f'''
    <g>
      <path d="M{cx - 74 * s} {cy - 52 * s}
               a {74 * s} {74 * s} 0 1 1 {110 * s} {96 * s}
               q {-36 * s} {26 * s} {-36 * s} {62 * s}"
            fill="none" stroke="url(#rim)" stroke-width="{40 * s}"
            stroke-linecap="round"/>
      <circle cx="{cx}" cy="{cy + 158 * s}" r="{25 * s}" fill="{ACCENT_HOT}"/>
    </g>'''


def bloom(cx, cy, r, opacity=.55):
    return (f'<ellipse cx="{cx}" cy="{cy}" rx="{r * 1.55:.0f}" ry="{r * 1.55:.0f}" '
            f'fill="url(#bloom)" opacity="{opacity}"/>')


def reflection(cx, r, opacity=.22):
    return (f'<ellipse cx="{cx}" cy="810" rx="{r * 1.05:.0f}" ry="{r * 0.16:.0f}" '
            f'fill="{ACCENT}" opacity="{opacity}" filter="url(#soft)"/>')


def big_three():
    body = f'''
    {frame(836, 452, 330, sides=6, rotate=90)}
    {bloom(836, 452, 300, .5)}
    {bloom(360, 520, 240, .38)}
    {bloom(1320, 520, 170, .38)}
    <ellipse cx="836" cy="812" rx="600" ry="78" fill="{ACCENT}" opacity=".34" filter="url(#softer)"/>
    {reflection(360, 250)}{reflection(836, 230, .3)}{reflection(1320, 155)}
    {american_football(360, 520, 0.92)}
    {baseball(1320, 520, 150)}
    {basketball(836, 452, 228)}
    '''
    return stage(body)


def unmatched():
    """Three faint, unidentified silhouettes behind a lit question mark."""
    ghosts = f'''
    <g opacity=".30">
      {american_football(258, 612, 0.60)}
      {basketball(1418, 596, 126)}
      {baseball(836, 806, 84)}
    </g>'''
    body = f'''
    {frame(836, 430, 300, sides=6, rotate=90)}
    {bloom(836, 430, 280, .45)}
    {ghosts}
    <ellipse cx="836" cy="806" rx="560" ry="72" fill="{ACCENT}" opacity=".3" filter="url(#softer)"/>
    <g filter="url(#tight)" opacity=".75">{question(836, 382, 1.0)}</g>
    {question(836, 382, 1.0)}
    '''
    return stage(body)


def write(name, svg):
    path = os.path.join(OUT, name)
    cairosvg.svg2png(bytestring=svg.encode('utf-8'), write_to=path,
                     output_width=W, output_height=H)
    print(name, os.path.getsize(path), 'bytes')


if __name__ == '__main__':
    write('collection-big-3.png', big_three())
    write('collection-unmatched.png', unmatched())
