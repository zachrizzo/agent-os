#!/usr/bin/env python3
"""Generate animated SVG creature avatars for every agent.

Body shape = role, color = team. Eyes are two slash strokes; body bobs and eyes blink
(CSS keyframes inside the SVG, so it animates in a plain <img>). Output:
  ~/.openclaw/workspace/avatars/creatures/<agent>.svg   (canonical)
  ~/.openclaw/workspace-<agent>/avatars/<agent>.svg      (what identity.avatar points at)
Re-run after editing AGENTS below. No external deps.

Status expressions (Agent OS): add a state class to the root <svg> and the creature changes face.
No class = the default animation, unchanged. Hidden parts (.tint .dizzy .bang) only show in their state.
  st-active  hops (every personality) at double speed, propeller keeps spinning
  st-idle    eyes closed, slow breathing, no smile
  st-needs   wide eyes + a bouncing "!" badge
  st-error   dizzy spiral eyes + red tint
prefers-reduced-motion stops all animation; the static part of each state (closed/wide/dizzy eyes, "!", tint) stays.
"""
import hashlib, pathlib

HOME = pathlib.Path.home() / ".openclaw"

# agent -> (shape, color, badge)
AGENTS = {
    "main": ("circle", "#62b8a4", None),
    "voice": ("circle", "#7cd0c3", None),
    "scout": ("mountain", "#e8a24a", None),
    "radar": ("mountain", "#6a63e6", "#ef4b4b"),
    "scrum": ("blob", "#e8789a", None),
    "coder": ("circle", "#dd7a3c", None),
    "security": ("diamond", "#d9504f", None),
    "infra": ("blob", "#7a8699", None),
    "rfc-doug": ("diamond", "#8b5cf0", None),
    "rfc-akele": ("circle", "#a370f5", None),
    "rfc-dave": ("blob", "#7d4fe0", None),
    "rfc-ryan": ("mountain", "#9a66f2", None),
    "rfc-risk": ("diamond", "#c25fd9", None),
    "zach": ("circle", "#f2b84b", None),  # Zach's profile picture (rendered to PNG, not an agent)
}
TEAMS = {
    "agent-service": "#4a82ee",
    "provider-agent-service": "#6a63e6",
    "provider-voice-app": "#8b5cf0",
    "admin-portal": "#dd7a3c",
    "sonder-rails": "#3fae78",
}
ROLE_SHAPE = {"lead": "diamond", "coder": "circle", "simplifier": "blob", "reviewer": "mountain"}
for team, color in TEAMS.items():
    for role, shape in ROLE_SHAPE.items():
        AGENTS[f"{team}-{role}"] = (shape, color, None)


# accessory kind per agent (team roles get ROLE_ACC)
ROLE_ACC = {"lead": "bowler", "coder": "propeller", "simplifier": "sprout", "reviewer": "glasses"}
ACC = {
    "main": "crown", "voice": "headset", "scout": "safari", "radar": "antenna",
    "scrum": "sticky", "coder": "propeller", "security": "cap", "infra": "hardhat",
    "rfc-doug": "wizard", "rfc-akele": "party", "rfc-dave": "grad", "rfc-ryan": "beret",
    "rfc-risk": "siren",
    "zach": "beanie",
}
for team in TEAMS:
    for role, kind in ROLE_ACC.items():
        ACC[f"{team}-{role}"] = kind

TOP = {"circle": 20, "diamond": 23, "blob": 24, "mountain": 25}
HAT_SCALE = {"circle": 1.0, "diamond": 0.9, "blob": 1.0, "mountain": 0.65}
DARK = "#2b2d42"
GOLD = "#f5c542"

HATS = {
    "beanie": '<path d="M-18,6 A18,19 0 0 1 18,6 Z" fill="#e8504f"/><rect x="-19" y="1" width="38" height="8" rx="4" fill="#c93c3b"/><circle cx="0" cy="-19" r="5.5" fill="#fff" stroke="#d3d5df" stroke-width="1.5"/>',
    "crown": f'<g transform="rotate(-6)"><polygon points="-16,4 -16,-12 -8,-4 0,-16 8,-4 16,-12 16,4" fill="{GOLD}"/><rect x="-16" y="1" width="32" height="5" rx="2" fill="#e0a92f"/></g><g transform="translate(22 -14)"><path class="twinkle" d="M0,-6 L1.6,-1.6 L6,0 L1.6,1.6 L0,6 L-1.6,1.6 L-6,0 L-1.6,-1.6Z" fill="#fff6c2"/></g>',
    "hardhat": '<path d="M-18,5 A18,17 0 0 1 18,5 Z" fill="#f58a2e"/><rect x="-23" y="3" width="46" height="6" rx="3" fill="#e0701a"/><rect x="-3" y="-13" width="6" height="16" fill="#e0701a"/>',
    "propeller": f'<path d="M-17,5 A17,15 0 0 1 17,5 Z" fill="#ffd24a"/><rect x="-18" y="2" width="36" height="6" rx="3" fill="#f0b429"/><line x1="0" y1="-10" x2="0" y2="-16" stroke="{DARK}" stroke-width="2.5" stroke-linecap="round"/><g class="spin"><ellipse cx="0" cy="-17" rx="13" ry="3.2" fill="#ef4b4b"/></g>',
    "sprout": '<line x1="0" y1="6" x2="0" y2="-9" stroke="#fff" stroke-width="3" stroke-linecap="round"/><g class="sway"><path d="M0,-8 C-14,-9 -16,-22 -4,-22 C-2,-17 0,-13 0,-8Z" fill="#8be28b"/><path d="M0,-8 C14,-9 16,-22 4,-22 C2,-17 0,-13 0,-8Z" fill="#62cf62"/></g>',
    "bowler": f'<path d="M-16,4 A16,15 0 0 1 16,4 Z" fill="{DARK}"/><rect x="-23" y="2" width="46" height="5" rx="2.5" fill="{DARK}"/><rect x="-16" y="-2" width="32" height="3.5" fill="{GOLD}"/>',
    "safari": '<ellipse cx="0" cy="4" rx="27" ry="6" fill="#a47148"/><path d="M-15,4 A15,14 0 0 1 15,4 Z" fill="#c58f5b"/><rect x="-15" y="-2" width="30" height="4" fill="#6b4a2f"/>',
    "cap": f'<path d="M-18,5 A18,15 0 0 1 18,5 Z" fill="#27324d"/><rect x="-21" y="3" width="42" height="5" rx="2.5" fill="#1b2338"/><circle cx="0" cy="-3" r="4" fill="{GOLD}"/>',
    "wizard": '<g transform="rotate(-8)"><polygon points="-17,5 0,-36 17,5" fill="#3b2a8c"/><ellipse cx="0" cy="5" rx="24" ry="5" fill="#3b2a8c"/><circle cx="-3" cy="-12" r="2.8" fill="#ffd24a"/><circle cx="5" cy="-2" r="2" fill="#ffd24a"/></g><g transform="translate(20 -26)"><path class="twinkle" d="M0,-6 L1.6,-1.6 L6,0 L1.6,1.6 L0,6 L-1.6,1.6 L-6,0 L-1.6,-1.6Z" fill="#fff6c2"/></g>',
    "party": '<polygon points="-12,5 0,-27 12,5" fill="#ffd24a"/><polygon points="-9,-3 9,-3 7,2 -7,2" fill="#ef4b4b"/><circle class="bounce" cx="0" cy="-28" r="4" fill="#ef4b4b"/>',
    "grad": f'<rect x="-13" y="2" width="26" height="9" rx="3" fill="{DARK}"/><polygon points="-27,0 0,-11 27,0 0,10" fill="{DARK}"/><g class="swing"><line x1="0" y1="0" x2="21" y2="12" stroke="{GOLD}" stroke-width="2.5" stroke-linecap="round"/><circle cx="21" cy="13" r="3" fill="{GOLD}"/></g>',
    "beret": '<ellipse cx="2" cy="-1" rx="23" ry="10" fill="#d9504f" transform="rotate(-8)"/><circle cx="5" cy="-12" r="3" fill="#b83c3b"/>',
    "siren": f'<circle class="glow" cx="0" cy="-3" r="14" fill="#ef4b4b" opacity=".25"/><rect class="glow" x="-10" y="-8" width="20" height="12" rx="4" fill="#ef4b4b"/><rect x="-14" y="3" width="28" height="5" rx="2" fill="{DARK}"/>',
    "antenna": '<line x1="0" y1="5" x2="0" y2="-14" stroke="#2b2d42" stroke-width="3" stroke-linecap="round"/><circle cx="0" cy="-17" r="4" fill="#f5c542"/><path class="ping" d="M-10,-24 Q0,-33 10,-24" stroke="#2b2d42" stroke-width="2.5" fill="none" stroke-linecap="round"/>',
    "sticky": '<g transform="translate(14 -2) rotate(14)"><g class="flutter"><rect x="-9" y="-9" width="18" height="18" rx="2" fill="#ffe27a"/><line x1="-5" y1="-3" x2="5" y2="-3" stroke="#d9b94a" stroke-width="2"/><line x1="-5" y1="2" x2="2" y2="2" stroke="#d9b94a" stroke-width="2"/></g></g>',
}


def accessory(name, shape):
    kind = ACC.get(name)
    if not kind:
        return ""
    if kind == "glasses":
        y = EYE_Y[shape]
        return (
            f'<g fill="none" stroke="{DARK}" stroke-width="3.2"><circle cx="52" cy="{y}" r="11"/>'
            f'<circle cx="76" cy="{y}" r="11"/><line x1="63" y1="{y}" x2="65" y2="{y}"/></g>'
        )
    if kind == "headset":
        return (
            f'<g fill="none" stroke="{DARK}" stroke-width="4" stroke-linecap="round">'
            f'<path d="M24,64 Q24,14 64,14 Q104,14 104,64"/><path d="M104,68 Q104,92 80,92"/></g>'
            f'<rect x="17" y="54" width="12" height="22" rx="5" fill="{DARK}"/>'
            f'<rect x="99" y="54" width="12" height="22" rx="5" fill="{DARK}"/>'
            f'<circle cx="78" cy="92" r="4.5" fill="{DARK}"/>'
        )
    sc = HAT_SCALE[shape]
    return f'<g transform="translate(64 {TOP[shape]}) scale({sc})">{HATS[kind]}</g>'


EYE_Y = {"circle": 66, "diamond": 66, "blob": 68, "mountain": 76, "cluster": None}


def eyes(cx, cy, scale=1.0, cls="eyes"):
    d = 12 * scale
    w = 7 * scale
    segs = []
    for dx in (-d, d):
        x = cx + dx
        segs.append(
            f'<line x1="{x - 2.5 * scale:.1f}" y1="{cy + 5 * scale:.1f}" '
            f'x2="{x + 2.5 * scale:.1f}" y2="{cy - 5 * scale:.1f}" '
            f'stroke="#fff" stroke-width="{w:.1f}" stroke-linecap="round"/>'
        )
    return f'<g class="look"><g class="{cls}">' + "".join(segs) + "</g></g>"


RED = "#e5383b"


def tint(shape):
    """The body outline again in red, hidden until st-error (a tint that follows every shape)."""
    t = body_shape(shape, RED)
    return f'<g class="tint">{t}</g>' if t else ""


def dizzy(shape):
    """Two spirals where the eyes are, hidden until st-error."""
    y = EYE_Y.get(shape)
    if y is None:
        return ""
    spiral = "M0,0 m-1.5,0 a1.5,1.5 0 1 1 3,0 a3.5,3.5 0 1 1 -7,0 a5.5,5.5 0 1 1 11,0 a7.5,7.5 0 1 1 -15,0"
    return "".join(
        f'<g transform="translate({64 + dx} {y})"><g class="dz"><path d="{spiral}" fill="none" stroke="#fff" '
        f'stroke-width="2.6" stroke-linecap="round"/></g></g>' for dx in (-12, 12)
    )


def body_shape(shape, color):
    if shape == "circle":
        return f'<circle cx="64" cy="64" r="46" fill="{color}"/>'
    if shape == "diamond":
        return (
            f'<rect x="26" y="26" width="76" height="76" rx="26" fill="{color}" '
            f'transform="rotate(45 64 64)"/>'
        )
    if shape == "blob":
        return f'<rect x="20" y="22" width="88" height="84" rx="36" fill="{color}"/>'
    if shape == "mountain":
        return (
            f'<polygon points="64,26 104,98 24,98" fill="{color}" stroke="{color}" '
            f'stroke-width="18" stroke-linejoin="round"/>'
        )
    return ""


EYES_AT = {"circle": (64, 66), "diamond": (64, 66), "blob": (64, 68), "mountain": (64, 78)}


def body(shape, color):
    if shape in EYES_AT:
        # shape, red tint (hidden), eyes, dizzy eyes (hidden): the first and third are exactly what the default creature always drew
        return body_shape(shape, color) + tint(shape) + eyes(*EYES_AT[shape]) + dizzy(shape)
    if shape == "cluster":
        a, b, c = "#62b8a4", "#6a63e6", "#8b5cf0"
        return (
            f'<circle cx="64" cy="38" r="24" fill="{a}"/>' + eyes(64, 39, 0.5)
            + f'<circle cx="38" cy="86" r="26" fill="{b}"/>' + eyes(38, 87, 0.55, "eyes e2")
            + f'<circle cx="90" cy="86" r="26" fill="{c}"/>' + eyes(90, 87, 0.55, "eyes e3")
        )
    raise ValueError(shape)


PERSONALITY = {}
for _n in ("coder", "scout", "rfc-akele", "scrum", "zach"):
    PERSONALITY[_n] = "hop"
for _n in ("main", "infra", "security", "rfc-doug"):
    PERSONALITY[_n] = "calm"
for _n in ("radar", "rfc-risk"):
    PERSONALITY[_n] = "scan"
for _n in ("rfc-dave",):
    PERSONALITY[_n] = "tidy"
for _n in ("voice", "rfc-ryan"):
    PERSONALITY[_n] = "chat"
for _t in TEAMS:
    PERSONALITY[f"{_t}-lead"] = "calm"
    PERSONALITY[f"{_t}-coder"] = "hop"
    PERSONALITY[f"{_t}-simplifier"] = "tidy"
    PERSONALITY[f"{_t}-reviewer"] = "scan"

MOUTH_Y = {"circle": 85, "diamond": 85, "blob": 87, "mountain": 94, "cluster": 85}

STATE_CSS = """
.tint,.dizzy,.dz,.bang{display:none}
.bn,.dz{transform-box:fill-box;transform-origin:center}
.st-active .b{animation:hop calc(var(--d)*.45) cubic-bezier(.3,.1,.3,1) var(--dl) infinite}
.st-idle .b{animation:breathe 5.5s ease-in-out var(--dl) infinite}
.st-idle .look,.st-idle .mouth,.st-idle .spin,.st-idle .sway,.st-idle .twinkle,.st-idle .swing,.st-idle .bounce{animation:none}
.st-idle .eyes{animation:none;transform:scaleY(.1)}
.st-idle .mouth{opacity:0}
.st-needs .look,.st-needs .mouth{animation:none}
.st-needs .eyes{animation:none;transform:scale(1.35)}
.st-needs .mouth{opacity:0}
.st-needs .b{animation:alert 1.1s ease-in-out infinite}
.st-needs .bang{display:inline}
.st-needs .bn{animation:bang .9s ease-in-out infinite}
.st-error .b{animation:woozy 3.2s ease-in-out infinite}
.st-error .look,.st-error .mouth{display:none}
.st-error .tint{display:inline;opacity:.5}
.st-error .dizzy,.st-error .dz{display:inline}
.st-error .dz{animation:dizzy 1.6s linear infinite}
.st-error .spin,.st-error .sway,.st-error .twinkle{animation:none}
@keyframes breathe{0%,100%{transform:scale(1.02,.97)}50%{transform:scale(.98,1.03) translateY(-1px)}}
@keyframes alert{0%,100%{transform:translateX(0)}15%{transform:translateX(-2px)}30%{transform:translateX(2px)}45%{transform:translateX(0)}}
@keyframes bang{0%,100%{transform:translateY(0) scale(1)}45%{transform:translateY(-4px) scale(1.1)}}
@keyframes woozy{0%,100%{transform:rotate(-4deg)}50%{transform:rotate(4deg) translateY(1px)}}
@keyframes dizzy{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
"""
BANG = (
    '<g transform="translate(105 9)"><g class="bang"><g class="bn"><circle r="11" fill="#ef4b4b" stroke="#fff" stroke-width="2.5"/>'
    '<rect x="-2" y="-7.5" width="4" height="9.5" rx="2" fill="#fff"/><circle cy="6.5" r="2.3" fill="#fff"/></g></g></g>'
)

CSS = """
.b,.sh,.look,.eyes,.mouth,.talk,.badge,.spin,.sway,.glow,.ping,.twinkle,.swing,.flutter,.bounce{transform-box:fill-box}
.b{transform-origin:50% 100%}
.sh{transform-origin:center}
.look,.eyes,.mouth,.talk,.badge,.spin,.twinkle,.bounce,.flutter{transform-origin:center}
.sway{transform-origin:50% 100%}
.swing{transform-origin:0 0}
.hop .b{animation:hop var(--d) cubic-bezier(.3,.1,.3,1) var(--dl) infinite}
.hop .sh{animation:shhop var(--d) ease-in-out var(--dl) infinite}
.calm .b{animation:calm calc(var(--d)*1.6) ease-in-out var(--dl) infinite}
.calm .sh{animation:shcalm calc(var(--d)*1.6) ease-in-out var(--dl) infinite}
.scan .b{animation:scan calc(var(--d)*1.1) ease-in-out var(--dl) infinite}
.scan .sh{animation:shcalm calc(var(--d)*1.1) ease-in-out var(--dl) infinite}
.tidy .b{animation:tidy calc(var(--d)*1.5) ease-in-out var(--dl) infinite}
.tidy .sh{animation:shcalm calc(var(--d)*1.5) ease-in-out var(--dl) infinite}
.chat .b{animation:chat calc(var(--d)*.55) ease-in-out var(--dl) infinite}
.chat .sh{animation:shcalm calc(var(--d)*.55) ease-in-out var(--dl) infinite}
.look{animation:look var(--e) ease-in-out var(--el) infinite}
.scan .look{animation:lookscan calc(var(--e)*.6) ease-in-out var(--el) infinite}
.eyes{animation:blink var(--e) ease-in-out var(--el) infinite}
.e2{animation-delay:calc(var(--el) - .12s)}
.e3{animation-delay:calc(var(--el) - .24s)}
.mouth{opacity:0;animation:smile var(--e) ease-in-out var(--el) infinite}
.talk{animation:talk .55s ease-in-out infinite}
.spin{animation:spin .22s linear infinite}
.sway{animation:sway 1.8s ease-in-out infinite}
.glow{animation:glow .9s ease-in-out infinite}
.ping{animation:glow 1.4s ease-in-out infinite}
.badge{animation:pulse 1.4s ease-in-out infinite}
.twinkle{animation:twinkle 2.2s ease-in-out infinite}
.swing{animation:swing 1.6s ease-in-out infinite}
.flutter{animation:flutter 2.4s ease-in-out infinite}
.bounce{animation:boing 1.2s ease-in-out infinite}
@keyframes hop{0%{transform:scale(1.08,.9)}12%{transform:scale(1.1,.88)}30%{transform:translateY(-14px) scale(.93,1.1)}46%{transform:translateY(0) scale(1.12,.86)}56%{transform:scale(.97,1.03)}66%,100%{transform:scale(1,1)}}
@keyframes shhop{0%{transform:scale(1.05)}30%{transform:scale(.7);opacity:.07}46%{transform:scale(1.12)}66%,100%{transform:scale(1)}}
@keyframes calm{0%,100%{transform:rotate(-3deg) scale(1.02,.98)}25%{transform:rotate(0) translateY(-3px) scale(.99,1.02)}50%{transform:rotate(3deg) scale(1.02,.98)}75%{transform:rotate(0) translateY(-3px) scale(.99,1.02)}}
@keyframes shcalm{0%,100%{transform:scale(1)}25%,75%{transform:scale(.92)}}
@keyframes scan{0%,100%{transform:rotate(-5deg) translateX(-3px)}50%{transform:rotate(5deg) translateX(3px)}}
@keyframes tidy{0%,60%,100%{transform:rotate(0) scale(1,1)}6%{transform:rotate(-9deg)}12%{transform:rotate(8deg)}18%{transform:rotate(-6deg)}24%{transform:rotate(4deg) translateY(-4px)}30%{transform:rotate(0)}}
@keyframes chat{0%,100%{transform:scale(1,1)}20%{transform:scale(1.07,.94)}45%{transform:scale(.97,1.04) translateY(-3px)}70%{transform:scale(1.03,.98)}}
@keyframes look{0%,14%{transform:translate(0,0)}20%,36%{transform:translate(-7px,-1px)}42%,58%{transform:translate(7px,-2px)}64%,76%{transform:translate(0,4px)}82%,100%{transform:translate(0,0)}}
@keyframes lookscan{0%,10%{transform:translate(-4px,0)}45%,55%{transform:translate(4px,0)}90%,100%{transform:translate(-4px,0)}}
@keyframes blink{0%,17%,23%,60%,64%,68%,80%,92%,100%{transform:scaleY(1)}19%{transform:scaleY(.1)}62%{transform:scaleY(.1)}66%{transform:scaleY(.1)}84%,90%{transform:scaleY(.5) translateY(2px)}}
@keyframes smile{0%,78%,94%,100%{opacity:0}82%,90%{opacity:1}}
@keyframes talk{0%,100%{transform:scaleY(.25)}25%{transform:scaleY(1)}50%{transform:scaleY(.4)}75%{transform:scaleY(.9)}}
@keyframes spin{0%,100%{transform:scaleX(1)}50%{transform:scaleX(.12)}}
@keyframes sway{0%,100%{transform:rotate(-12deg)}50%{transform:rotate(12deg)}}
@keyframes glow{0%,100%{opacity:1}50%{opacity:.25}}
@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.3)}}
@keyframes twinkle{0%,100%{transform:scale(.2) rotate(0);opacity:.2}50%{transform:scale(1.2) rotate(45deg);opacity:1}}
@keyframes swing{0%,100%{transform:rotate(-18deg)}50%{transform:rotate(18deg)}}
@keyframes flutter{0%,70%,100%{transform:rotate(0)}76%{transform:rotate(-14deg)}82%{transform:rotate(12deg)}88%{transform:rotate(-8deg)}94%{transform:rotate(4deg)}}
@keyframes boing{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-3px) scale(1.15)}}
"""


def mouth(name, shape):
    y = MOUTH_Y[shape]
    if name in ("voice",):
        return f'<ellipse class="talk" cx="64" cy="{y + 1}" rx="6.5" ry="5" fill="#fff"/>'
    return (
        f'<path class="mouth" d="M{57},{y} Q64,{y + 8} {71},{y}" stroke="#fff" '
        f'stroke-width="4" stroke-linecap="round" fill="none"/>'
    )


def svg(name, shape, color, badge):
    h = int(hashlib.md5(name.encode()).hexdigest(), 16)
    d = 2.6 + ((h >> 16) % 10) / 10        # body period
    dl = -(h % 30) / 10                     # desyncs the fleet
    e = 6.5 + ((h >> 24) % 30) / 10         # eye/mouth period
    el = -((h >> 8) % 60) / 10
    pers = PERSONALITY.get(name, "calm")
    badge_svg = (
        f'<circle class="badge" cx="100" cy="28" r="12" fill="{badge}"/>' if badge else ""
    )
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="2 -12 124 124" width="124" height="124" class="{pers}" style="--d:{d:.1f}s;--dl:{dl:.1f}s;--e:{e:.1f}s;--el:{el:.1f}s">
<style>{CSS}{STATE_CSS.lstrip(chr(10))}</style>
<g class="b">{body(shape, color)}{mouth(name, shape)}{accessory(name, shape)}</g>
{badge_svg}
{BANG}
</svg>
"""


def main():
    canon = HOME / "workspace/avatars/creatures"
    canon.mkdir(parents=True, exist_ok=True)
    for name, (shape, color, badge) in AGENTS.items():
        s = svg(name, shape, color, badge)
        (canon / f"{name}.svg").write_text(s)
        ws = HOME / ("workspace" if name == "main" else f"workspace-{name}")
        if ws.is_dir():
            (ws / "avatars").mkdir(exist_ok=True)
            (ws / "avatars" / f"{name}.svg").write_text(s)
    print(f"wrote {len(AGENTS)} creatures to {canon}")


if __name__ == "__main__":
    main()
